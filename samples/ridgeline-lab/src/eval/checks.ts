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
 * Deterministic checks over visible evidence.
 *
 * These checks catch structural failures and traceable record values: invalid or missing
 * messages, empty output, expected fact values, record IDs and calendar dates that are not
 * in the scenario fixture, and fields that show a different ID or date than the fixture.
 * They do not verify free prose; the advisory judge covers that, with its uncertainty
 * reported.
 */

import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type {CheckResult, FactTrace, Variant} from './types.ts';

export interface EvidenceLineLike {
  text: string;
  componentId?: string;
}

export interface KnownValues {
  ids: Set<string>;
  dates: Set<string>;
}

export interface CheckInput {
  variant: Variant;
  lines: EvidenceLineLike[];
  facts: Record<string, string>;
  known: KnownValues;
  /** Errors from the lab's v1.0 message validator (A2UI variant). */
  messageErrors?: string[];
  /** Problems found while rendering evidence (A2UI variant). */
  renderDiagnostics?: string[];
  unreachable?: Record<string, string[]>;
  /** Set when generation failed, so no output exists to check. */
  generationError?: string;
}

export interface CheckOutput {
  checks: CheckResult[];
  facts: FactTrace[];
}

export interface DateToken {
  raw: string;
  /** ISO `YYYY-MM-DD`, or null when the text names a date that does not exist. */
  iso: string | null;
}

/** Uppercase prefixes that name standards or time zones rather than records. */
const NON_RECORD_PREFIXES = new Set(['ISO', 'UTC', 'GMT', 'RFC', 'ASTM', 'ANSI']);
/** `RFI-031`, `PL-118-B`, and multi-segment IDs such as `SRC-ADR-0042`. */
const ID_PATTERN = /\b([A-Z]{2,6})(?:-[A-Z]{2,6})*-\d{2,6}(?:-[A-Z0-9]{1,6})?\b/g;
const ID_SERIAL_SUFFIX = /-\d{2,6}(?:-[A-Z0-9]{1,6})?$/;

const MONTH_INDEX: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const MONTH_NAME =
  '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|' +
  'Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const ORDINAL = '(?:st|nd|rd|th)?';

type DateParts = [year: string, month: string, day: string];

function group(match: RegExpExecArray, index: number): string {
  return match[index] ?? '';
}

function monthNumber(name: string): string {
  return String(MONTH_INDEX[name.slice(0, 3).toLowerCase()] ?? 0);
}

const DATE_PATTERNS: Array<{pattern: RegExp; parts: (match: RegExpExecArray) => DateParts}> = [
  {
    pattern: /\b(\d{4})-(\d{2})-(\d{2})(?!\d)/g,
    parts: m => [group(m, 1), group(m, 2), group(m, 3)],
  },
  {
    pattern: new RegExp(`\\b${MONTH_NAME}\\.?\\s+(\\d{1,2})${ORDINAL},?\\s+(\\d{4})\\b`, 'gi'),
    parts: m => [group(m, 3), monthNumber(group(m, 1)), group(m, 2)],
  },
  {
    pattern: new RegExp(
      `\\b(\\d{1,2})${ORDINAL}\\s+(?:of\\s+)?${MONTH_NAME}\\.?,?\\s+(\\d{4})\\b`,
      'gi',
    ),
    parts: m => [group(m, 3), monthNumber(group(m, 2)), group(m, 1)],
  },
  {
    pattern: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g,
    parts: m => [group(m, 3), group(m, 1), group(m, 2)],
  },
];

/** Month-and-day mentions with no year, such as "December 1st"; used only for the fixture. */
const YEARLESS_PATTERNS: Array<{
  pattern: RegExp;
  parts: (match: RegExpExecArray) => [month: string, day: string];
}> = [
  {
    pattern: new RegExp(`\\b${MONTH_NAME}\\.?\\s+(\\d{1,2})${ORDINAL}\\b(?!,?\\s+\\d{4})`, 'gi'),
    parts: m => [monthNumber(group(m, 1)), group(m, 2)],
  },
  {
    pattern: new RegExp(
      `\\b(\\d{1,2})${ORDINAL}\\s+(?:of\\s+)?${MONTH_NAME}\\b(?!\\.?,?\\s+\\d{4})`,
      'gi',
    ),
    parts: m => [monthNumber(group(m, 2)), group(m, 1)],
  },
];

/** Extracts record-style IDs such as `RFI-031`, `PL-118-B`, or `SRC-ADR-0042`. */
export function extractIds(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(ID_PATTERN)) {
    if (!NON_RECORD_PREFIXES.has(group(match, 1))) found.push(match[0]);
  }
  return found;
}

