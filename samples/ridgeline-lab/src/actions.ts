/**
 * Server-side action allowlist and mock staging for the Ridgeline lab.
 *
 * Generated surfaces may only emit the events listed in `ACTION_SPECS`, and only in the
 * scenario each event belongs to. Every argument is validated here; nothing the renderer
 * sends is trusted. Staged actions live in memory, are identified by a random opaque id and
 * token, expire, and resolve at most once. Resolving one never writes a record: this is a
 * synthetic demo.
 */

import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';

/** How a validated action is handled. */
export type ActionKind = 'confirm' | 'draft';

/** Allowlisted action names. */
export type ActionName = 'proposePunch' | 'draftDailyLog';

export interface ActionSpec {
  name: ActionName;
  /** The one scenario whose surface may emit this action. */
  scenarioId: string;
  kind: ActionKind;
  /** Exact set of context keys the event must carry. */
  contextKeys: readonly string[];
  /** How the form feeding this action should bind each context key, for the model. */
  promptHint: string;
  /** Validates and normalizes the resolved context, returning errors or arguments. */
  parse(context: Record<string, unknown>): ParseResult;
}

export type ParseResult =
  {ok: true; arguments: Record<string, unknown>} | {ok: false; errors: string[]};

export const PUNCH_PRIORITIES = ['low', 'medium', 'high'] as const;
export type PunchPriority = (typeof PUNCH_PRIORITIES)[number];

const TITLE_MAX = 120;
const DESCRIPTION_MAX = 2000;
const NOTES_MAX = 4000;
// Control characters other than tab, newline, and carriage return.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function cleanText(
  value: unknown,
  field: string,
  max: number,
  errors: string[],
  multiline: boolean,
): string | undefined {
  if (typeof value !== 'string') {
    errors.push(`${field} must be a string.`);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    errors.push(`${field} is required.`);
    return undefined;
  }
  if (trimmed.length > max) {
    errors.push(`${field} must be at most ${max} characters.`);
    return undefined;
  }
  if (CONTROL_CHARS.test(trimmed) || (!multiline && /[\r\n]/.test(trimmed))) {
    errors.push(`${field} contains disallowed characters.`);
    return undefined;
  }
  return trimmed;
}

/**
 * A mutually exclusive ChoicePicker binds a string list, so the renderer resolves the
 * priority to `["medium"]`. A plain string is accepted too.
 */
function parsePriority(value: unknown, errors: string[]): PunchPriority | undefined {
  const single = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (typeof single === 'string' && (PUNCH_PRIORITIES as readonly string[]).includes(single)) {
    return single as PunchPriority;
  }
  errors.push(`priority must be one of ${PUNCH_PRIORITIES.join(', ')}.`);
  return undefined;
}

