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

/**
 * Checks the UI's boundary with the pinned @a2ui/web_core 0.14.0 renderer:
 * canonical "1.0" wires are adapted only on the way into MessageProcessor,
 * every scenario stub renders, and the form actions produce canonical events.
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {type ActionPayload, MessageProcessor, STRICT_VALIDATION} from '@a2ui/web_core';
import {basicCatalog} from '@a2ui/web_core/catalogs/basic/v1';

import {validateActionEvent} from '../src/protocol.ts';
import {findScenario, scenarios} from '../src/scenarios.ts';
import {toActionEvent, toRendererMessages} from '../src/ui/renderer-compat.ts';

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createProcessor(onAction: (payload: ActionPayload) => void = () => undefined) {
  return new MessageProcessor([basicCatalog], onAction, {
    version: 'v1.0',
    validationConfig: STRICT_VALIDATION,
  });
}

function surfaceIdOf(messages: readonly unknown[]): string {
  for (const message of messages) {
    if (isRecord(message) && isRecord(message.createSurface)) {
      return String(message.createSurface.surfaceId);
    }
  }
  throw new Error('no createSurface message');
}

function componentsOf(messages: readonly unknown[]): Json[] {
  const out: Json[] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    for (const key of ['createSurface', 'updateComponents']) {
      const body = message[key];
      if (isRecord(body) && Array.isArray(body.components))
        out.push(...(body.components as Json[]));
    }
  }
  return out;
}

describe('toRendererMessages', () => {
  it('rewrites only canonical "1.0" versions and never mutates its input', () => {
    const input = [
      {version: '1.0', deleteSurface: {surfaceId: 'a'}},
      {version: '0.9', deleteSurface: {surfaceId: 'b'}},
      'not a message',
    ];
    const snapshot = structuredClone(input);
    const output = toRendererMessages(input);
    assert.deepEqual(input, snapshot);
    assert.deepEqual(output, [
      {version: 'v1.0', deleteSurface: {surfaceId: 'a'}},
      {version: '0.9', deleteSurface: {surfaceId: 'b'}},
      'not a message',
    ]);
  });
});

describe('pinned renderer accepts every scenario stub', () => {
  it('rejects the raw canonical wire, which is why the shim exists', () => {
    const stub = findScenario('rfi-triage')?.stub.messages ?? [];
    assert.throws(() => createProcessor().processMessages(stub as never), /expected "v1\.0"/);
  });

  for (const scenario of scenarios) {
    it(`${scenario.id} renders under strict validation`, () => {
      const wire = scenario.stub.messages;
      const snapshot = structuredClone(wire);
      const processor = createProcessor();
      processor.processMessages(toRendererMessages(wire) as never);
      const surface = processor.getSurface(surfaceIdOf(wire));
      assert.ok(surface, 'surface created');
      assert.ok(surface.componentsModel.get('root'), 'root component present');
      assert.deepEqual(wire, snapshot, 'canonical wire left untouched');
      processor.dispose();
    });
  }
});

describe('form actions round-trip as canonical v1.0 events', () => {
  const cases = [
    {
      scenarioId: 'punch-proposal',
      name: 'proposePunch',
      fields: ['title', 'description', 'priority'],
    },
    {scenarioId: 'daily-log', name: 'draftDailyLog', fields: ['logDate', 'notes']},
  ];

  for (const {scenarioId, name, fields} of cases) {
    it(`${name} resolves its bound context and passes the server validator`, async () => {
      const wire = findScenario(scenarioId)?.stub.messages ?? [];
      const received: ActionPayload[] = [];
      const processor = createProcessor(payload => {
        received.push(payload);
      });
      processor.processMessages(toRendererMessages(wire) as never);
      const surface = processor.getSurface(surfaceIdOf(wire));
      assert.ok(surface);

      const button = componentsOf(wire).find(
        c => isRecord(c.action) && isRecord(c.action.event) && c.action.event.name === name,
      );
      assert.ok(button, `a component triggers ${name}`);
      const event = (button.action as {event: {context: Record<string, {'@path': string}>}}).event;
      assert.deepEqual(Object.keys(event.context).sort(), [...fields].sort());

      // Resolve each binding against the live data model, as the renderer does.
      const context: Json = {};
      for (const [key, binding] of Object.entries(event.context)) {
        context[key] = surface.dataModel.get(binding['@path']);
        assert.notEqual(context[key], undefined, `${key} is bound to seeded data`);
      }
      await surface.dispatchAction({event: {name, context}}, String(button.id));

      assert.equal(received.length, 1);
      const canonical = toActionEvent(received[0]!);
      assert.equal(canonical.version, '1.0');
      assert.ok(!('catalogId' in canonical.action));
      const verdict = validateActionEvent(canonical);
      assert.ok(verdict.ok, verdict.ok ? '' : verdict.errors.join('; '));
      processor.dispose();
    });
  }
});