/** Extracts dates that name a year. Output dates without a year are not checked. */
export function extractDates(text: string): DateToken[] {
  const found: DateToken[] = [];
  for (const {pattern, parts} of DATE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const [year, month, day] = parts(match);
      found.push({raw: match[0], iso: toIsoDate(Number(year), Number(month), Number(day))});
    }
  }
  return found;
}

function toIsoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Collects every ID and date that the scenario's own fixture, facts, and prompt make
 * available. A year-less mention such as "December 1st" counts as known for each year the
 * corpus already names, so `2026-12-01` traces to a 2026 transcript that says "the week of
 * December 1st".
 */
export function knownValues(source: {
  fixture: unknown;
  facts: Record<string, string>;
  prompt: string;
}): KnownValues {
  const corpus = [JSON.stringify(source.fixture), ...Object.values(source.facts), source.prompt];
  const text = corpus.join('\n');
  const dates = new Set(extractDates(text).flatMap(token => (token.iso ? [token.iso] : [])));
  const years = new Set([...dates].map(iso => Number(iso.slice(0, 4))));
  for (const {pattern, parts} of YEARLESS_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const [month, day] = parts(match);
      for (const year of years) {
        const iso = toIsoDate(year, Number(month), Number(day));
        if (iso) dates.add(iso);
      }
    }
  }
  return {ids: new Set(extractIds(text)), dates};
}

function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** `dueDate`, `due_date`, and `due-date` all become `due date`. */
function labelFor(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
}

/** The ISO date when `value` is exactly one date (`2026-12-04`, `Dec 4, 2026`), else null. */
function exactDate(value: string): string | null {
  const [token, ...rest] = extractDates(value);
  if (!token || rest.length || normalize(token.raw) !== normalize(value)) return null;
  return token.iso;
}

const NUMERIC_VALUE = /^[$€£]?[\d,]+(\.\d+)?$/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `line` shows the number `expected` as a whole number, so `9` does not match
 * `19`, `9.5`, `2029`, or the day in `Dec 9, 2026`. Thousands separators are optional on
 * both sides; the currency symbol and decimals are matched literally.
 */
function lineHasNumber(line: string, expected: string): boolean {
  const withoutDates = extractDates(line).reduce(
    (text, token) => text.split(token.raw).join(' '),
    line,
  );
  const stripSeparators = (text: string) => text.replace(/(\d),(?=\d)/g, '$1');
  const haystack = stripSeparators(normalize(withoutDates));
  const needle = stripSeparators(normalize(expected));
  return new RegExp(`(?<![\\d.])${escapeRegExp(needle)}(?!\\d|\\.\\d)`).test(haystack);
}

/** The five characters React escapes in rendered text. */
const HTML_TEXT_ESCAPES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
};

/**
 * The text a Markdown evidence line shows in the lab's Markdown panel. It runs the panel's
 * own parser (react-markdown with remark-gfm and raw HTML skipped) and unwraps every
 * element, so emphasis, strikethrough, and code spans read as their text: `**Roof**
 * *sheathing*` shows `Roof sheathing`. A backslash escape stays literal punctuation, so
 * `Roof \*sheathing\*` shows `Roof *sheathing*`. Leading indentation is dropped first so a
 * nested list item is not read as an indented code block.
 */
