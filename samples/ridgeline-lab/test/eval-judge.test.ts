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
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {
  createBudgetLedger,
  keyFingerprint,
  worstCaseReservationMicroUsd,
} from '../src/eval/budget.ts';
import type {BudgetLedger, ModelPrice} from '../src/eval/budget.ts';
import {
  createJudge,
  EVIDENCE_SCOPE,
  loadFixtures,
  loadPricing,
  MODEL,
  rubricHash,
  sha256,
  wilson,
} from '../src/eval/judge.ts';
import type {FixtureFile} from '../src/eval/judge.ts';
import type {Rubric} from '../src/eval/types.ts';

const API_KEY = 'tsk_test_0123456789abcdef';
const PRICE = loadPricing()[MODEL] as ModelPrice;
const rubric: Rubric = {
  id: 'rfi-triage',
  task: 'Triage an RFI for a site lead.',
  questions: {
    shows_id: 'Does the answer show the RFI ID?',
    shows_due: 'Does the answer show the due date?',
    names_owner: 'Does the answer name who owns the response?',
    offers_next_step: 'Does the answer offer a next step?',
  },
};
const evidence = 'RFI-0142 due Dec 4, 2026\n[button "Send"] (sends to agent)';
const request = {scenarioId: 'rfi-triage', variant: 'a2ui' as const, rubric, evidence};

interface FetchCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: () => Response) {
  const calls: FetchCall[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({url: String(url), init: init ?? {}});
    return respond();
  }) as typeof globalThis.fetch;
  return {calls, fetch};
}

function okResponse(answers: Record<string, number>, model = MODEL) {
  const body = {
    model,
    answers: Object.fromEntries(
      Object.entries(answers).map(([key, p]) => [key, {type: 'noul', noul: p}]),
    ),
    usage: {input_tokens: 812, output_tokens: 0},
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {'content-type': 'application/json'},
  });
}

function header(call: FetchCall | undefined, name: string): string | undefined {
  return (call?.init.headers as Record<string, string> | undefined)?.[name];
}

const mixed = {shows_id: 0.97, shows_due: 0.9, names_owner: 0.5, offers_next_step: 0.05};

let ledgerDir: string;
let budget: BudgetLedger;

beforeEach(async () => {
  ledgerDir = await mkdtemp(join(tmpdir(), 'ridgeline-lab-ledger-'));
  budget = createBudgetLedger({ledgerDir, now: () => new Date('2026-11-23T12:00:00Z')});
});

afterEach(async () => {
  await rm(ledgerDir, {recursive: true, force: true});
});

function liveJudge(env: Record<string, string>, fetch: typeof globalThis.fetch, ledger = budget) {
  return createJudge({mode: 'live', env, fetch, budget: ledger, pricing: {[MODEL]: PRICE}});
}

describe('budget ledger', () => {
  it('reserves 65,536 tokens at $0.042/M per call in a key-hash, UTC-day file', async () => {
    assert.equal(worstCaseReservationMicroUsd(PRICE), 2753);
    assert.deepEqual(await budget.reserve(API_KEY, PRICE), {
      decision: 'RESERVED',
      reservedMicroUsd: 2753,
    });
    assert.deepEqual(await budget.reserve(API_KEY, PRICE), {
      decision: 'RESERVED',
      reservedMicroUsd: 2753,
    });
    const fileName = `budget-${keyFingerprint(API_KEY)}-2026-11-23.json`;
    assert.match(fileName, /^budget-[0-9a-f]{12}-2026-11-23\.json$/);
    assert.deepEqual(await readdir(ledgerDir), [fileName]);
    const contents = await readFile(join(ledgerDir, fileName), 'utf8');
    assert.equal(contents, '{"reserved_micro_usd":5506}\n');
    assert.equal(contents.includes(API_KEY), false);
  });

  it('refuses a reservation that would pass the daily cap', async () => {
    const capped = createBudgetLedger({ledgerDir, limitMicroUsd: 5000});
    assert.equal((await capped.reserve(API_KEY, PRICE)).decision, 'RESERVED');
    assert.deepEqual(await capped.reserve(API_KEY, PRICE), {
      decision: 'BUDGET_EXHAUSTED',
      reservedMicroUsd: 0,
    });
  });

  it('starts a new ledger on the next UTC day', async () => {
    const nextDay = createBudgetLedger({ledgerDir, now: () => new Date('2026-11-24T00:00:01Z')});
    await budget.reserve(API_KEY, PRICE);
    await nextDay.reserve(API_KEY, PRICE);
    assert.equal((await readdir(ledgerDir)).length, 2);
  });

  it('reports unverified pricing without writing', async () => {
    assert.equal((await budget.reserve(API_KEY, undefined)).decision, 'RATE_UNVERIFIED');
    assert.deepEqual(await readdir(ledgerDir), []);
  });
});

