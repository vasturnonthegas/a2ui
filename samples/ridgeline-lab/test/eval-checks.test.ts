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
import {describe, it} from 'node:test';

import {extractDates, extractIds, knownValues, runChecks} from '../src/eval/checks.ts';
import type {CheckInput} from '../src/eval/checks.ts';

const FACTS = {rfiId: 'RFI-0142', dueDate: '2026-12-04'};
const known = knownValues({
  fixture: {
    rfi: {id: 'RFI-0142', due: '2026-12-04', spec: 'ISO-9001'},
    related: ['SUB-0031'],
    note: 'Walk the site the week of December 1st.',
  },
  facts: FACTS,
  prompt: 'Triage the open RFI.',
});

function check(lines: string[], overrides: Partial<CheckInput> = {}) {
  const output = runChecks({
    variant: 'markdown',
    lines: lines.map((text, index) => ({text, componentId: `c${index}`})),
    facts: FACTS,
    known,
    ...overrides,
  });
  const byId = new Map(output.checks.map(result => [result.id, result]));
  const detail = (id: string) => byId.get(id)?.detail;
  const ok = (id: string) => byId.get(id)?.ok;
  return {...output, byId, detail, ok};
}

describe('extractors', () => {
  it('finds record IDs, including multi-segment ones, and skips standards prefixes', () => {
    assert.deepEqual(extractIds('RFI-0142, PL-118-B, SRC-ADR-0042, ISO-9001, UTC-05, rfi-1'), [
      'RFI-0142',
      'PL-118-B',
      'SRC-ADR-0042',
    ]);
  });

  it('normalizes dated text that names a year and marks impossible dates', () => {
    const text = '2026-12-04, Dec 4, 2026, 4 December 2026, 12/04/2026, 2026-02-30';
    assert.deepEqual(
      extractDates(text).map(token => token.iso),
      ['2026-12-04', null, '2026-12-04', '2026-12-04', '2026-12-04'],
    );
  });

  it('treats a year-less fixture date as known for the years the fixture names', () => {
    assert.equal(known.dates.has('2026-12-01'), true);
    assert.equal(known.dates.has('2027-12-01'), false);
  });
});

