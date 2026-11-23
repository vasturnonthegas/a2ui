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
 * Per-key, per-UTC-day spending ledger for live judge calls.
 *
 * Every live call reserves its worst-case cost before the request is sent: the request
 * token bound times the input price, with output priced at zero. Reservations are
 * cumulative and never refunded, so the ledger is an upper bound on spend. The directory,
 * file name, file format, and lock protocol match the Ridgeline Jev harness, so both tools
 * share one $5 daily cap for the same key.
 */

import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, readFile, rename, stat, unlink, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

export interface ModelPrice {
  input_usd_per_million: string;
  output_usd_per_million: string;
  request_tokens_bound: number;
  source: string;
  verified_at_utc: string;
}

export type BudgetDecision = 'RESERVED' | 'RATE_UNVERIFIED' | 'BUDGET_EXHAUSTED';

export interface Reservation {
  decision: BudgetDecision;
  reservedMicroUsd: number;
}

export interface BudgetLedger {
  reserve(apiKey: string, price: ModelPrice | undefined): Promise<Reservation>;
}

export interface BudgetOptions {
  limitMicroUsd?: number;
  /** Defaults to `$JEV_LEDGER_DIR`, then `~/.ridgeline-jev`. */
  ledgerDir?: string;
  staleLockMs?: number;
  lockWaitMs?: number;
  now?: () => Date;
}

export const DAILY_LIMIT_MICRO_USD = 5_000_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const DEFAULT_LOCK_WAIT_MS = 35_000;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** Worst-case micro-USD for one request; 65,536 tokens at $0.042/M reserves 2,753. */
export function worstCaseReservationMicroUsd(price: ModelPrice): number {
  const rate = Number(price.input_usd_per_million);
  if (
    !Number.isFinite(rate) ||
    rate < 0 ||
    !Number.isSafeInteger(price.request_tokens_bound) ||
    price.request_tokens_bound < 0
  ) {
    throw new Error('invalid model pricing');
  }
  return Math.ceil(price.request_tokens_bound * rate);
}

/** First 12 hex characters of the key's SHA-256; the key itself is never written. */
export function keyFingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
}

export function ledgerFileName(apiKey: string, now: Date): string {
  return `budget-${keyFingerprint(apiKey)}-${now.toISOString().slice(0, 10)}.json`;
}

async function readReserved(ledgerPath: string): Promise<number> {
  let contents: string;
  try {
    contents = await readFile(ledgerPath, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return 0;
    throw error;
  }
  const parsed: unknown = JSON.parse(contents);
  const reserved =
    typeof parsed === 'object' && parsed !== null && 'reserved_micro_usd' in parsed
      ? parsed.reserved_micro_usd
      : undefined;
  if (typeof reserved !== 'number' || !Number.isSafeInteger(reserved) || reserved < 0) {
    throw new Error('invalid budget ledger');
  }
  return reserved;
}

export function createBudgetLedger(options: BudgetOptions = {}): BudgetLedger {
  const limitMicroUsd = options.limitMicroUsd ?? DAILY_LIMIT_MICRO_USD;
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  const now = options.now ?? (() => new Date());
  const ledgerDir =
    options.ledgerDir ?? process.env.JEV_LEDGER_DIR ?? join(homedir(), '.ridgeline-jev');

  return {
    async reserve(apiKey, price) {
      if (!price) return {decision: 'RATE_UNVERIFIED', reservedMicroUsd: 0};
      const reservation = worstCaseReservationMicroUsd(price);
      const ledgerPath = join(ledgerDir, ledgerFileName(apiKey, now()));
      await mkdir(ledgerDir, {recursive: true, mode: 0o700});

      return withLock<Reservation>(ledgerPath, staleLockMs, lockWaitMs, async () => {
        const reserved = await readReserved(ledgerPath);
        if (reserved + reservation > limitMicroUsd) {
          return {decision: 'BUDGET_EXHAUSTED', reservedMicroUsd: 0};
        }
        const next = `${JSON.stringify({reserved_micro_usd: reserved + reservation})}\n`;
        const temporaryPath = `${ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporaryPath, next, {flag: 'wx', mode: 0o600});
          await rename(temporaryPath, ledgerPath);
        } finally {
          await unlink(temporaryPath).catch(() => undefined);
        }
        return {decision: 'RESERVED', reservedMicroUsd: reservation};
      });
    },
  };
}

async function withLock<T>(
  ledgerPath: string,
  staleLockMs: number,
  lockWaitMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = `${ledgerPath}.lock`;
  const deadline = Date.now() + lockWaitMs;

  while (true) {
    let lockHandle;
    try {
      lockHandle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
      try {
        const existing = await stat(lockPath);
        if (Date.now() - existing.mtimeMs > staleLockMs) {
          const latest = await stat(lockPath);
          if (existing.ino === latest.ino && existing.dev === latest.dev) await unlink(lockPath);
        }
      } catch (statError) {
        if (!isErrno(statError, 'ENOENT')) throw statError;
      }
      if (Date.now() >= deadline) throw new Error('budget ledger lock timeout');
      await delay(10);
      continue;
    }

    try {
      await lockHandle.writeFile(`${process.pid}\n`);
      return await operation();
    } finally {
      await lockHandle.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }
}