describe('offline judge', () => {
  const noNetwork = (async () => {
    throw new Error('offline mode must not call the network');
  }) as typeof globalThis.fetch;

  it('ships a fixture file that parses', () => {
    assert.equal(Array.isArray(loadFixtures().grades), true);
  });

  it('blocks when no canned grade was recorded', async () => {
    const judge = createJudge({mode: 'offline', fixtures: {grades: []}, fetch: noNetwork});
    const grade = await judge.grade(request);
    assert.equal(grade.status, 'BLOCKED');
    assert.equal(grade.blocked_reason, 'NO_FIXTURE');
    assert.deepEqual(grade.answers, {});
  });

  it('applies canned grades only to the exact recorded evidence and rubric', async () => {
    const fixtures: FixtureFile = {
      grades: [
        {
          scenarioId: 'rfi-triage',
          variant: 'a2ui',
          rubric_sha256: rubricHash(rubric),
          evidence_sha256: sha256(evidence),
          answers: mixed,
        },
      ],
    };
    const judge = createJudge({mode: 'offline', fixtures, fetch: noNetwork});
    const grade = await judge.grade(request);
    assert.equal(grade.status, 'GRADED');
    assert.equal(grade.source, 'fixture');
    assert.equal(grade.model, 'canned-fixture');
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(grade.answers).map(([key, answer]) => [key, [answer.verdict, answer.trust]]),
      ),
      {
        shows_id: ['PASS', 'trusted'],
        shows_due: ['PASS', 'trusted'],
        names_owner: ['UNPROVEN', 'untrusted'],
        offers_next_step: ['FAIL', 'trusted'],
      },
    );
    assert.deepEqual(grade.summary, {
      pass: 2,
      fail: 1,
      unproven: 1,
      untrusted: 1,
      pass_interval: wilson(2, 4),
    });

    const changed = await judge.grade({...request, evidence: `${evidence}\nextra`});
    assert.equal(changed.blocked_reason, 'FIXTURE_STALE');
    const otherVariant = await judge.grade({...request, variant: 'markdown'});
    assert.equal(otherVariant.blocked_reason, 'NO_FIXTURE');
    const editedRubric = {...rubric, task: `${rubric.task} Today.`};
    assert.equal(
      (await judge.grade({...request, rubric: editedRubric})).blocked_reason,
      'FIXTURE_STALE',
    );
  });

  it('rejects rubrics outside 4-8 single questions', async () => {
    const judge = createJudge({mode: 'offline', fixtures: {grades: []}});
    const short = {...rubric, questions: {a: 'One?', b: 'Two?', c: 'Three?'}};
    const grade = await judge.grade({...request, rubric: short});
    assert.equal(grade.blocked_reason, 'INVALID_RUBRIC');
    assert.equal(grade.detail, 'rubric has 3 questions; expected 4-8');
    const compound = {
      ...rubric,
      questions: {...rubric.questions, shows_id: 'Does it show the ID? Is it bold?'},
    };
    const compoundGrade = await judge.grade({...request, rubric: compound});
    assert.equal(compoundGrade.detail, 'question shows_id asks more than one thing');
  });
});

