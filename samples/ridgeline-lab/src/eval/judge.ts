/**
 * Advisory rubric judge.
 *
 * Live mode sends one `noul` (yes-probability) question per rubric item through the
 * published TypeSafe SDK's `systemOne` call with the exact `jev-1.14.0` model, after
 * reserving the request's worst-case cost in the shared daily ledger. It makes one attempt
 * and never retries. Offline mode returns hand-authored canned grades, and only for the
 * exact evidence and rubric they were recorded against; anything else is reported as
 * BLOCKED rather than graded.
 */

import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

import {APIError, APITimeoutError, noul, TypeSafeClient} from '@typesafe-ai/sdk';

import {createBudgetLedger} from './budget.ts';
import type {BudgetLedger, ModelPrice} from './budget.ts';
import type {
  BlockedReason,
  Grade,
  GradeSummary,
  JudgeMode,
  QuestionAnswer,
  Rubric,
  Usage,
  Variant,
} from './types.ts';

export const MODEL = 'jev-1.14.0';
export const MIN_QUESTIONS = 4;
export const MAX_QUESTIONS = 8;
export const MAX_EVIDENCE_CHARS = 20_000;
export const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const FIXTURE_MODEL = 'canned-fixture';

/**
 * Fixed evidence scope, identical for both variants. It is hashed with the rubric, so
 * changing it invalidates recorded grades.
 */
export const EVIDENCE_SCOPE =
  'The evidence is only what a user can see: rendered text, input labels and current ' +
  'values, choice options, and buttons. Bracketed tags such as [input "Title"] or ' +
  '[button "Send"] describe a control. A button marked "(sends to agent)" submits the ' +
  'listed inputs. Items shown side by side share one line, separated by " | ". Nothing ' +
  'hidden from the user is included. Answer each question from this evidence alone; if ' +
  'the evidence does not show it, the answer is no.';

const UNTRUSTED_BELOW = 0.5;
const PASS_AT = 0.8;
const FAIL_AT = 0.2;
const DEFAULT_TIMEOUT_MS = 60_000;
const SECRET_PATTERNS = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{24,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bfw_[A-Za-z0-9]{20,}/,
];

export interface FixtureGrade {
  scenarioId: string;
  variant: Variant;
  rubric_sha256: string;
  evidence_sha256: string;
  /** Hand-authored p(yes) per question key. */
  answers: Record<string, number>;
  note?: string;
}

export interface FixtureFile {
  about?: string;
  grades: FixtureGrade[];
}

export interface GradeRequest {
  scenarioId: string;
  variant: Variant;
  rubric: Rubric;
  evidence: string;
}

export interface JudgeOptions {
  mode: JudgeMode;
  fixtures?: FixtureFile;
  /** Defaults to `process.env`; read for `TYPESAFE_API_KEY`, `JEV_API_Key`, and the base URL. */
  env?: Record<string, string | undefined>;
  /** Transport for the TypeSafe client; tests pass a fake. */
  fetch?: typeof fetch;
  budget?: BudgetLedger;
  pricing?: Record<string, ModelPrice | undefined>;
  timeoutMs?: number;
}

export interface Judge {
  mode: JudgeMode;
  grade(request: GradeRequest): Promise<Grade>;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Hash of everything the judge is asked besides the evidence. */
export function rubricHash(rubric: Rubric): string {
  const {id, task, questions} = rubric;
  return sha256(JSON.stringify({id, task, questions, scope: EVIDENCE_SCOPE, model: MODEL}));
}

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')) as T;
}

export function loadPricing(): Record<string, ModelPrice | undefined> {
  return readJson('./pricing.json');
}

export function loadFixtures(): FixtureFile {
  return readJson('./offline-grades.json');
}

