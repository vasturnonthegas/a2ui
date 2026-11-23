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
import {createServer, request, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {after, before, describe, it} from 'node:test';

import {ACTION_SPECS, ActionStaging, StagingFullError} from '../src/actions.ts';
import {createApiHandler} from '../src/server.ts';

describe('action specs', () => {
  const punch = ACTION_SPECS.get('proposePunch');
  const log = ACTION_SPECS.get('draftDailyLog');

  it('validates and normalizes punch proposals', () => {
    assert.ok(punch);
    assert.deepEqual(
      punch.parse({title: '  Nail pops ', description: 'Six pops.\nPatch.', priority: ['medium']}),
      {
        ok: true,
        arguments: {title: 'Nail pops', description: 'Six pops.\nPatch.', priority: 'medium'},
      },
    );
    assert.equal(punch.parse({title: 'T', description: 'D', priority: 'urgent'}).ok, false);
    assert.equal(punch.parse({title: 'T', description: 'D', priority: ['low', 'high']}).ok, false);
    assert.equal(punch.parse({title: '', description: 'D', priority: 'low'}).ok, false);
    assert.equal(punch.parse({title: 'a\nb', description: 'D', priority: 'low'}).ok, false);
    assert.equal(
      punch.parse({title: 'x'.repeat(121), description: 'D', priority: 'low'}).ok,
      false,
    );
    assert.equal(
      punch.parse({title: 'T', description: 'D', priority: 'low', projectId: 'PRJ-1'}).ok,
      false,
    );
  });

  it('validates daily log drafts', () => {
    assert.ok(log);
    assert.deepEqual(log.parse({logDate: '2026-11-23T00:00:00Z', notes: 'Snow.'}), {
      ok: true,
      arguments: {logDate: '2026-11-23', notes: 'Snow.'},
    });
    assert.equal(log.parse({logDate: '2026-02-30', notes: 'x'}).ok, false);
    assert.equal(log.parse({logDate: 'today', notes: 'x'}).ok, false);
    assert.equal(log.parse({logDate: '2026-11-23'}).ok, false);
  });
});

describe('ActionStaging', () => {
  it('issues opaque ids and tokens that resolve exactly once', () => {
    const staging = new ActionStaging();
    const staged = staging.stage('proposePunch', 'punch-proposal', {title: 'T'});
    assert.match(staged.id, /^stg_[A-Za-z0-9_-]{16}$/);
    assert.match(staged.token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(staged.token, staging.stage('proposePunch', 'punch-proposal', {}).token);
    const first = staging.resolve(staged.id, staged.token, 'confirmed');
    assert.deepEqual(first, {
      ok: true,
      status: 'confirmed',
      name: 'proposePunch',
      arguments: {title: 'T'},
    });
    assert.equal(staging.resolve(staged.id, staged.token, 'confirmed').ok, false);
    assert.equal(staging.resolve(staged.id, staged.token, 'cancelled').ok, false);
  });

  it('keeps the entry after a wrong token', () => {
    const staging = new ActionStaging();
    const staged = staging.stage('proposePunch', 'punch-proposal', {});
    const wrong = staging.resolve(staged.id, 'A'.repeat(43), 'confirmed');
    assert.deepEqual(wrong.ok ? null : wrong.code, 'forbidden');
    assert.equal(staging.resolve(staged.id, staged.token, 'cancelled').ok, true);
  });

  it('expires entries', () => {
    let now = 1_000;
    const staging = new ActionStaging({ttlMs: 100, now: () => now});
    const staged = staging.stage('proposePunch', 'punch-proposal', {});
    assert.equal(staged.expiresAt, new Date(1_100).toISOString());
    now = 1_100;
    const expired = staging.resolve(staged.id, staged.token, 'confirmed');
    assert.equal(expired.ok ? null : expired.code, 'expired');
    const gone = staging.resolve(staged.id, staged.token, 'confirmed');
    assert.equal(gone.ok ? null : gone.code, 'not_found');
  });

  it('caps pending entries', () => {
    const staging = new ActionStaging({maxPending: 2});
    staging.stage('proposePunch', 'p', {});
    staging.stage('proposePunch', 'p', {});
    assert.throws(() => staging.stage('proposePunch', 'p', {}), StagingFullError);
  });

  it('returns a copy of the arguments', () => {
    const staging = new ActionStaging();
    const staged = staging.stage('proposePunch', 'p', {title: 'T'});
    staged.arguments.title = 'changed';
    const resolved = staging.resolve(staged.id, staged.token, 'confirmed');
    assert.deepEqual(resolved.ok && resolved.arguments, {title: 'T'});
  });
});

describe('HTTP API', () => {
  let server: Server;
  let base: string;

  before(async () => {
    const api = createApiHandler();
    server = createServer((req, res) => {
      void api(req, res).then(handled => {
        if (!handled) res.writeHead(404).end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>(resolve => server.close(() => resolve())));

  async function post(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{status: number; json: Record<string, unknown>}> {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', ...headers},
      body: JSON.stringify(body),
    });
    return {status: response.status, json: (await response.json()) as Record<string, unknown>};
  }

  function punchEvent(context: Record<string, unknown>): unknown {
    return {
      version: '1.0',
      action: {
        name: 'proposePunch',
        surfaceId: 'punch-proposal',
        sourceComponentId: 'proposeButton',
        timestamp: new Date().toISOString(),
        context,
      },
    };
  }

  it('lists scenarios without fixtures, stubs, or rubrics', async () => {
    const response = await fetch(`${base}/api/scenarios`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {scenarios: Record<string, unknown>[]};
    assert.equal(body.scenarios.length, 6);
    for (const scenario of body.scenarios) {
      for (const key of Object.keys(scenario))
        assert.ok(['id', 'title', 'product', 'description', 'prompt', 'mobile'].includes(key), key);
    }
    assert.equal(body.scenarios.find(s => s.id === 'daily-log')?.mobile, true);
  });

  it('generates stub output and reports errors as JSON', async () => {
    const ok = await post('/api/generate', {scenarioId: 'rfi-triage', mode: 'stub'});
    assert.equal(ok.status, 200);
    assert.equal(ok.json.mode, 'stub');
    assert.ok(Array.isArray(ok.json.messages));
    const unknown = await post('/api/generate', {scenarioId: 'nope', mode: 'stub'});
    assert.equal(unknown.status, 404);
    assert.equal(typeof unknown.json.error, 'string');
    const badMode = await post('/api/generate', {scenarioId: 'rfi-triage', mode: 'replay'});
    assert.equal(badMode.status, 400);
  });

  it('stages, confirms once, and refuses replays', async () => {
    const staged = await post('/api/action', {
      scenarioId: 'punch-proposal',
      event: punchEvent({
        title: 'Nail pops',
        description: 'Six pops at the landing.',
        priority: ['high'],
      }),
    });
    assert.equal(staged.status, 200);
    assert.equal(staged.json.status, 'confirmation_required');
    const action = staged.json.action as {
      id: string;
      token: string;
      expiresAt: string;
      arguments: Record<string, unknown>;
    };
    assert.deepEqual(action.arguments, {
      title: 'Nail pops',
      description: 'Six pops at the landing.',
      priority: 'high',
    });
    assert.ok(Date.parse(action.expiresAt) > Date.now());

    const wrong = await post('/api/confirm', {id: action.id, token: 'B'.repeat(43)});
    assert.equal(wrong.status, 403);
    const confirmed = await post('/api/confirm', {id: action.id, token: action.token});
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.json.status, 'confirmed');
    assert.match(String(confirmed.json.message), /no record was written/);
    const replay = await post('/api/cancel', {id: action.id, token: action.token});
    assert.equal(replay.status, 404);
  });

  it('cancels a staged action', async () => {
    const staged = await post('/api/action', {
      scenarioId: 'punch-proposal',
      event: punchEvent({title: 'T', description: 'D', priority: 'low'}),
    });
    const action = staged.json.action as {id: string; token: string};
    const cancelled = await post('/api/cancel', action);
    assert.deepEqual(cancelled.json.status, 'cancelled');
  });

  it('drafts a daily log without staging anything', async () => {
    const drafted = await post('/api/action', {
      scenarioId: 'daily-log',
      event: {
        name: 'draftDailyLog',
        surfaceId: 'daily-log',
        sourceComponentId: 'draftButton',
        timestamp: new Date().toISOString(),
        context: {logDate: '2026-11-23', notes: 'Snow stopped work for an hour.'},
      },
    });
    assert.equal(drafted.status, 200);
    assert.equal(drafted.json.status, 'drafted');
    assert.equal(drafted.json.action, undefined);
  });

  it('rejects actions outside the allowlist or scenario, and bad fields', async () => {
    const wrongScenario = await post('/api/action', {
      scenarioId: 'daily-log',
      event: punchEvent({title: 'T', description: 'D', priority: 'low'}),
    });
    assert.equal(wrongScenario.status, 400);
    const event = punchEvent({}) as {action: Record<string, unknown>};
    event.action.name = 'deleteProject';
    const unknown = await post('/api/action', {scenarioId: 'punch-proposal', event});
    assert.equal(unknown.status, 400);
    const badField = await post('/api/action', {
      scenarioId: 'punch-proposal',
      event: punchEvent({title: 'T', description: 'D', priority: 'urgent'}),
    });
    assert.equal(badField.status, 422);
    const notAnEvent = await post('/api/action', {
      scenarioId: 'punch-proposal',
      event: {version: '1.0', error: {code: 'X', message: 'm', surfaceId: 's'}},
    });
    assert.equal(notAnEvent.status, 400);
  });

  it('rejects cross-origin writes, non-JSON bodies, and foreign hosts', async () => {
    const crossOrigin = await post(
      '/api/generate',
      {scenarioId: 'rfi-triage', mode: 'stub'},
      {Origin: 'https://evil.test'},
    );
    assert.equal(crossOrigin.status, 403);
    const text = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: {'Content-Type': 'text/plain'},
      body: '{}',
    });
    assert.equal(text.status, 415);
    const wrongMethod = await fetch(`${base}/api/generate`);
    assert.equal(wrongMethod.status, 405);

    const port = (server.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {host: '127.0.0.1', port, path: '/api/scenarios', headers: {Host: 'attacker.test'}},
        res => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 421);
  });
});
