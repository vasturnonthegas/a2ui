/**
 * Typed client for the lab server's JSON API.
 *
 * The server owns scenario data and generation; the browser only receives the
 * summary fields below. Every call accepts an `AbortSignal` so the caller can
 * drop stale requests when the user switches scenario or mode.
 */

export type Product = 'Ridgeline' | 'Cortex' | 'LocalFlow';
export type GenerationMode = 'stub' | 'live';

export interface ScenarioSummary {
  id: string;
  title: string;
  product: Product;
  description: string;
  prompt: string;
  mobile?: boolean;
}

export interface Generation {
  messages: unknown[];
  markdown: string;
  mode: GenerationMode;
  model: string | null;
  repaired: boolean;
}

/** The v1.0 renderer-to-agent `action` event, as defined by `renderer_to_agent.json`. */
export interface ActionEvent {
  version: '1.0';
  action: {
    name: string;
    surfaceId: string;
    sourceComponentId: string;
    timestamp: string;
    context: Record<string, unknown>;
    userMessage?: string;
  };
}

export interface StagedAction {
  id: string;
  token: string;
  expiresAt: string;
  arguments: Record<string, unknown>;
}

export interface ActionResult {
  status: 'confirmation_required' | 'drafted';
  action?: StagedAction;
  message: string;
}

export interface ResolutionResult {
  status: 'confirmed' | 'cancelled';
  message: string;
}

/** Error raised for non-2xx responses, carrying the server's `{error}` text. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function request<T>(path: string, init: RequestInit & {signal?: AbortSignal}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? {'Content-Type': 'application/json'} : {}),
    },
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const message =
      isRecord(body) && typeof body.error === 'string'
        ? body.error
        : `Request failed with status ${response.status}.`;
    throw new ApiError(message, response.status);
  }
  if (body === undefined) {
    throw new ApiError('The server returned an empty or non-JSON response.', response.status);
  }
  return body as T;
}

function post<T>(path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, {method: 'POST', body: JSON.stringify(payload), signal});
}

export async function fetchScenarios(signal?: AbortSignal): Promise<ScenarioSummary[]> {
  const body = await request<{scenarios: ScenarioSummary[]}>('/api/scenarios', {
    method: 'GET',
    signal,
  });
  if (!Array.isArray(body.scenarios)) {
    throw new ApiError('The scenario list is malformed.', 200);
  }
  return body.scenarios;
}

export function generate(
  scenarioId: string,
  mode: GenerationMode,
  signal?: AbortSignal,
): Promise<Generation> {
  return post<Generation>('/api/generate', {scenarioId, mode}, signal);
}

export function sendAction(scenarioId: string, event: ActionEvent): Promise<ActionResult> {
  return post<ActionResult>('/api/action', {scenarioId, event});
}

export function confirmAction(id: string, token: string): Promise<ResolutionResult> {
  return post<ResolutionResult>('/api/confirm', {id, token});
}

export function cancelAction(id: string, token: string): Promise<ResolutionResult> {
  return post<ResolutionResult>('/api/cancel', {id, token});
}

/** Message text for any thrown value, without leaking stack traces into the UI. */
export function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Something went wrong.';
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
