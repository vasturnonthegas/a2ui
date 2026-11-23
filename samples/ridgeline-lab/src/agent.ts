/**
 * Generates the A2UI surface and the Markdown answer for a scenario.
 *
 * Both outputs come from one model call over the same prompt and fixture, so the two
 * renderings can be compared fairly. Stub mode returns the scenario's checked-in payload.
 * Live mode never falls back to the stub: any failure is reported to the caller. Bad model
 * output gets exactly one repair attempt.
 */

import {actionsForScenario} from './actions.ts';
import {
  complete,
  FIREWORKS_MODEL,
  LiveModeError,
  type ChatMessage,
  type LlmOptions,
} from './llm.ts';
import {
  ALLOWED_COMPONENTS,
  ALLOWED_FUNCTIONS,
  BASIC_CATALOG_ID,
  PROTOCOL_VERSION,
  profileCatalogExcerpt,
  validateMarkdown,
  validateMessages as validateProtocolMessages,
  type ValidateOptions,
} from './protocol.ts';
import type {Scenario} from './scenarios.ts';

export type GenerateMode = 'stub' | 'live';

export interface GenerateResult {
  messages: unknown[];
  markdown: string;
  mode: GenerateMode;
  model: string | null;
  repaired: boolean;
}

/** A generation failure with the HTTP status the server should answer with. */
export class GenerationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'GenerationError';
  }
}

/**
 * Validates A2UI v1.0 messages against the official schemas, the Basic catalog, the strict
 * demo profile, and component/data integrity.
 *
 * @returns Problems found; empty when the payload is accepted.
 */
export function validateMessages(messages: unknown, options?: ValidateOptions): string[] {
  return validateProtocolMessages(messages, options);
}

