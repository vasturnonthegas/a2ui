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

import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import type {EvalReport, ScenarioResult, VariantResult} from './run.ts';

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function row(cells: string[]): string {
  return `| ${cells.map(escapeCell).join(' | ')} |`;
}

function checkCell(variant: VariantResult | undefined): string {
  if (!variant) return 'n/a';
  const failed = variant.checks.filter(check => !check.ok && check.severity === 'error');
  const warned = variant.checks.filter(check => !check.ok && check.severity === 'warning');
  if (failed.length) return `FAIL (${failed.map(check => check.id).join(', ')})`;
  return warned.length ? `pass, ${warned.length} warning(s)` : 'pass';
}

function gradeCell(variant: VariantResult | undefined): string {
  const grade = variant?.grade;
  if (!grade) return 'not judged';
  if (grade.status === 'BLOCKED') return `BLOCKED: ${grade.blocked_reason ?? 'unknown'}`;
  const {pass, fail, unproven, untrusted, pass_interval} = grade.summary;
  const interval = pass_interval ? ` [${pass_interval[0]}-${pass_interval[1]}]` : '';
  return `${pass}P/${fail}F/${unproven}U, ${untrusted} untrusted${interval} (${grade.source})`;
}

function variantSection(variant: VariantResult): string[] {
  const out = [
    '',
    `#### ${variant.variant}`,
    '',
    `Evidence SHA-256: \`${variant.evidence_sha256}\``,
  ];
  out.push('', '| Check | Result | Detail |', '| --- | --- | --- |');
  for (const check of variant.checks) {
    const status = check.ok ? 'pass' : check.severity === 'error' ? 'FAIL' : 'warn';
    out.push(row([check.id, status, check.detail]));
  }
  if (variant.facts.length) {
    out.push('', '| Fact | Expected | Visible at | Conflicting |', '| --- | --- | --- | --- |');
    for (const fact of variant.facts) {
      const components = fact.components.length ? ` (${fact.components.join(', ')})` : '';
      const where = fact.found ? `line ${fact.lines.join(', ')}${components}` : 'missing';
      out.push(row([fact.key, fact.expected, where, fact.conflicting.join(', ') || '-']));
    }
  }
  const grade = variant.grade;
  if (grade) {
    const detail = grade.detail ? `; ${grade.detail}` : '';
    out.push('', `Judge: ${gradeCell(variant)}; model ${grade.model ?? 'none'}${detail}.`);
    if (grade.usage) {
      const {input_tokens, output_tokens} = grade.usage;
      out.push(
        `Usage: ${input_tokens} input / ${output_tokens} output tokens, ${grade.latency_ms} ms.`,
      );
    }
    const answers = Object.entries(grade.answers);
    if (answers.length) {
      out.push(
        '',
        '| Question | p(yes) | Confidence | Trust | Verdict |',
        '| --- | --- | --- | --- | --- |',
      );
      for (const [key, answer] of answers) {
        const {p, confidence, trust, verdict} = answer;
        out.push(row([key, p.toFixed(3), confidence.toFixed(3), trust, verdict]));
      }
    }
  }
  if (variant.evidence) {
    out.push('', '<details><summary>Judge evidence</summary>', '', '~~~~text', variant.evidence);
    out.push('~~~~', '', '</details>');
  }
  return out;
}

function scenarioSection(scenario: ScenarioResult): string[] {
  const gen = scenario.generation;
  const out = [
    `### ${scenario.id}: ${scenario.title}`,
    '',
    `Generation: requested ${gen.requested}, got ${gen.mode ?? 'nothing'}; ` +
      `model ${gen.model ?? 'none'}; ${gen.message_count} message(s); repaired ${gen.repaired}.`,
  ];
  if (gen.error) out.push('', `Generation error: ${gen.error}`);
  if (scenario.rubric_problems.length) {
    out.push('', `Rubric problems: ${scenario.rubric_problems.join('; ')}`);
  }
  for (const variant of scenario.variants) out.push(...variantSection(variant));
  return out;
}

export function toMarkdown(report: EvalReport): string {
  const {checks, usage, reserved_micro_usd, estimated_usd_from_usage, grades} = report.totals;
  const generated = report.generated_at ? ` Generated ${report.generated_at}.` : '';
  const result = report.ok
    ? 'all deterministic checks passed'
    : `${checks.failed} deterministic check(s) failed`;
  const lines = [
    '# Ridgeline Lab evaluation',
    '',
    `Generation: ${report.generation}. Judge: ${report.judge} (${report.judge_model}).${generated}`,
    '',
    `Result: ${result}.`,
    '',
    'Deterministic checks gate the run. Judge grades are advisory: a `fixture` grade is a',
    'hand-authored canned value for recorded data, and a `live` grade is one jev-1.14.0 call',
    'with no retries. Neither proves that free prose is correct.',
    '',
    '| Scenario | Product | Mobile | A2UI checks | A2UI judge | Markdown checks | Markdown judge |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const scenario of report.scenarios) {
    const a2ui = scenario.variants.find(variant => variant.variant === 'a2ui');
    const markdown = scenario.variants.find(variant => variant.variant === 'markdown');
    lines.push(
      row([
        scenario.id,
        scenario.product,
        scenario.mobile ? 'yes' : 'no',
        checkCell(a2ui),
        gradeCell(a2ui),
        checkCell(markdown),
        gradeCell(markdown),
      ]),
    );
  }
  const blocked =
    Object.entries(grades.blocked)
      .map(([reason, count]) => `${reason} ${count}`)
      .join(', ') || 'none';
  const reserved = (reserved_micro_usd / 1_000_000).toFixed(6);
  lines.push(
    '',
    `Judge calls: ${usage.calls}; tokens ${usage.input_tokens} in / ${usage.output_tokens} out; ` +
      `reserved $${reserved}; estimated $${estimated_usd_from_usage.toFixed(6)} from reported usage.`,
    `Graded: ${grades.graded}. Blocked: ${blocked}.`,
    '',
    '## Scenarios',
    '',
  );
  for (const scenario of report.scenarios) lines.push(...scenarioSection(scenario), '');
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Writes `<name>.json` and `<name>.md` into `dir` and touches nothing else there. The
 * default `reports/` directory is ignored by the lab's tracked `.gitignore`; a custom
 * `--out` directory keeps whatever ignore rules it already has.
 */
export async function writeReports(
  report: EvalReport,
  dir: string,
  name: string,
): Promise<{jsonPath: string; markdownPath: string}> {
  await mkdir(dir, {recursive: true});
  const jsonPath = join(dir, `${name}.json`);
  const markdownPath = join(dir, `${name}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownPath, toMarkdown(report));
  return {jsonPath, markdownPath};
}
