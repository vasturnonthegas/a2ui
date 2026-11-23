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
