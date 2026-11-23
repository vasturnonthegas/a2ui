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
 * Compatibility shim between canonical v1.0 wire messages and the pinned
 * `@a2ui/web_core` 0.14.0 renderer.
 *
 * The authoritative `specification/v1_0/json` schemas write the protocol
 * version as `"1.0"`. The 0.14.0 build validates agent-to-renderer messages
 * with a generated zod schema whose literal is `"v1.0"`, so canonical messages
 * fail with `version: Invalid literal value, expected "v1.0"`.
 *
 * This shim is applied only on the way into `MessageProcessor`. The messages the
 * server returns, the inspector shows, and the action events the UI sends all
 * stay canonical `"1.0"`. Inputs are never mutated.
 */

import type {ActionPayload} from '@a2ui/web_core';

import type {ActionEvent} from './api.js';

/** Version string used by the canonical wire schemas. */
export const CANONICAL_VERSION = '1.0';

/** Version literal the pinned `@a2ui/web_core` 0.14.0 renderer accepts. */
export const RENDERER_VERSION = 'v1.0';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns a copy of each message with a canonical `"1.0"` version rewritten to
 * the renderer's `"v1.0"`. Any other value, including other versions and
 * malformed entries, passes through unchanged so the renderer can still reject
 * it.
 */
export function toRendererMessages(messages: readonly unknown[]): unknown[] {
  return messages.map(message =>
    isRecord(message) && message.version === CANONICAL_VERSION
      ? {...message, version: RENDERER_VERSION}
      : message,
  );
}

/**
 * Builds the canonical renderer-to-agent `action` event from the renderer's
 * `ActionPayload`. Only the fields `renderer_to_agent.json` defines are copied;
 * library-only fields such as `catalogId` are dropped, and the version is the
 * canonical `"1.0"`.
 */
export function toActionEvent(payload: ActionPayload): ActionEvent {
  return {
    version: CANONICAL_VERSION,
    action: {
      name: payload.name,
      surfaceId: payload.surfaceId,
      sourceComponentId: payload.sourceComponentId,
      timestamp: payload.timestamp,
      context: payload.context,
      ...(typeof payload.userMessage === 'string' ? {userMessage: payload.userMessage} : {}),
    },
  };
}
