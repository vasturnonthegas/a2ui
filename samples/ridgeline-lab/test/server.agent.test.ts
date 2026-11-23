/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {describe, it} from 'node:test';

import {
  buildSystemPrompt,
  buildUserPrompt,
  generate,
  GenerationError,
  parseModelReply,
} from '../src/agent.ts';
import {FIREWORKS_MODEL} from '../src/llm.ts';
import {BASIC_CATALOG_ID} from '../src/protocol.ts';
import {findScenario, type Scenario} from '../src/scenarios.ts';
import {createApiHandler} from '../src/server.ts';

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

describe('punch-proposal prompt grounding', () => {
  it('shows the model every checked fact value verbatim', async () => {
    const {fetch, calls} = fakeFetch([goodReply]);
    await generate(scenario, 'live', {apiKey: 'k', fetch});
    const userTurn = calls[0]?.body.messages[1]?.content ?? '';
    assert.equal(userTurn, buildUserPrompt(scenario));
    for (const [key, value] of Object.entries(scenario.facts)) {
      assert.ok(userTurn.includes(value), `${key} "${value}" is not in the model prompt`);
    }
  });

  it('marks the proposed punch item authoritative for both formats', () => {
    const userTurn = buildUserPrompt(scenario);
    assert.match(userTurn, /proposedPunchItem is authoritative/);
    assert.match(userTurn, /both the UI and the Markdown/);
    assert.match(userTurn, /exactly as written/);
    assert.match(userTurn, /never say the punch item was created or saved/);
  });

  it('keeps the editable confirm action in the system prompt', () => {
    const system = buildSystemPrompt(scenario);
    assert.match(system, /"name": "proposePunch"/);
    assert.match(system, /context keys must be exactly title, description, priority/);
    assert.match(system, /nothing is saved until the user confirms/);
  });
});

describe('daily-log prompt matches action dispatch', () => {
  const dailyLog = findScenario('daily-log') as Scenario;

  async function dispatchDraft(): Promise<{status: number; json: Record<string, unknown>}> {
    const api = createApiHandler();
    const server = createServer((req, res) => {
      void api(req, res).then(handled => {
        if (!handled) res.writeHead(404).end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/action`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            scenarioId: 'daily-log',
            event: {
              version: '1.0',
              action: {
                name: 'draftDailyLog',
                surfaceId: 'daily-log',
                sourceComponentId: 'draftButton',
                timestamp: new Date().toISOString(),
                context: {logDate: '2026-11-23', notes: 'Snow stopped work for an hour.'},
              },
            },
          }),
        },
      );
      return {status: response.status, json: (await response.json()) as Record<string, unknown>};
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  it('drafts immediately, so the Markdown rule never promises a confirmation', async () => {
    const drafted = await dispatchDraft();
    assert.equal(drafted.status, 200);
    assert.equal(drafted.json.status, 'drafted');
    assert.equal(drafted.json.action, undefined);

    const system = buildSystemPrompt(dailyLog);
    assert.match(system, /"name": "draftDailyLog"/);
    assert.doesNotMatch(system, /until the user confirms/);
    assert.match(system, /submit to draft\. Do not mention a confirmation step/);
  });

  it('keeps the confirm-once wording for the punch proposal', () => {
    const system = buildSystemPrompt(scenario);
    assert.match(system, /nothing is saved until the user confirms/);
    assert.doesNotMatch(system, /Do not mention a confirmation step/);
  });
});

describe('parseModelReply', () => {
  it('requires messages and markdown', () => {
    assert.equal(parseModelReply('{"messages": []}').ok, false);
    assert.equal(parseModelReply('[1, 2]').ok, false);
    assert.equal(parseModelReply('{"messages": [], "markdown": "x"}').ok, true);
  });
});