describe('runChecks', () => {
  it('passes output whose IDs, dates, and facts all trace to the fixture', () => {
    const {checks, facts} = check(['RFI-0142: anchor spacing', 'Due Dec 4, 2026, walk 2026-12-01']);
    assert.deepEqual(
      checks.filter(result => !result.ok),
      [],
    );
    assert.deepEqual(facts, [
      {
        key: 'rfiId',
        expected: 'RFI-0142',
        found: true,
        lines: [1],
        components: ['c0'],
        conflicting: [],
      },
      {
        key: 'dueDate',
        expected: '2026-12-04',
        found: true,
        lines: [2],
        components: ['c1'],
        conflicting: [],
      },
    ]);
  });

  it('flags record IDs that are not in the fixture', () => {
    const {ok, detail} = check(['RFI-0142 and RFI-0143', 'Due 2026-12-04', 'Owner SUB-0031']);
    assert.equal(ok('no-fabricated-ids'), false);
    assert.equal(detail('no-fabricated-ids'), 'RFI-0143 is not in the scenario fixture');
  });

  it('flags impossible dates and dates that are not in the fixture', () => {
    const {ok, detail} = check([
      'RFI-0142',
      'Due 2026-12-04',
      'Inspected 2026-02-30',
      'Next visit Dec 9, 2026',
    ]);
    assert.equal(ok('dates-valid'), false);
    assert.equal(detail('dates-valid'), '2026-02-30 is not a real calendar date');
    assert.equal(ok('no-fabricated-dates'), false);
    assert.equal(detail('no-fabricated-dates'), 'Dec 9, 2026 is not in the scenario fixture');
  });

  it('reports a labeled field that shows a different date than the fixture', () => {
    const {ok, detail, facts} = check(['RFI-0142', 'Due date', 'Dec 5, 2026']);
    assert.equal(ok('facts-present'), false);
    assert.equal(ok('record-field-mismatch'), false);
    assert.equal(
      detail('record-field-mismatch'),
      'dueDate: expected "2026-12-04", shows "Dec 5, 2026"',
    );
    assert.deepEqual(facts[1]?.conflicting, ['Dec 5, 2026']);
  });

  it('reports a same-type ID shown in place of the expected one', () => {
    const {ok, detail} = check(['RFI-0143', 'Due 2026-12-04'], {
      known: {ids: new Set(['RFI-0142', 'RFI-0143']), dates: known.dates},
    });
    assert.equal(detail('record-field-mismatch'), 'rfiId: expected "RFI-0142", shows "RFI-0143"');
    assert.equal(ok('no-fabricated-ids'), true);
  });

  it('does not call another expected record a mismatch', () => {
    const {ok, detail} = check(['RFI-0150', 'Due 2026-12-04'], {
      facts: {...FACTS, otherId: 'RFI-0150'},
      known: {ids: new Set(['RFI-0142', 'RFI-0150']), dates: known.dates},
    });
    assert.equal(ok('facts-present'), false);
    assert.equal(ok('record-field-mismatch'), true);
    assert.equal(detail('facts-present'), 'rfiId "RFI-0142" not visible');
  });

  it('matches numeric facts only as whole numbers', () => {
    const found = (lines: string[], value: string) =>
      check(lines, {facts: {value}}).facts[0]?.found;

    assert.equal(found(['Crew on site: 9'], '9'), true);
    assert.equal(found(['9 crew, 3 subs'], '9'), true);
    assert.equal(found(['Crew on site: 19'], '9'), false);
    assert.equal(found(['Crew on site: 91'], '9'), false);
    assert.equal(found(['Crew on site: 9.5'], '9'), false);
    assert.equal(found(['Crew on site: 0.9'], '9'), false);
    assert.equal(found(['Target 2027-04-16', 'CO-007', 'RFI-037'], '7'), false);
    assert.equal(found(['Walk Dec 7, 2026', 'Due 12/7/2026'], '7'), false);

    assert.equal(found(['Threshold 5,000 rows'], '5,000'), true);
    assert.equal(found(['Threshold 5000 rows'], '5,000'), true);
    assert.equal(found(['Threshold 15,000 rows'], '5,000'), false);
    assert.equal(found(['Threshold 5,000,000 rows'], '5,000'), false);

    assert.equal(found(['Change order: $3,850.00.'], '$3,850.00'), true);
    assert.equal(found(['Change order: $3850.00'], '$3,850.00'), true);
    assert.equal(found(['Change order: $13,850.00'], '$3,850.00'), false);
    assert.equal(found(['Change order: 3,850.00'], '$3,850.00'), false);
  });

  it('matches Markdown facts against the text the panel shows, not its markup', () => {
    const trace = (lines: string[], value: string) => check(lines, {facts: {value}}).facts[0];

    // Separately emphasized words read as one visible phrase.
    assert.deepEqual(trace(['- **Roof** *sheathing* delivered'], 'Roof sheathing'), {
      key: 'value',
      expected: 'Roof sheathing',
      found: true,
      lines: [1],
      components: ['c0'],
      conflicting: [],
    });
    assert.equal(trace(['_Roof_ __sheathing__'], 'Roof sheathing')?.found, true);
    assert.equal(trace(['~~Roof~~ `sheathing`'], 'Roof sheathing')?.found, true);
    assert.equal(trace(['Crew on site: **9**'], '9')?.found, true);
    assert.equal(trace(['Due **Dec 4**, 2026'], '2026-12-04')?.found, true);

    // Escaped punctuation is literal text, not emphasis.
    assert.equal(trace(['Roof \\*sheathing\\*'], 'Roof sheathing')?.found, false);
    assert.equal(trace(['Roof \\*sheathing\\*'], 'Roof *sheathing*')?.found, true);
    assert.equal(trace(['Tom & Jerry\'s "A<B"'], 'Tom & Jerry\'s "A<B"')?.found, true);
  });

  it('fails empty output', () => {
    const {ok, detail} = check([], {facts: {}});
    assert.equal(ok('non-empty'), false);
    assert.equal(detail('non-empty'), 'no visible text');
  });

  it('reports a missing output as one failure without checking content', () => {
    const {checks} = check(['ignored'], {generationError: 'Error: model timed out'});
    assert.deepEqual(checks, [
      {
        id: 'output-present',
        ok: false,
        severity: 'error',
        detail: 'no output: Error: model timed out',
      },
    ]);
  });

  it('adds message, render, and reachability checks for the A2UI variant', () => {
    const {ok, byId} = check(['RFI-0142', 'Due 2026-12-04'], {
      variant: 'a2ui',
      messageErrors: ['messages[0]: missing version'],
      renderDiagnostics: ['surface main: no root component'],
      unreachable: {main: ['orphan']},
    });
    assert.equal(ok('messages-valid'), false);
    assert.equal(ok('render-clean'), false);
    assert.deepEqual(byId.get('no-unreachable-components'), {
      id: 'no-unreachable-components',
      ok: false,
      severity: 'warning',
      detail: '1 unreachable component(s): orphan',
    });
  });
});
