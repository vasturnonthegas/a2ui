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
 * Runs the evaluation: generate (or replay) each scenario, render visible evidence for
 * both variants, run deterministic checks, and ask the judge with the same frozen rubric
 * and evidence scope for each variant.
 */

import type {Scenario} from '../scenarios.ts';
import {knownValues, runChecks} from './checks.ts';
import type {EvidenceLineLike} from './checks.ts';
import {renderEvidence, renderMarkdownEvidence} from './evidence.ts';
import {EVIDENCE_SCOPE, hasSecret, MODEL, noOutputGrade, rubricProblems, sha256} from './judge.ts';
import type {Judge} from './judge.ts';
import type {CheckResult, FactTrace, Grade, Variant} from './types.ts';
import {VARIANTS} from './types.ts';

export interface GenerateOutput {
  messages: unknown[];
  markdown: string;
  mode: 'stub' | 'live';
  model: string | null;
  repaired: boolean;
}

export interface RunOptions {
  scenarios: Scenario[];
  generate: (scenario: Scenario, mode: 'stub' | 'live') => Promise<GenerateOutput>;
  /** The lab's v1.0 validator, applied with the scenario's surface ID and allowed actions. */
  validateMessages: (messages: unknown, scenario: Scenario) => string[];
  /** Omit to run deterministic checks only. */
  judge?: Judge;
  /** Generate with the live model; otherwise replay the recorded stub output. */
  liveGeneration: boolean;
  scenarioIds?: string[];
  variants?: Variant[];
  /** Input price used to estimate spend from reported usage. */
  inputUsdPerMillion?: number;
}

export interface VariantResult {
  variant: Variant;
  /** The exact text the judge saw (withheld if it looked like it held a secret). */
  evidence: string;
  evidence_sha256: string;
  checks: CheckResult[];
  facts: FactTrace[];
  grade: Grade | null;
}

export interface ScenarioResult {
  id: string;
  title: string;
  product: Scenario['product'];
  mobile: boolean;
  rubric_id: string;
  rubric_problems: string[];
  generation: {
    requested: 'stub' | 'live';
    mode: 'stub' | 'live' | null;
    model: string | null;
    repaired: boolean;
    message_count: number;
    error?: string;
  };
  variants: VariantResult[];
}

export interface EvalReport {
  kind: 'ridgeline-lab-eval';
  version: 1;
  generated_at?: string;
  generation: 'recorded-stub' | 'live';
  judge: 'offline-fixture' | 'live' | 'none';
  judge_model: string;
  evidence_scope: string;
  scenarios: ScenarioResult[];
  totals: {
    checks: {passed: number; failed: number; warnings: number};
    grades: {graded: number; blocked: Record<string, number>};
    usage: {input_tokens: number; output_tokens: number; calls: number};
    reserved_micro_usd: number;
    estimated_usd_from_usage: number;
  };
  /** True when no deterministic `error` check failed. Judge grades never change it. */
  ok: boolean;
}

export class UnknownScenarioError extends Error {}

const DEFAULT_INPUT_USD_PER_MILLION = 0.042;

function safeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : 'generation failed';
  return hasSecret(text)
    ? 'generation failed (message withheld: secret-like text)'
    : text.slice(0, 300);
}

interface VariantEvidence {
  evidence: string;
  lines: EvidenceLineLike[];
  messageErrors: string[];
  renderDiagnostics: string[];
  unreachable: Record<string, string[]>;
}

function variantEvidence(
  variant: Variant,
  output: GenerateOutput,
  scenario: Scenario,
  validateMessages: RunOptions['validateMessages'],
): VariantEvidence {
  if (variant === 'a2ui') {
    const rendered = renderEvidence(output.messages);
    return {
      evidence: rendered.text,
      lines: rendered.lines,
      messageErrors: validateMessages(output.messages, scenario),
      renderDiagnostics: rendered.diagnostics,
      unreachable: rendered.unreachable,
    };
  }
  const evidence = renderMarkdownEvidence(output.markdown);
  return {
    evidence,
    lines: evidence.split('\n').map(text => ({text})),
    messageErrors: [],
    renderDiagnostics: [],
    unreachable: {},
  };
}

function selectScenarios(options: RunOptions): Scenario[] {
  if (!options.scenarioIds?.length) return options.scenarios;
  return options.scenarioIds.map(id => {
    const scenario = options.scenarios.find(candidate => candidate.id === id);
    if (!scenario) throw new UnknownScenarioError(`unknown scenario: ${id}`);
    return scenario;
  });
}