/** Accepts `YYYY-MM-DD` or an ISO 8601 date-time from a DateTimeInput, returning the date. */
function parseLogDate(value: unknown, errors: string[]): string | undefined {
  const match =
    typeof value === 'string'
      ? /^(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(value)
      : null;
  if (match) {
    const [, y, m, d] = match;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    if (
      date.getUTCFullYear() === Number(y) &&
      date.getUTCMonth() === Number(m) - 1 &&
      date.getUTCDate() === Number(d)
    ) {
      return `${y}-${m}-${d}`;
    }
  }
  errors.push('logDate must be a calendar date in YYYY-MM-DD form.');
  return undefined;
}

function checkKeys(
  context: Record<string, unknown>,
  expected: readonly string[],
  errors: string[],
): void {
  const actual = Object.keys(context);
  const missing = expected.filter(key => !actual.includes(key));
  const extra = actual.filter(key => !expected.includes(key));
  if (missing.length > 0) errors.push(`Missing context field(s): ${missing.join(', ')}.`);
  if (extra.length > 0) errors.push(`Unexpected context field(s): ${extra.join(', ')}.`);
}

const proposePunch: ActionSpec = {
  name: 'proposePunch',
  scenarioId: 'punch-proposal',
  kind: 'confirm',
  contextKeys: ['title', 'description', 'priority'],
  promptHint:
    `title: a shortText TextField (at most ${TITLE_MAX} characters). description: a longText TextField. ` +
    `priority: a mutuallyExclusive ChoicePicker with option values ${PUNCH_PRIORITIES.join(', ')}, bound to a ` +
    'one-item string list such as ["medium"].',
  parse(context) {
    const errors: string[] = [];
    checkKeys(context, this.contextKeys, errors);
    const title = cleanText(context.title, 'title', TITLE_MAX, errors, false);
    const description = cleanText(
      context.description,
      'description',
      DESCRIPTION_MAX,
      errors,
      true,
    );
    const priority = parsePriority(context.priority, errors);
    if (errors.length > 0) return {ok: false, errors};
    return {ok: true, arguments: {title, description, priority}};
  },
};

const draftDailyLog: ActionSpec = {
  name: 'draftDailyLog',
  scenarioId: 'daily-log',
  kind: 'draft',
  contextKeys: ['logDate', 'notes'],
  promptHint:
    'logDate: a DateTimeInput with enableDate true, bound to a YYYY-MM-DD string. ' +
    `notes: a longText TextField (at most ${NOTES_MAX} characters).`,
  parse(context) {
    const errors: string[] = [];
    checkKeys(context, this.contextKeys, errors);
    const logDate = parseLogDate(context.logDate, errors);
    const notes = cleanText(context.notes, 'notes', NOTES_MAX, errors, true);
    if (errors.length > 0) return {ok: false, errors};
    return {ok: true, arguments: {logDate, notes}};
  },
};

export const ACTION_SPECS: ReadonlyMap<string, ActionSpec> = new Map<string, ActionSpec>([
  [proposePunch.name, proposePunch],
  [draftDailyLog.name, draftDailyLog],
]);

/** Action names a scenario's surface may emit. */
export function actionsForScenario(scenarioId: string): ActionSpec[] {
  return [...ACTION_SPECS.values()].filter(spec => spec.scenarioId === scenarioId);
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

export interface StagedAction {
  id: string;
  token: string;
  expiresAt: string;
  arguments: Record<string, unknown>;
}

export type Resolution = 'confirmed' | 'cancelled';

export type ResolveResult =
  | {ok: true; status: Resolution; name: ActionName; arguments: Record<string, unknown>}
  | {ok: false; code: 'not_found' | 'expired' | 'forbidden'; error: string};

interface PendingEntry {
  name: ActionName;
  scenarioId: string;
  tokenDigest: Buffer;
  expiresAtMs: number;
  arguments: Record<string, unknown>;
}

export interface StagingOptions {
  ttlMs?: number;
  maxPending?: number;
  now?: () => number;
}

const ID_PATTERN = /^stg_[A-Za-z0-9_-]{16}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function digest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export class StagingFullError extends Error {
  constructor() {
    super('Too many pending actions; confirm or cancel one first.');
    this.name = 'StagingFullError';
  }
}

/**
 * In-memory store for actions awaiting explicit user confirmation.
 *
 * Only a SHA-256 digest of each token is kept. Tokens are never logged or passed to the
 * model; the client holds them in ephemeral state.
 */
export class ActionStaging {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly ttlMs: number;
  private readonly maxPending: number;
  private readonly now: () => number;

  constructor(options: StagingOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    this.maxPending = options.maxPending ?? 100;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.pending.size;
  }

  stage(name: ActionName, scenarioId: string, args: Record<string, unknown>): StagedAction {
    this.prune();
    if (this.pending.size >= this.maxPending) throw new StagingFullError();
    const id = `stg_${randomBytes(12).toString('base64url')}`;
    const token = randomBytes(32).toString('base64url');
    const expiresAtMs = this.now() + this.ttlMs;
    const frozenArgs = Object.freeze({...args});
    this.pending.set(id, {
      name,
      scenarioId,
      tokenDigest: digest(token),
      expiresAtMs,
      arguments: frozenArgs,
    });
    return {id, token, expiresAt: new Date(expiresAtMs).toISOString(), arguments: {...frozenArgs}};
  }

  /** Resolves a staged action exactly once. A wrong token does not consume the entry. */
  resolve(id: unknown, token: unknown, status: Resolution): ResolveResult {
    if (
      typeof id !== 'string' ||
      !ID_PATTERN.test(id) ||
      typeof token !== 'string' ||
      !TOKEN_PATTERN.test(token)
    ) {
      return {ok: false, code: 'not_found', error: 'Unknown or already resolved action.'};
    }
    const entry = this.pending.get(id);
    if (!entry) return {ok: false, code: 'not_found', error: 'Unknown or already resolved action.'};
    if (this.now() >= entry.expiresAtMs) {
      this.pending.delete(id);
      return {ok: false, code: 'expired', error: 'This action expired. Submit the form again.'};
    }
    if (!timingSafeEqual(entry.tokenDigest, digest(token))) {
      return {ok: false, code: 'forbidden', error: 'Invalid confirmation token.'};
    }
    this.pending.delete(id);
    return {ok: true, status, name: entry.name, arguments: {...entry.arguments}};
  }

  private prune(): void {
    const now = this.now();
    for (const [id, entry] of this.pending) {
      if (now >= entry.expiresAtMs) this.pending.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Messages shown to the user
// ---------------------------------------------------------------------------

export function stagedMessage(spec: ActionSpec, args: Record<string, unknown>): string {
  if (spec.name === 'proposePunch') {
    return `Review punch item "${String(args.title)}" (${String(args.priority)} priority), then confirm or cancel. Nothing is saved until you confirm.`;
  }
  return `Review the ${spec.name} request, then confirm or cancel.`;
}

export function draftedMessage(spec: ActionSpec, args: Record<string, unknown>): string {
  if (spec.name === 'draftDailyLog') {
    const notes = String(args.notes);
    return `Drafted the daily log for ${String(args.logDate)} (${notes.length} characters of notes). Demo only: nothing was saved.`;
  }
  return `Drafted ${spec.name}. Demo only: nothing was saved.`;
}

export function resolvedMessage(
  name: ActionName,
  status: Resolution,
  args: Record<string, unknown>,
): string {
  if (status === 'cancelled') return 'Cancelled. Nothing was saved.';
  if (name === 'proposePunch') {
    return `Confirmed mock punch item "${String(args.title)}" (${String(args.priority)} priority). Demo only: no record was written.`;
  }
  return 'Confirmed. Demo only: no record was written.';
}