function scenarioValidateOptions(scenario: Scenario): ValidateOptions {
  return {
    surfaceId: scenario.id,
    allowedActions: actionsForScenario(scenario.id).map(spec => spec.name),
  };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const EXAMPLE = {
  messages: [
    {
      version: PROTOCOL_VERSION,
      createSurface: {
        surfaceId: 'example',
        catalogId: BASIC_CATALOG_ID,
        components: [
          {id: 'root', component: 'Column', children: ['title', 'itemsCard']},
          {id: 'title', component: 'Text', text: '## Open items'},
          {id: 'itemsCard', component: 'Card', child: 'itemsList'},
          {id: 'itemsList', component: 'List', children: {componentId: 'itemRow', path: '/items'}},
          {id: 'itemRow', component: 'Text', text: {'@path': 'label'}},
        ],
        dataModel: {items: [{label: '**A-1** First item'}, {label: '**A-2** Second item'}]},
      },
    },
  ],
  markdown: '## Open items\n\n- **A-1** First item\n- **A-2** Second item\n',
};

export function buildSystemPrompt(scenario: Scenario): string {
  const actions = actionsForScenario(scenario.id);
  const actionRules =
    actions.length === 0
      ? '- This answer is read-only. Do not use Button components and do not add any action.'
      : [
          '- Include exactly one Button. Its action must be an agent event, never a functionCall:',
          ...actions.map(
            spec =>
              `  {"event": {"name": "${spec.name}", "context": {${spec.contextKeys
                .map(key => `"${key}": {"@path": "/..."}`)
                .join(', ')}}}}\n` +
              `  The context keys must be exactly ${spec.contextKeys.join(', ')}, each bound to the input that edits it. ` +
              `Prefill every input through dataModel. ${spec.promptHint}`,
          ),
          '- In the Markdown answer, list the same prefilled values and say that nothing is saved until the user confirms.',
        ].join('\n');

  return [
    'You turn one task and one JSON fixture into the same answer in two forms: an A2UI v1.0 user interface and a Markdown document.',
    'Reply with a single JSON object and nothing else: {"messages": [...], "markdown": "..."}.',
    '',
    'Accuracy:',
    '- Use only facts from the fixture. Do not invent IDs, names, dates, amounts, or statuses.',
    '- The UI and the Markdown must state the same facts.',
    '',
    'A2UI rules:',
    `- "messages" holds exactly one createSurface message with "version": "${PROTOCOL_VERSION}", "surfaceId": "${scenario.id}", and "catalogId": "${BASIC_CATALOG_ID}". Put "components" and any "dataModel" inline.`,
    '- Components form a flat list and refer to each other by ID. One component has id "root". Every component must be reachable from root, have exactly one parent, and never form a cycle.',
    `- Use only these components: ${ALLOWED_COMPONENTS.join(', ')}.`,
    `- Function calls ({"@call": name, "args": {...}}) may use only: ${ALLOWED_FUNCTIONS.join(', ')}.`,
    '- A data binding is {"@path": "/json/pointer"}. Absolute paths must exist in dataModel unless an input component binds its value there. Relative paths are only for components inside a List template.',
    '- Text may use simple Markdown (headings, bold, italics). Never write HTML, links, images, URLs, or email addresses anywhere.',
    actionRules,
    scenario.mobile
      ? '- The surface is shown on a phone. Keep one narrow Column; do not place panels side by side.'
      : '- The surface is shown in a desktop panel.',
    '',
    'Markdown rules:',
    '- Use headings, paragraphs, lists, tables, and bold. Never write HTML, links, images, URLs, or email addresses.',
    '',
    'Allowed component and function schemas (official A2UI Basic catalog, JSON Schema 2020-12):',
    JSON.stringify(profileCatalogExcerpt()),
    '',
    'Example of the reply shape (different data):',
    JSON.stringify(EXAMPLE),
  ].join('\n');
}

export function buildUserPrompt(scenario: Scenario): string {
  return [
    `Task: ${scenario.prompt}`,
    '',
    'Fixture JSON (the only source of facts):',
    JSON.stringify(scenario.fixture, null, 2),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Parsing and checking model output
// ---------------------------------------------------------------------------

interface Candidate {
  messages: unknown[];
  markdown: string;
}

/** Extracts the reply object, tolerating reasoning blocks and code fences around it. */
export function parseModelReply(
  content: string,
): {ok: true; value: Candidate} | {ok: false; errors: string[]} {
  let text = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced?.[1]) text = fenced[1];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return {ok: false, errors: ['The reply is not a JSON object.']};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    return {ok: false, errors: [`The reply is not valid JSON: ${(error as Error).message}`]};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {ok: false, errors: ['The reply must be a JSON object with "messages" and "markdown".']};
  }
  const {messages, markdown} = parsed as Record<string, unknown>;
  const errors: string[] = [];
  if (!Array.isArray(messages)) errors.push('"messages" must be an array of A2UI messages.');
  if (typeof markdown !== 'string') errors.push('"markdown" must be a string.');
  if (errors.length > 0) return {ok: false, errors};
  return {ok: true, value: {messages: messages as unknown[], markdown: markdown as string}};
}

function checkReply(
  content: string,
  truncated: boolean,
  scenario: Scenario,
): {ok: true; value: Candidate} | {ok: false; errors: string[]} {
  if (truncated) {
    return {
      ok: false,
      errors: [
        'The reply was cut off at the token limit. Return a more compact answer with fewer components.',
      ],
    };
  }
  const parsed = parseModelReply(content);
  if (!parsed.ok) return parsed;
  const errors = [
    ...validateMessages(parsed.value.messages, scenarioValidateOptions(scenario)),
    ...validateMarkdown(parsed.value.markdown),
  ];
  return errors.length > 0 ? {ok: false, errors} : parsed;
}

const REPAIR_ECHO_LIMIT = 24_000;

function repairPrompt(errors: string[]): string {
  return [
    'Your reply was rejected by the A2UI v1.0 validator:',
    ...errors.slice(0, 30).map(error => `- ${error}`),
    '',
    'Return the complete corrected JSON object {"messages": [...], "markdown": "..."} and nothing else.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Test seams for live mode: the key, fetch implementation, and timeout. */
export type GenerateOptions = LlmOptions;

export async function generate(
  scenario: Scenario,
  mode: GenerateMode,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  if (mode === 'stub') {
    const messages = structuredClone(scenario.stub.messages);
    const errors = [
      ...validateMessages(messages, scenarioValidateOptions(scenario)),
      ...validateMarkdown(scenario.stub.markdown),
    ];
    if (errors.length > 0) {
      throw new GenerationError(`The stub payload for ${scenario.id} is invalid.`, 500, errors);
    }
    return {messages, markdown: scenario.stub.markdown, mode, model: null, repaired: false};
  }
  if (mode !== 'live') throw new GenerationError('mode must be "stub" or "live".', 400);

  const conversation: ChatMessage[] = [
    {role: 'system', content: buildSystemPrompt(scenario)},
    {role: 'user', content: buildUserPrompt(scenario)},
  ];
  try {
    const first = await complete(conversation, options);
    const firstCheck = checkReply(first.content, first.truncated, scenario);
    if (firstCheck.ok) return {...firstCheck.value, mode, model: FIREWORKS_MODEL, repaired: false};

    // Exactly one repair attempt.
    conversation.push(
      {role: 'assistant', content: first.content.slice(0, REPAIR_ECHO_LIMIT)},
      {role: 'user', content: repairPrompt(firstCheck.errors)},
    );
    const second = await complete(conversation, options);
    const secondCheck = checkReply(second.content, second.truncated, scenario);
    if (secondCheck.ok) return {...secondCheck.value, mode, model: FIREWORKS_MODEL, repaired: true};
    throw new GenerationError(
      'The model output failed validation after one repair attempt.',
      502,
      secondCheck.errors,
    );
  } catch (error) {
    if (error instanceof LiveModeError) throw new GenerationError(error.message, error.status);
    throw error;
  }
}
