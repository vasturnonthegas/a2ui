import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {generate, GenerationError, parseModelReply} from '../src/agent.ts';
import {FIREWORKS_MODEL} from '../src/llm.ts';
import {BASIC_CATALOG_ID} from '../src/protocol.ts';
import {findScenario, type Scenario} from '../src/scenarios.ts';

const scenario = findScenario('punch-proposal') as Scenario;
const goodReply = JSON.stringify({
  messages: scenario.stub.messages,
  markdown: scenario.stub.markdown,
});
// Valid envelope and catalog; the only defect is the missing "root" component.
const badReply = JSON.stringify({
  messages: [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'punch-proposal',
        catalogId: BASIC_CATALOG_ID,
        components: [{id: 'main', component: 'Text', text: 'x'}],
      },
    },
  ],
  markdown: 'ok',
});

interface Call {
  url: string;
  init: RequestInit;
  body: {model: string; max_tokens: number; messages: {role: string; content: string}[]};
}

/** A fetch double that answers with the queued assistant replies in order. */
function fakeFetch(replies: (string | Error)[]): {fetch: typeof fetch; calls: Call[]} {
  const calls: Call[] = [];
  const queue = [...replies];
  const fn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body))});
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected extra model call');
    if (next instanceof Error) throw next;
    return new Response(
      JSON.stringify({choices: [{message: {content: next}, finish_reason: 'stop'}]}),
      {
        status: 200,
        headers: {'Content-Type': 'application/json'},
      },
    );
  };
  return {fetch: fn as typeof fetch, calls};
}

describe('generate', () => {
  it('returns the validated stub without a model', async () => {
    const result = await generate(scenario, 'stub');
    assert.equal(result.mode, 'stub');
    assert.equal(result.model, null);
    assert.equal(result.repaired, false);
    assert.equal(result.markdown, scenario.stub.markdown);
    assert.deepEqual(result.messages, scenario.stub.messages);
  });

  it('fails live mode without an API key instead of substituting the stub', async () => {
    const {fetch, calls} = fakeFetch([goodReply]);
    await assert.rejects(generate(scenario, 'live', {apiKey: '', fetch}), (error: unknown) => {
      assert.ok(error instanceof GenerationError);
      assert.equal(error.status, 503);
      assert.match(error.message, /FIREWORKS_API_KEY/);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it('sends one bounded request and accepts valid output', async () => {
    const {fetch, calls} = fakeFetch([`<think>plan</think>\n\`\`\`json\n${goodReply}\n\`\`\``]);
    const result = await generate(scenario, 'live', {apiKey: 'test-key', fetch, timeoutMs: 5000});
    assert.equal(result.mode, 'live');
    assert.equal(result.model, FIREWORKS_MODEL);
    assert.equal(result.repaired, false);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.url, 'https://api.fireworks.ai/inference/v1/chat/completions');
    assert.equal(call.body.model, 'accounts/fireworks/models/deepseek-v4p1-flash-1017');
    assert.ok(call.body.max_tokens >= 4096);
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.equal((call.init.headers as Record<string, string>).Authorization, 'Bearer test-key');
    // The prompt carries the same fixture for both outputs.
    assert.match(call.body.messages[1]?.content ?? '', /WALK-0219/);
  });

  it('repairs bad output exactly once', async () => {
    const {fetch, calls} = fakeFetch([badReply, goodReply]);
    const result = await generate(scenario, 'live', {apiKey: 'k', fetch});
    assert.equal(result.repaired, true);
    assert.equal(calls.length, 2);
    const repairTurn = calls[1]?.body.messages.at(-1);
    assert.equal(repairTurn?.role, 'user');
    assert.match(repairTurn?.content ?? '', /rejected/);
    assert.match(repairTurn?.content ?? '', /root/);
    assert.equal(calls[1]?.body.messages.at(-2)?.role, 'assistant');
  });

  it('gives up after one failed repair', async () => {
    const {fetch, calls} = fakeFetch([badReply, 'not json at all', goodReply]);
    await assert.rejects(generate(scenario, 'live', {apiKey: 'k', fetch}), (error: unknown) => {
      assert.ok(error instanceof GenerationError);
      assert.equal(error.status, 502);
      assert.match(error.message, /after one repair attempt/);
      assert.ok(error.details.length > 0);
      return true;
    });
    assert.equal(calls.length, 2);
  });

  it('reports a timeout as a live-mode error', async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError');
    const {fetch} = fakeFetch([timeout as unknown as Error]);
    await assert.rejects(
      generate(scenario, 'live', {apiKey: 'k', fetch, timeoutMs: 5000}),
      (error: unknown) => {
        assert.ok(error instanceof GenerationError);
        assert.equal(error.status, 504);
        return true;
      },
    );
  });

  it('rejects disallowed actions from the model', async () => {
    const hostile = structuredClone(scenario.stub.messages) as {
      createSurface: {components: Record<string, unknown>[]};
    }[];
    const button = hostile[0]?.createSurface.components.find(c => c.id === 'proposeButton');
    assert.ok(button);
    button.action = {event: {name: 'deleteProject', context: {}}};
    const reply = JSON.stringify({messages: hostile, markdown: scenario.stub.markdown});
    const {fetch, calls} = fakeFetch([reply, reply]);
    await assert.rejects(generate(scenario, 'live', {apiKey: 'k', fetch}), GenerationError);
    assert.equal(calls.length, 2);
  });
});

describe('parseModelReply', () => {
  it('requires messages and markdown', () => {
    assert.equal(parseModelReply('{"messages": []}').ok, false);
    assert.equal(parseModelReply('[1, 2]').ok, false);
    assert.equal(parseModelReply('{"messages": [], "markdown": "x"}').ok, true);
  });
});
