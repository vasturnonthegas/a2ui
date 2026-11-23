/**
 * Minimal Fireworks chat-completions client for live generation.
 *
 * The API key is read from `FIREWORKS_API_KEY` and only ever sent in the Authorization
 * header to the fixed Fireworks endpoint. Requests are bounded by a timeout.
 */

export const FIREWORKS_MODEL = 'accounts/fireworks/models/deepseek-v4p1-flash-1017';
const FIREWORKS_URL = 'https://api.fireworks.ai/inference/v1/chat/completions';
export const MAX_TOKENS = 8192;
const DEFAULT_TIMEOUT_MS = 90_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 180_000;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmOptions {
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** A live-mode failure that should surface to the user, never a silent fallback. */
export class LiveModeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LiveModeError';
  }
}

export function resolveTimeoutMs(raw: string | number | undefined): number {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, parsed));
}

export interface Completion {
  content: string;
  /** Whether the model stopped at `max_tokens`. */
  truncated: boolean;
}

/** Sends one chat completion and returns the assistant text. */
export async function complete(
  messages: ChatMessage[],
  options: LlmOptions = {},
): Promise<Completion> {
  const apiKey = options.apiKey ?? process.env.FIREWORKS_API_KEY;
  if (!apiKey)
    throw new LiveModeError('Live mode needs FIREWORKS_API_KEY in the server environment.', 503);
  const timeoutMs = options.timeoutMs ?? resolveTimeoutMs(process.env.RIDGELINE_LLM_TIMEOUT_MS);
  const doFetch = options.fetch ?? fetch;

  let response: Response;
  try {
    response = await doFetch(FIREWORKS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        model: FIREWORKS_MODEL,
        messages,
        max_tokens: MAX_TOKENS,
        temperature: 0.2,
        response_format: {type: 'json_object'},
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new LiveModeError(
        `The model did not answer within ${Math.round(timeoutMs / 1000)} s.`,
        504,
      );
    }
    throw new LiveModeError('Could not reach the Fireworks API.', 502);
  }

  if (!response.ok) {
    // The body may echo request details; report only the status.
    await response.body?.cancel().catch(() => undefined);
    const hint =
      response.status === 401 || response.status === 403 ? ' Check FIREWORKS_API_KEY.' : '';
    throw new LiveModeError(`The Fireworks API returned HTTP ${response.status}.${hint}`, 502);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new LiveModeError('The Fireworks API returned a response that is not JSON.', 502);
  }
  const choice = (payload as {choices?: {message?: {content?: unknown}; finish_reason?: unknown}[]})
    .choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new LiveModeError('The model returned an empty answer.', 502);
  }
  // A truncated answer is still returned so the caller can treat it as bad output.
  return {content, truncated: choice?.finish_reason === 'length'};
}