/** Rubrics must hold 4-8 single, non-empty questions so both variants share one frozen set. */
export function rubricProblems(rubric: Rubric): string[] {
  const problems: string[] = [];
  if (typeof rubric.id !== 'string' || !rubric.id) problems.push('rubric id is missing');
  if (typeof rubric.task !== 'string' || !rubric.task.trim()) {
    problems.push('rubric task is missing');
  }
  const entries = Object.entries(rubric.questions ?? {});
  if (entries.length < MIN_QUESTIONS || entries.length > MAX_QUESTIONS) {
    problems.push(
      `rubric has ${entries.length} questions; expected ${MIN_QUESTIONS}-${MAX_QUESTIONS}`,
    );
  }
  for (const [key, question] of entries) {
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      problems.push(`question key ${key} is not a simple identifier`);
    }
    if (typeof question !== 'string' || !question.trim()) {
      problems.push(`question ${key} is empty`);
    } else if ((question.match(/\?/g) ?? []).length > 1) {
      problems.push(`question ${key} asks more than one thing`);
    }
  }
  return problems;
}

export function makeAnswer(p: number): QuestionAnswer {
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new RangeError('probability must be between 0 and 1');
  }
  const confidence = Math.abs(2 * p - 1);
  return {
    p,
    confidence,
    trust: confidence < UNTRUSTED_BELOW ? 'untrusted' : 'trusted',
    verdict: p >= PASS_AT ? 'PASS' : p <= FAIL_AT ? 'FAIL' : 'UNPROVEN',
  };
}

/** Wilson score interval at 95%, rounded to three places. */
export function wilson(successes: number, total: number): [number, number] | null {
  if (total === 0) return null;
  const z = 1.959964;
  const phat = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (phat + (z * z) / (2 * total)) / denominator;
  const spread = Math.sqrt((phat * (1 - phat)) / total + (z * z) / (4 * total * total));
  const margin = (z * spread) / denominator;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return [round(Math.max(0, center - margin)), round(Math.min(1, center + margin))];
}

export function summarize(answers: Record<string, QuestionAnswer>): GradeSummary {
  const values = Object.values(answers);
  const pass = values.filter(answer => answer.verdict === 'PASS').length;
  const fail = values.filter(answer => answer.verdict === 'FAIL').length;
  return {
    pass,
    fail,
    unproven: values.length - pass - fail,
    untrusted: values.filter(answer => answer.trust === 'untrusted').length,
    pass_interval: wilson(pass, values.length),
  };
}

/** True when text looks like it holds a credential; such text is never sent or reported. */
export function hasSecret(text: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(text));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function readNoul(value: unknown): number | undefined {
  const record = asRecord(value);
  return record.type === 'noul' && typeof record.noul === 'number' ? record.noul : undefined;
}

function readUsage(value: unknown): Usage | null {
  const {input_tokens, output_tokens} = asRecord(value);
  return typeof input_tokens === 'number' && typeof output_tokens === 'number'
    ? {input_tokens, output_tokens}
    : null;
}

/** The grade reported when there is no output to judge; no fixture or model is consulted. */
export function noOutputGrade(mode: JudgeMode, rubric: Rubric): Grade {
  return {
    status: 'BLOCKED',
    blocked_reason: 'NO_OUTPUT',
    source: mode === 'live' ? 'live' : 'fixture',
    model: null,
    usage: null,
    reserved_micro_usd: 0,
    latency_ms: 0,
    evidence_sha256: sha256(''),
    rubric_sha256: rubricHash(rubric),
    answers: {},
    summary: summarize({}),
    advisory: true,
  };
}