function visibleMarkdownLine(line: string): string {
  const html = renderToStaticMarkup(
    createElement(
      Markdown,
      {remarkPlugins: [remarkGfm], skipHtml: true, allowedElements: [], unwrapDisallowed: true},
      line.trimStart(),
    ),
  );
  return html.replace(/&(?:amp|lt|gt|quot|#x27);/g, entity => HTML_TEXT_ESCAPES[entity] ?? entity);
}

function lineHasValue(line: string, expected: string): boolean {
  if (NUMERIC_VALUE.test(expected.trim())) return lineHasNumber(line, expected);
  const haystack = normalize(line);
  const needle = normalize(expected);
  if (needle && haystack.includes(needle)) return true;
  const iso = exactDate(expected);
  if (iso) return extractDates(line).some(token => token.iso === iso);
  return false;
}

function traceFact(
  key: string,
  expected: string,
  lines: EvidenceLineLike[],
  factValues: Set<string>,
): FactTrace {
  const hits = lines.flatMap((line, index) => (lineHasValue(line.text, expected) ? [index] : []));
  const components = new Set<string>();
  for (const index of hits) {
    const id = lines[index]?.componentId;
    if (id) components.add(id);
  }
  const trace: FactTrace = {
    key,
    expected,
    found: hits.length > 0,
    lines: hits.map(index => index + 1),
    components: [...components],
    conflicting: [],
  };
  if (trace.found) return trace;

  // A missing ID is a field mismatch when another ID of the same type, which is not itself
  // an expected fact, is shown instead. A missing date is a mismatch when the line labeled
  // with the fact's key (or the line after it) shows a different date.
  const value = expected.trim();
  const [onlyId, ...otherIds] = extractIds(value);
  const isId = onlyId === value && otherIds.length === 0;
  const iso = exactDate(value);
  if (!isId && !iso) return trace;

  const label = labelFor(key);
  const prefix = value.replace(ID_SERIAL_SUFFIX, '-');
  const conflicting = new Set<string>();
  for (const [index, line] of lines.entries()) {
    if (isId) {
      for (const id of extractIds(line.text)) {
        if (id.startsWith(prefix) && !factValues.has(id)) conflicting.add(id);
      }
    } else if (normalize(line.text).includes(label)) {
      const nearby = `${line.text}\n${lines[index + 1]?.text ?? ''}`;
      for (const token of extractDates(nearby)) {
        if (token.iso !== iso) conflicting.add(token.raw);
      }
    }
  }
  trace.conflicting = [...conflicting].sort();
  return trace;
}

function result(
  id: string,
  problems: string[],
  okDetail: string,
  severity: CheckResult['severity'] = 'error',
): CheckResult {
  return problems.length
    ? {id, ok: false, severity, detail: problems.join('; ')}
    : {id, ok: true, severity, detail: okDetail};
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function runChecks(input: CheckInput): CheckOutput {
  if (input.generationError !== undefined) {
    const detail = `no output: ${input.generationError}`;
    return {checks: [{id: 'output-present', ok: false, severity: 'error', detail}], facts: []};
  }

  const checks: CheckResult[] = [];
  const visibleText = input.lines.map(line => line.text).join('\n');

  if (input.variant === 'a2ui') {
    checks.push(
      result('messages-valid', input.messageErrors ?? [], 'messages pass the lab v1.0 validator'),
      result(
        'render-clean',
        input.renderDiagnostics ?? [],
        'every reachable component rendered and every binding resolved',
      ),
      result(
        'no-unreachable-components',
        Object.values(input.unreachable ?? {}).flatMap(ids =>
          ids.length ? [`${ids.length} unreachable component(s): ${ids.join(', ')}`] : [],
        ),
        'every component is reachable from root',
        'warning',
      ),
    );
  }

  const visible = input.lines.filter(
    line => line.text.trim() && !/^\[surface \d+\]$/.test(line.text),
  );
  checks.push(
    result(
      'non-empty',
      visible.length ? [] : ['no visible text'],
      `${visible.length} visible line(s)`,
    ),
  );

  // Markdown evidence keeps its markup, so facts are matched against what each line shows.
  // The evidence itself is unchanged; only this comparison reads through the markup.
  const factLines =
    input.variant === 'markdown'
      ? input.lines.map(line => ({...line, text: visibleMarkdownLine(line.text)}))
      : input.lines;
  const factValues = new Set(Object.values(input.facts).map(value => value.trim()));
  const facts = Object.entries(input.facts).map(([key, expected]) =>
    traceFact(key, expected, factLines, factValues),
  );
  checks.push(
    result(
      'facts-present',
      facts.filter(fact => !fact.found).map(fact => `${fact.key} "${fact.expected}" not visible`),
      `${facts.length} fact value(s) traced to visible lines`,
    ),
    result(
      'record-field-mismatch',
      facts
        .filter(fact => fact.conflicting.length)
        .map(fact => {
          const shown = fact.conflicting.map(value => `"${value}"`).join(', ');
          return `${fact.key}: expected "${fact.expected}", shows ${shown}`;
        }),
      'no field shows a different ID or date than the fixture',
    ),
  );

  const unknownIds = unique(extractIds(visibleText).filter(id => !input.known.ids.has(id)));
  checks.push(
    result(
      'no-fabricated-ids',
      unknownIds.map(id => `${id} is not in the scenario fixture`),
      'every record ID is in the scenario fixture',
    ),
  );

  const dates = extractDates(visibleText);
  const invalid = unique(dates.filter(token => token.iso === null).map(token => token.raw));
  const unknownDates = unique(
    dates
      .filter(token => token.iso !== null && !input.known.dates.has(token.iso))
      .map(token => token.raw),
  );
  checks.push(
    result(
      'dates-valid',
      invalid.map(raw => `${raw} is not a real calendar date`),
      'every dated value is a real calendar date',
    ),
    result(
      'no-fabricated-dates',
      unknownDates.map(raw => `${raw} is not in the scenario fixture`),
      'every dated value is in the scenario fixture',
    ),
  );

  return {checks, facts};
}