describe('live judge', () => {
  it('blocks without a key and never reserves or calls', async () => {
    const {calls, fetch} = fakeFetch(() => okResponse(mixed));
    const grade = await liveJudge({}, fetch).grade(request);
    assert.equal(grade.blocked_reason, 'MISSING_KEY');
    assert.equal(calls.length, 0);
    assert.deepEqual(await readdir(ledgerDir), []);
  });

  it('sends one noul request to jev-1.14.0 and records usage and the reservation', async () => {
    const {calls, fetch} = fakeFetch(() => okResponse(mixed));
    const grade = await liveJudge({JEV_API_Key: API_KEY}, fetch).grade(request);
    assert.equal(grade.status, 'GRADED');
    assert.equal(grade.source, 'live');
    assert.equal(grade.model, MODEL);
    assert.deepEqual(grade.usage, {input_tokens: 812, output_tokens: 0});
    assert.equal(grade.reserved_micro_usd, 2753);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(header(calls[0], 'Authorization'), `Bearer ${API_KEY}`);
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      model: MODEL,
      state: {task: rubric.task, scope: EVIDENCE_SCOPE, evidence},
      questions: Object.fromEntries(
        Object.entries(rubric.questions).map(([key, q]) => [key, {type: 'noul', instructions: q}]),
      ),
    });
  });

  it('prefers TYPESAFE_API_KEY and honors TYPESAFE_BASE_URL', async () => {
    const {calls, fetch} = fakeFetch(() => okResponse(mixed));
    const env = {
      TYPESAFE_API_KEY: 'primary-key',
      JEV_API_Key: 'secondary-key',
      TYPESAFE_BASE_URL: 'http://127.0.0.1:9/',
    };
    await liveJudge(env, fetch).grade(request);
    assert.equal(calls[0]?.url, 'http://127.0.0.1:9/v1/systemone');
    assert.equal(header(calls[0], 'Authorization'), 'Bearer primary-key');
  });

  it('does not retry a failed call and keeps the reservation', async () => {
    const {calls, fetch} = fakeFetch(() => new Response('{"error":"busy"}', {status: 503}));
    const grade = await liveJudge({TYPESAFE_API_KEY: API_KEY}, fetch).grade(request);
    assert.equal(calls.length, 1);
    assert.equal(grade.blocked_reason, 'MODEL_UNAVAILABLE');
    assert.equal(grade.detail, 'HTTP 503');
    assert.equal(grade.reserved_micro_usd, 2753);
    assert.deepEqual(grade.answers, {});
  });

  it('refuses answers from any other model or with missing questions', async () => {
    const wrongModel = fakeFetch(() => okResponse(mixed, 'jev-1.15.0'));
    const grade = await liveJudge({TYPESAFE_API_KEY: API_KEY}, wrongModel.fetch).grade(request);
    assert.equal(grade.blocked_reason, 'MODEL_UNAVAILABLE');
    assert.equal(grade.detail, 'response model is not jev-1.14.0');
    assert.deepEqual(grade.answers, {});

    const partial = fakeFetch(() => okResponse({shows_id: 0.9}));
    const partialGrade = await liveJudge({TYPESAFE_API_KEY: API_KEY}, partial.fetch).grade(request);
    assert.equal(partialGrade.status, 'BLOCKED');
    assert.equal(partialGrade.detail, 'missing or invalid answer for shows_due');
  });

  it('does not call when the daily budget is spent', async () => {
    const {calls, fetch} = fakeFetch(() => okResponse(mixed));
    const spent = createBudgetLedger({ledgerDir, limitMicroUsd: 0});
    const grade = await liveJudge({TYPESAFE_API_KEY: API_KEY}, fetch, spent).grade(request);
    assert.equal(grade.blocked_reason, 'BUDGET_EXHAUSTED');
    assert.equal(calls.length, 0);
  });

  it('does not send empty evidence or evidence that looks like it holds a secret', async () => {
    const {calls, fetch} = fakeFetch(() => okResponse(mixed));
    const judge = liveJudge({TYPESAFE_API_KEY: API_KEY}, fetch);
    const empty = await judge.grade({...request, evidence: '  '});
    const leaked = await judge.grade({...request, evidence: 'key sk-abcdefghijklmnopqrstuvwxyz'});
    assert.equal(empty.blocked_reason, 'EVIDENCE_EMPTY');
    assert.equal(leaked.blocked_reason, 'REDACTION_DETECTED');
    assert.equal(calls.length, 0);
    assert.deepEqual(await readdir(ledgerDir), []);
  });
});