export function createJudge(options: JudgeOptions): Judge {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    mode: options.mode,

    async grade({scenarioId, variant, rubric, evidence}) {
      const base: Grade = {
        ...noOutputGrade(options.mode, rubric),
        evidence_sha256: sha256(evidence),
      };
      delete base.blocked_reason;
      const blocked = (reason: BlockedReason, extra: Partial<Grade> = {}): Grade => ({
        ...base,
        ...extra,
        blocked_reason: reason,
      });
      const graded = (answers: Record<string, QuestionAnswer>, extra: Partial<Grade>): Grade => ({
        ...base,
        ...extra,
        status: 'GRADED',
        answers,
        summary: summarize(answers),
      });

      const problems = rubricProblems(rubric);
      if (problems.length) return blocked('INVALID_RUBRIC', {detail: problems.join('; ')});
      if (!evidence.trim()) return blocked('EVIDENCE_EMPTY');
      if (evidence.length > MAX_EVIDENCE_CHARS) return blocked('EVIDENCE_TOO_LARGE');
      if (hasSecret(`${rubric.task}\n${evidence}`)) return blocked('REDACTION_DETECTED');

      if (options.mode === 'offline') {
        const fixture = options.fixtures?.grades.find(
          grade => grade.scenarioId === scenarioId && grade.variant === variant,
        );
        if (!fixture) return blocked('NO_FIXTURE');
        if (
          fixture.evidence_sha256 !== base.evidence_sha256 ||
          fixture.rubric_sha256 !== base.rubric_sha256
        ) {
          return blocked('FIXTURE_STALE', {
            detail: 'recorded evidence or rubric hash differs from this run',
          });
        }
        const answers: Record<string, QuestionAnswer> = {};
        for (const key of Object.keys(rubric.questions)) {
          const p = fixture.answers[key];
          if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
            return blocked('FIXTURE_STALE', {
              detail: `recorded grade for ${key} is missing or invalid`,
            });
          }
          answers[key] = makeAnswer(p);
        }
        return graded(answers, {model: FIXTURE_MODEL});
      }

      const apiKey = env.TYPESAFE_API_KEY || env.JEV_API_Key;
      if (!apiKey) return blocked('MISSING_KEY');
      const price = (options.pricing ?? loadPricing())[MODEL];
      if (!price) return blocked('RATE_UNVERIFIED');

      const request = {
        model: MODEL,
        state: {task: rubric.task, scope: EVIDENCE_SCOPE, evidence},
        questions: Object.fromEntries(
          Object.entries(rubric.questions).map(([key, question]) => [key, noul(question)]),
        ),
      };
      // About three characters per token; refuse anything that could pass the reserved bound.
      if (Math.ceil(JSON.stringify(request).length / 3) > price.request_tokens_bound) {
        return blocked('REQUEST_TOO_LARGE');
      }

      let reservedMicroUsd: number;
      try {
        const reservation = await (options.budget ?? createBudgetLedger()).reserve(apiKey, price);
        if (reservation.decision !== 'RESERVED') return blocked(reservation.decision);
        reservedMicroUsd = reservation.reservedMicroUsd;
      } catch {
        return blocked('BUDGET_EXHAUSTED', {detail: 'budget ledger unavailable'});
      }

      const started = performance.now();
      const elapsed = () => Math.round(performance.now() - started);
      let payload: unknown;
      try {
        const client = new TypeSafeClient({
          apiKey,
          baseURL: env.TYPESAFE_BASE_URL || DEFAULT_BASE_URL,
          // One attempt only: a retry would spend without a reservation of its own.
          retry: {maxRetries: 0},
          // The SDK's debug logs include request bodies; keep them off.
          logLevel: 'off',
          timeout: timeoutMs,
          ...(options.fetch ? {fetch: options.fetch} : {}),
        });
        payload = await client.systemOne(request);
      } catch (error) {
        let detail = 'connection or parse error';
        if (error instanceof APIError) detail = `HTTP ${error.status}`;
        else if (error instanceof APITimeoutError) detail = 'timeout';
        return blocked('MODEL_UNAVAILABLE', {
          reserved_micro_usd: reservedMicroUsd,
          latency_ms: elapsed(),
          detail,
        });
      }

      const record = asRecord(payload);
      const meta: Partial<Grade> = {
        model: typeof record.model === 'string' ? record.model : null,
        usage: readUsage(record.usage),
        reserved_micro_usd: reservedMicroUsd,
        latency_ms: elapsed(),
      };
      if (record.model !== MODEL) {
        return blocked('MODEL_UNAVAILABLE', {...meta, detail: `response model is not ${MODEL}`});
      }

      const rawAnswers = asRecord(record.answers);
      const answers: Record<string, QuestionAnswer> = {};
      for (const key of Object.keys(rubric.questions)) {
        const p = readNoul(rawAnswers[key]);
        if (p === undefined || !Number.isFinite(p) || p < 0 || p > 1) {
          return blocked('MODEL_UNAVAILABLE', {
            ...meta,
            detail: `missing or invalid answer for ${key}`,
          });
        }
        answers[key] = makeAnswer(p);
      }
      return graded(answers, meta);
    },
  };
}
