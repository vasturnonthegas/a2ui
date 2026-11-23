/*
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {parseArgs} from '../src/eval.ts';
import {createBudgetLedger} from '../src/eval/budget.ts';
import {BASIC_CATALOG_ID} from '../src/eval/evidence.ts';
import {createJudge, loadPricing, MODEL} from '../src/eval/judge.ts';
import type {FixtureFile} from '../src/eval/judge.ts';
import {toMarkdown, writeReports} from '../src/eval/report.ts';
import {runEval, UnknownScenarioError} from '../src/eval/run.ts';
import type {GenerateOutput, RunOptions, ScenarioResult} from '../src/eval/run.ts';
import type {Scenario} from '../src/scenarios.ts';

const API_KEY = 'tsk_live_do_not_log_0123456789';

const scenario: Scenario = {
  id: 'punch-proposal',
  title: 'Punch proposal',
  product: 'Ridgeline',
  description: 'Propose a punch item.',
  prompt: 'Propose a punch item for the lobby door.',
  fixture: {punch: {area: 'East stair', ref: 'PL-118', found: '2026-11-20'}},
  facts: {punchRef: 'PL-118', area: 'East stair'},
  rubric: {
    id: 'punch-proposal',
    task: 'Propose a punch item.',
    questions: {
      shows_ref: 'Does the answer show the punch reference?',
      shows_area: 'Does the answer show the area?',
      has_form: 'Can the user edit the title before sending?',
      has_send: 'Can the user send the proposal?',
    },
  },
  stub: {
    messages: [
      {
        version: '1.0',
        createSurface: {
          surfaceId: 'punch',
          catalogId: BASIC_CATALOG_ID,
          components: [
            {id: 'root', component: 'Column', children: ['ref', 'title', 'send']},
            {id: 'ref', component: 'Text', text: {'@path': '/punch/ref'}},
            {id: 'title', component: 'TextField', label: 'Title', value: {'@path': '/form/title'}},
            {id: 'sendLabel', component: 'Text', text: 'Propose'},
            {
              id: 'send',
              component: 'Button',
              child: 'sendLabel',
              action: {event: {name: 'proposePunch', context: {title: {'@path': '/form/title'}}}},
            },
          ],
          dataModel: {punch: {ref: 'PL-118'}, form: {title: 'Lobby door closer'}},
        },
      },
    ],
    markdown: '**PL-118** at East stair: lobby door closer (found 2026-11-20).\n<!-- PL-999 -->',
  },
};

const stubGenerate = async (input: Scenario, mode: 'stub' | 'live'): Promise<GenerateOutput> => ({
  messages: input.stub.messages,
  markdown: input.stub.markdown,
  mode,
  model: mode === 'live' ? 'fake-live-model' : null,
  repaired: false,
});

function options(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    scenarios: [scenario],
    generate: stubGenerate,
    validateMessages: () => [],
    liveGeneration: false,
    ...overrides,
  };
}

function only(results: ScenarioResult[]): ScenarioResult {
  const [result, ...rest] = results;
  assert.ok(result);
  assert.equal(rest.length, 0);
  return result;
}

function variantOf(result: ScenarioResult, variant: 'a2ui' | 'markdown') {
  const found = result.variants.find(candidate => candidate.variant === variant);
  assert.ok(found);
  return found;
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ridgeline-lab-eval-'));
});
afterEach(async () => {
  await rm(dir, {recursive: true, force: true});
});

describe('runEval', () => {
  it('checks both variants and reports a fact missing from one of them', async () => {
    const report = await runEval(options());
    assert.equal(report.judge, 'none');
    const result = only(report.scenarios);
    assert.deepEqual(
      result.variants.map(variant => variant.variant),
      ['a2ui', 'markdown'],
    );
    const a2ui = variantOf(result, 'a2ui');
    const markdown = variantOf(result, 'markdown');
    // The A2UI surface shows the reference and the form but never names the area.
    assert.deepEqual(
      a2ui.checks.filter(check => !check.ok).map(check => check.id),
      ['facts-present'],
    );
    assert.equal(
      a2ui.evidence,
      [
        '  PL-118',
        '  [input "Title"] value: "Lobby door closer"',
        '  [button "Propose"] (sends to agent) submits: Title',
      ].join('\n'),
    );
    // The HTML comment's PL-999 never renders, so it never reaches the checks.
    assert.deepEqual(
      markdown.checks.filter(check => !check.ok),
      [],
    );
    assert.equal(
      markdown.evidence,
      '**PL-118** at East stair: lobby door closer (found 2026-11-20).',
    );
    assert.equal(report.ok, false);
    assert.equal(report.totals.checks.failed, 1);
  });

  it('keeps table cells the Markdown panel drops out of the evidence and checks', async () => {
    // The pipe inside the broken link splits the cell, so the panel renders
    // `[Read](https://example.com/a` and `b)` and drops `Never rendered`.
    const markdown = [
      '| Note | Fact |',
      '| --- | --- |',
      '| [Read](https://example.com/a|b) | Never rendered |',
      '| PL-118 | East stair |',
    ].join('\n');
    const tableScenario: Scenario = {
      ...scenario,
      facts: {...scenario.facts, hidden: 'Never rendered'},
      stub: {...scenario.stub, markdown},
    };
    const report = await runEval(options({scenarios: [tableScenario], variants: ['markdown']}));
    const result = variantOf(only(report.scenarios), 'markdown');

    assert.equal(
      result.evidence,
      [
        '| Note | Fact |',
        '| --- | --- |',
        '| \\[Read\\]\\(https://example.com/a | b\\) |',
        '| PL-118 | East stair |',
      ].join('\n'),
    );
    assert.deepEqual(
      result.facts.map(fact => [fact.key, fact.found, fact.lines]),
      [
        ['punchRef', true, [4]],
        ['area', true, [4]],
        ['hidden', false, []],
      ],
    );
    assert.deepEqual(
      result.checks.filter(check => !check.ok).map(check => [check.id, check.detail]),
      [['facts-present', 'hidden "Never rendered" not visible']],
    );
  });

  it('grades offline only from canned fixtures recorded against the same evidence', async () => {
    const recorded = await runEval(
      options({judge: createJudge({mode: 'offline', fixtures: {grades: []}})}),
    );
    const markdown = variantOf(only(recorded.scenarios), 'markdown');
    assert.equal(markdown.grade?.blocked_reason, 'NO_FIXTURE');
    const fixtures: FixtureFile = {
      grades: [
        {
          scenarioId: scenario.id,
          variant: 'markdown',
          rubric_sha256: markdown.grade?.rubric_sha256 ?? '',
          evidence_sha256: markdown.evidence_sha256,
          answers: {shows_ref: 0.95, shows_area: 0.9, has_form: 0.1, has_send: 0.1},
        },
      ],
    };
    const report = await runEval(options({judge: createJudge({mode: 'offline', fixtures})}));
    const result = only(report.scenarios);
    assert.equal(variantOf(result, 'a2ui').grade?.blocked_reason, 'NO_FIXTURE');
    assert.equal(variantOf(result, 'markdown').grade?.status, 'GRADED');
    assert.deepEqual(report.totals.grades, {graded: 1, blocked: {NO_FIXTURE: 1}});
    assert.equal(report.totals.usage.calls, 0);
  });

  it('never reports stub output as live generation', async () => {
    const report = await runEval(
      options({
        generate: async input => stubGenerate(input, 'stub'),
        liveGeneration: true,
        judge: createJudge({mode: 'offline', fixtures: {grades: []}}),
      }),
    );
    const result = only(report.scenarios);
    assert.equal(
      result.generation.error,
      'requested live generation but the agent returned stub output',
    );
    const a2ui = variantOf(result, 'a2ui');
    assert.deepEqual(
      a2ui.checks.map(check => check.id),
      ['output-present'],
    );
    assert.equal(a2ui.grade?.blocked_reason, 'NO_OUTPUT');
    assert.equal(report.ok, false);
  });

  it('withholds generation errors that look like they contain a secret', async () => {
    const report = await runEval(
      options({
        generate: async () => {
          throw new Error('401 for key sk-abcdefghijklmnopqrstuvwx');
        },
        liveGeneration: true,
      }),
    );
    assert.equal(
      only(report.scenarios).generation.error,
      'generation failed (message withheld: secret-like text)',
    );
  });

  it('rejects unknown scenario IDs', async () => {
    await assert.rejects(runEval(options({scenarioIds: ['nope']})), UnknownScenarioError);
  });

  it('writes JSON and Markdown reports without the API key', async () => {
    const answers = {shows_ref: 0.9, shows_area: 0.4, has_form: 0.9, has_send: 0.9};
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          model: MODEL,
          answers: Object.fromEntries(
            Object.entries(answers).map(([key, p]) => [key, {type: 'noul', noul: p}]),
          ),
          usage: {input_tokens: 700, output_tokens: 0},
        }),
        {status: 200},
      )) as typeof globalThis.fetch;
    const judge = createJudge({
      mode: 'live',
      env: {TYPESAFE_API_KEY: API_KEY},
      fetch,
      budget: createBudgetLedger({ledgerDir: join(dir, 'ledger')}),
      pricing: loadPricing(),
    });
    const report = await runEval(options({judge}));
    assert.equal(report.judge, 'live');
    assert.equal(report.totals.usage.calls, 2);
    assert.equal(report.totals.usage.input_tokens, 1400);
    assert.equal(report.totals.reserved_micro_usd, 5506);

    const reports = join(dir, 'reports');
    const {jsonPath, markdownPath} = await writeReports(report, reports, 'eval-test');
    assert.deepEqual((await readdir(reports)).sort(), ['eval-test.json', 'eval-test.md']);
    const json = await readFile(jsonPath, 'utf8');
    const markdown = await readFile(markdownPath, 'utf8');
    assert.equal(json.includes(API_KEY), false);
    assert.equal(markdown.includes(API_KEY), false);
    assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(report)));
    assert.match(
      markdown,
      /\| punch-proposal \| Ridgeline \| no \| FAIL \(facts-present\) \| 3P\/0F\/1U, 1 untrusted/,
    );
    assert.equal(markdown, toMarkdown(report));
  });

  it('adds no ignore rules to an existing --out directory', async () => {
    await writeFile(join(dir, 'notes.txt'), 'keep\n');
    await writeReports(await runEval(options()), dir, 'eval-test');
    assert.deepEqual((await readdir(dir)).sort(), ['eval-test.json', 'eval-test.md', 'notes.txt']);
    assert.equal(await readFile(join(dir, 'notes.txt'), 'utf8'), 'keep\n');
  });
});

describe('parseArgs', () => {
  it('accepts the documented flags', () => {
    const parsed = parseArgs([
      '--live',
      '--judge-only',
      '--scenario',
      'rfi-triage,daily-log',
      '--scenario=decision-card',
      '--variant',
      'markdown',
      '--out',
      '/tmp/r',
    ]);
    assert.deepEqual(parsed, {
      help: false,
      live: true,
      judgeOnly: true,
      checksOnly: false,
      printEvidence: false,
      scenarioIds: ['rfi-triage', 'daily-log', 'decision-card'],
      variants: ['markdown'],
      outDir: '/tmp/r',
    });
  });

  it('rejects unknown flags, bad variants, missing values, and conflicting modes', () => {
    assert.throws(() => parseArgs(['--fast']), /unknown argument/);
    assert.throws(() => parseArgs(['--variant', 'html']), /unknown variant/);
    assert.throws(() => parseArgs(['--scenario']), /missing value/);
    assert.throws(() => parseArgs(['--judge-only', '--checks-only']), /mutually exclusive/);
  });
});
