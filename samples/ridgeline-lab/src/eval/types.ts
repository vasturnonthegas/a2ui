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

/** Output variants graded separately with the same rubric and evidence scope. */
export type Variant = 'a2ui' | 'markdown';

export const VARIANTS: readonly Variant[] = ['a2ui', 'markdown'];

export type JudgeMode = 'offline' | 'live';
export type Verdict = 'PASS' | 'FAIL' | 'UNPROVEN';
export type Trust = 'trusted' | 'untrusted';

export interface Rubric {
  id: string;
  task: string;
  questions: Record<string, string>;
}

export interface QuestionAnswer {
  /** Probability that the answer is "yes", as returned by the judge or recorded in a fixture. */
  p: number;
  /** |2p - 1|; derived from `p`, never reported by the judge. */
  confidence: number;
  trust: Trust;
  verdict: Verdict;
}

export type BlockedReason =
  | 'MISSING_KEY'
  | 'MODEL_UNAVAILABLE'
  | 'REDACTION_DETECTED'
  | 'EVIDENCE_EMPTY'
  | 'EVIDENCE_TOO_LARGE'
  | 'REQUEST_TOO_LARGE'
  | 'RATE_UNVERIFIED'
  | 'BUDGET_EXHAUSTED'
  | 'INVALID_RUBRIC'
  | 'NO_FIXTURE'
  | 'FIXTURE_STALE'
  | 'NO_OUTPUT';

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface Grade {
  status: 'GRADED' | 'BLOCKED';
  blocked_reason?: BlockedReason;
  /** `fixture` grades are hand-authored canned values, never model output. */
  source: 'fixture' | 'live';
  model: string | null;
  usage: Usage | null;
  reserved_micro_usd: number;
  latency_ms: number;
  evidence_sha256: string;
  rubric_sha256: string;
  answers: Record<string, QuestionAnswer>;
  summary: GradeSummary;
  /** Safe, secret-free explanation for a blocked grade (for example an HTTP status). */
  detail?: string;
  /** Judge grades never gate the run; deterministic checks do. */
  advisory: true;
}

export interface GradeSummary {
  pass: number;
  fail: number;
  unproven: number;
  untrusted: number;
  /**
   * Wilson 95% interval on the PASS share. Questions are not independent samples, so treat
   * it as indicative only.
   */
  pass_interval: [number, number] | null;
}

export interface CheckResult {
  id: string;
  ok: boolean;
  /** Only failed `error` checks fail the run; `warning` checks are reported for review. */
  severity: 'error' | 'warning';
  detail: string;
}

export interface FactTrace {
  key: string;
  expected: string;
  found: boolean;
  /** Evidence line numbers (1-based) where the value appears. */
  lines: number[];
  /** Rendering component IDs for those lines (A2UI variant only). */
  components: string[];
  /** Same-kind tokens shown instead of the expected ID or date, when the value is missing. */
  conflicting: string[];
}
