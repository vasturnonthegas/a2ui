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

/**
 * Redaction for anything the lab displays in its action log.
 *
 * Confirmation tokens live only in ephemeral component state. Any value under a
 * key that names a token is replaced before it reaches the log.
 */

export const REDACTED = '[redacted]';

const TOKEN_KEY = /token|secret|api[-_]?key/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = TOKEN_KEY.test(key) ? REDACTED : redact(entry);
    }
    return out;
  }
  return value;
}