async function evaluateScenario(scenario: Scenario, options: RunOptions): Promise<ScenarioResult> {
  const requested = options.liveGeneration ? 'live' : 'stub';
  let output: GenerateOutput | undefined;
  let generationError: string | undefined;
  try {
    output = await options.generate(scenario, requested);
    if (output.mode !== requested) {
      generationError = `requested ${requested} generation but the agent returned ${output.mode} output`;
    }
  } catch (error) {
    generationError = safeError(error);
  }
  const usable = generationError === undefined ? output : undefined;

  const known = knownValues(scenario);
  const problems = rubricProblems(scenario.rubric);
  const variants: VariantResult[] = [];
  for (const variant of options.variants?.length ? options.variants : VARIANTS) {
    const evidence = usable
      ? variantEvidence(variant, usable, scenario, options.validateMessages)
      : {evidence: '', lines: [], messageErrors: [], renderDiagnostics: [], unreachable: {}};
    const {checks, facts} = runChecks({
      variant,
      lines: evidence.lines,
      facts: scenario.facts,
      known,
      messageErrors: evidence.messageErrors,
      renderDiagnostics: evidence.renderDiagnostics,
      unreachable: evidence.unreachable,
      generationError: usable ? undefined : (generationError ?? 'no output'),
    });
    if (problems.length) {
      checks.push({id: 'rubric-frozen', ok: false, severity: 'error', detail: problems.join('; ')});
    }

    let grade: Grade | null = null;
    if (options.judge) {
      grade = usable
        ? await options.judge.grade({
            scenarioId: scenario.id,
            variant,
            rubric: scenario.rubric,
            evidence: evidence.evidence,
          })
        : noOutputGrade(options.judge.mode, scenario.rubric);
    }

    variants.push({
      variant,
      evidence: hasSecret(evidence.evidence)
        ? '[withheld: evidence contains secret-like text]'
        : evidence.evidence,
      evidence_sha256: sha256(evidence.evidence),
      checks,
      facts,
      grade,
    });
  }

  return {
    id: scenario.id,
    title: scenario.title,
    product: scenario.product,
    mobile: scenario.mobile === true,
    rubric_id: scenario.rubric.id,
    rubric_problems: problems,
    generation: {
      requested,
      mode: output?.mode ?? null,
      model: output?.model ?? null,
      repaired: output?.repaired ?? false,
      message_count: output?.messages.length ?? 0,
      ...(generationError ? {error: generationError} : {}),
    },
    variants,
  };
}

export async function runEval(options: RunOptions): Promise<EvalReport> {
  const results: ScenarioResult[] = [];
  // Sequential on purpose: live calls stay one at a time against the shared budget.
  for (const scenario of selectScenarios(options)) {
    results.push(await evaluateScenario(scenario, options));
  }
  return buildReport(results, options);
}

function buildReport(scenarios: ScenarioResult[], options: RunOptions): EvalReport {
  const variants = scenarios.flatMap(scenario => scenario.variants);
  const checks = variants.flatMap(variant => variant.checks);
  const grades = variants.flatMap(variant => (variant.grade ? [variant.grade] : []));
  const blocked: Record<string, number> = {};
  for (const grade of grades) {
    if (grade.status === 'BLOCKED' && grade.blocked_reason) {
      blocked[grade.blocked_reason] = (blocked[grade.blocked_reason] ?? 0) + 1;
    }
  }
  const inputTokens = grades.reduce((sum, grade) => sum + (grade.usage?.input_tokens ?? 0), 0);
  const outputTokens = grades.reduce((sum, grade) => sum + (grade.usage?.output_tokens ?? 0), 0);
  const failed = checks.filter(check => !check.ok && check.severity === 'error').length;
  const rate = options.inputUsdPerMillion ?? DEFAULT_INPUT_USD_PER_MILLION;
  let judge: EvalReport['judge'] = 'none';
  if (options.judge) judge = options.judge.mode === 'live' ? 'live' : 'offline-fixture';
  return {
    kind: 'ridgeline-lab-eval',
    version: 1,
    generation: options.liveGeneration ? 'live' : 'recorded-stub',
    judge,
    judge_model: MODEL,
    evidence_scope: EVIDENCE_SCOPE,
    scenarios,
    totals: {
      checks: {
        passed: checks.filter(check => check.ok).length,
        failed,
        warnings: checks.filter(check => !check.ok && check.severity === 'warning').length,
      },
      grades: {graded: grades.filter(grade => grade.status === 'GRADED').length, blocked},
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        // A call happened exactly when a reservation was made.
        calls: grades.filter(grade => grade.reserved_micro_usd > 0).length,
      },
      reserved_micro_usd: grades.reduce((sum, grade) => sum + grade.reserved_micro_usd, 0),
      estimated_usd_from_usage: (inputTokens * rate) / 1_000_000,
    },
    ok: failed === 0,
  };
}
