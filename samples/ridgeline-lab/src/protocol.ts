/**
 * A2UI v1.0 validation for the Ridgeline lab server.
 *
 * Three layers run on every payload:
 *
 * 1. The official v1.0 wire schemas (`specification/v1_0/json`) with the official Basic
 *    catalog (`catalogs/basic/v1/catalog.json`), compiled with Ajv's JSON Schema 2020-12
 *    dialect.
 * 2. A strict demo profile: only surface/component/data messages, only the Basic catalog,
 *    no resource-loading components, no URL-opening or regex functions, no local function
 *    actions, no raw HTML, no URLs, and only allowlisted agent events.
 * 3. Integrity checks the schema can't express: a reachable `root`, resolvable child
 *    references, no cycles or orphans, and data bindings that resolve.
 *
 * Component and function rules are derived from the catalog JSON so the profile stays
 * catalog-driven; the only hand-written lists are the profile exclusions.
 */

import {readFileSync} from 'node:fs';

import {Ajv2020, type ErrorObject, type ValidateFunction} from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {ACTION_SPECS} from './actions.ts';

type Json = Record<string, unknown>;

function readJson(url: URL): Json {
  return JSON.parse(readFileSync(url, 'utf8')) as Json;
}

const REPO_ROOT = new URL('../../../', import.meta.url);
const SPEC_DIR = new URL('specification/v1_0/json/', REPO_ROOT);
const CATALOG_URL = new URL('catalogs/basic/v1/catalog.json', REPO_ROOT);

/** The wire-protocol version string from the v1.0 JSON schemas. */
export const PROTOCOL_VERSION = '1.0';
/** `$id` the v1.0 wire schemas use to reference the active catalog. */
const CATALOG_REF_ID = 'https://a2ui.org/specification/v1_0/catalog.json';
const COMMON_TYPES_ID = 'https://a2ui.org/specification/v1_0/common_types.json';

const catalog = readJson(CATALOG_URL);
/** The official v1.0 Basic catalog ID. */
export const BASIC_CATALOG_ID = catalog.catalogId as string;

const catalogComponents = catalog.components as Record<string, Json>;
const catalogFunctions = catalog.functions as Record<string, Json>;

// ---------------------------------------------------------------------------
// Strict demo profile
// ---------------------------------------------------------------------------

/** Components that load remote media. The demo renders no remote resources. */
const EXCLUDED_COMPONENTS: ReadonlySet<string> = new Set(['Image', 'Video', 'AudioPlayer']);
/** `openUrl` navigates away; `regex` runs model-authored patterns in the renderer. */
const EXCLUDED_FUNCTIONS: ReadonlySet<string> = new Set(['openUrl', 'regex']);

export const ALLOWED_COMPONENTS: readonly string[] = Object.keys(catalogComponents).filter(
  name => !EXCLUDED_COMPONENTS.has(name),
);
export const ALLOWED_FUNCTIONS: readonly string[] = Object.keys(catalogFunctions).filter(
  name => !EXCLUDED_FUNCTIONS.has(name),
);
const ALLOWED_SYSTEM_FUNCTIONS: ReadonlySet<string> = new Set(['@index']);
const ALLOWED_MESSAGE_KINDS = ['createSurface', 'updateComponents', 'updateDataModel'] as const;
const ALL_MESSAGE_KINDS = [
  ...ALLOWED_MESSAGE_KINDS,
  'deleteSurface',
  'callRendererFunction',
  'agentFunctionResponse',
] as const;

export const LIMITS = {
  messages: 20,
  components: 300,
  bytes: 256 * 1024,
  stringLength: 4000,
  depth: 32,
  errors: 40,
  markdownLength: 20_000,
} as const;

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const HTML_PATTERN = /<[A-Za-z!?/]/;
// Any `scheme://`, script-capable schemes, and what GFM autolinks (`www.` and bare emails).
const URL_PATTERN =
  /\b[a-z][a-z0-9+.-]*:\/\/|\b(?:javascript|vbscript|data|file|blob|mailto|tel):[^\s]|\bwww\.[a-z0-9-]|[\w.+-]+@[a-z0-9-]+\.[a-z]{2,}/i;
const MARKDOWN_LINK_PATTERN = /!?\[[^\]]*\]\(|^\s*\[[^\]]+\]:\s*\S/m;
const POINTER_PATTERN = /^(?:\/(?:[^~/]|~[01])*)*$/;
const RELATIVE_POINTER_PATTERN = /^(?:[^~/]|~[01])+(?:\/(?:[^~/]|~[01])*)*$/;

/** Checks a string for content the demo profile never renders. */
function unsafeTextReason(value: string): string | undefined {
  if (HTML_PATTERN.test(value)) return 'contains raw HTML';
  if (URL_PATTERN.test(value)) return 'contains a URL or URL scheme';
  if (MARKDOWN_LINK_PATTERN.test(value)) return 'contains a Markdown link or image';
  return undefined;
}

// ---------------------------------------------------------------------------
// Catalog-derived component metadata
// ---------------------------------------------------------------------------

type RefKind = 'child' | 'childList' | 'action' | 'itemChild';
interface PropRef {
  prop: string;
  kind: RefKind;
  /** For `itemChild`: the key inside each array item that holds a child ID. */
  itemKey?: string;
}
interface ComponentMeta {
  refs: PropRef[];
  /** Whether the component is a user input (Checkable) whose `value` binding is writable. */
  isInput: boolean;
}

function refName(schema: unknown): string | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const ref = (schema as Json).$ref;
  return typeof ref === 'string' ? ref.slice(ref.lastIndexOf('/') + 1) : undefined;
}

function ownProperties(schema: Json): Record<string, Json> {
  const merged: Record<string, Json> = {
    ...((schema.properties as Record<string, Json> | undefined) ?? {}),
  };
  for (const part of (schema.allOf as Json[] | undefined) ?? []) {
    Object.assign(merged, (part.properties as Record<string, Json> | undefined) ?? {});
  }
  return merged;
}

function describeComponent(schema: Json): ComponentMeta {
  const refs: PropRef[] = [];
  for (const [prop, propSchema] of Object.entries(ownProperties(schema))) {
    const name = refName(propSchema);
    if (name === 'Child') refs.push({prop, kind: 'child'});
    else if (name === 'ChildList') refs.push({prop, kind: 'childList'});
    else if (name === 'Action') refs.push({prop, kind: 'action'});
    else if (
      propSchema.type === 'array' &&
      typeof propSchema.items === 'object' &&
      propSchema.items !== null
    ) {
      for (const [itemKey, itemSchema] of Object.entries(ownProperties(propSchema.items as Json))) {
        if (refName(itemSchema) === 'Child') refs.push({prop, kind: 'itemChild', itemKey});
      }
    }
  }
  const isInput =
    ((schema.allOf as Json[] | undefined) ?? []).some(part => refName(part) === 'Checkable') &&
    'value' in ownProperties(schema);
  return {refs, isInput};
}

const COMPONENT_META: ReadonlyMap<string, ComponentMeta> = new Map(
  Object.entries(catalogComponents).map(([name, schema]) => [name, describeComponent(schema)]),
);

// ---------------------------------------------------------------------------
// Ajv setup
// ---------------------------------------------------------------------------

const ajv = new Ajv2020({strict: false, allErrors: true});
addFormats(ajv);
ajv.addSchema(readJson(new URL('common_types.json', SPEC_DIR)));
// The wire schemas reference the active catalog as `catalog.json` next to themselves.
ajv.addSchema({...catalog, $id: CATALOG_REF_ID});

const validateWireMessage: ValidateFunction = ajv.compile(
  readJson(new URL('agent_to_renderer.json', SPEC_DIR)),
);
const validateWireEvent: ValidateFunction = ajv.compile(
  readJson(new URL('renderer_to_agent.json', SPEC_DIR)),
);

const componentValidators = new Map<string, ValidateFunction>();
/** A per-type validator so errors name the failing property instead of every oneOf branch. */
function componentValidator(type: string): ValidateFunction {
  let validator = componentValidators.get(type);
  if (!validator) {
    validator = ajv.compile({
      allOf: [
        {$ref: `${COMMON_TYPES_ID}#/$defs/ComponentCommon`},
        {$ref: `${CATALOG_REF_ID}#/components/${type}`},
      ],
      unevaluatedProperties: false,
    });
    componentValidators.set(type, validator);
  }
  return validator;
}

function formatAjvErrors(
  errors: ErrorObject[] | null | undefined,
  prefix: string,
  max = 6,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const error of errors ?? []) {
    if (error.keyword === 'oneOf' || error.keyword === 'allOf' || error.keyword === 'if') continue;
    let detail = error.message ?? 'is invalid';
    if (error.keyword === 'unevaluatedProperties' || error.keyword === 'additionalProperties') {
      const params = error.params as {unevaluatedProperty?: string; additionalProperty?: string};
      detail = `has unknown property "${params.unevaluatedProperty ?? params.additionalProperty}"`;
    } else if (error.keyword === 'enum') {
      detail = `must be one of ${JSON.stringify((error.params as {allowedValues: unknown[]}).allowedValues)}`;
    } else if (error.keyword === 'const') {
      detail = `must equal ${JSON.stringify((error.params as {allowedValue: unknown}).allowedValue)}`;
    }
    const line = `${prefix}${error.instancePath} ${detail}`;
    if (!seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
    if (out.length >= max) break;
  }
  return out.length > 0 ? out : [`${prefix} does not match the A2UI v1.0 schema`];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodePointer(pointer: string): string[] {
  if (pointer === '' || pointer === '/') return [];
  return pointer
    .replace(/^\//, '')
    .split('/')
    .map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** Returns the first reserved segment in a pointer, which must never be traversed or written. */
function reservedPointerSegment(pointer: string): string | undefined {
  return decodePointer(pointer).find(segment => FORBIDDEN_KEYS.has(segment));
}

function lookup(root: unknown, pointer: string): {found: boolean; value: unknown} {
  let current: unknown = root;
  for (const segment of decodePointer(pointer)) {
    if (
      Array.isArray(current) &&
      /^(?:0|[1-9]\d*)$/.test(segment) &&
      Number(segment) < current.length
    ) {
      current = current[Number(segment)];
    } else if (isRecord(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return {found: false, value: undefined};
    }
  }
  return {found: true, value: current};
}

/**
 * Writes `value` at `pointer` in a copy of `root`. Callers must reject reserved segments
 * first; as a second line of defense this refuses them and follows only own properties.
 */
function setPointer(root: Json, pointer: string, value: unknown): Json {
  const segments = decodePointer(pointer);
  if (segments.some(segment => FORBIDDEN_KEYS.has(segment))) return root;
  if (segments.length === 0) return isRecord(value) ? structuredClone(value) : {};
  const next = structuredClone(root);
  let current: Json = next;
  for (const segment of segments.slice(0, -1)) {
    const child = Object.hasOwn(current, segment) ? current[segment] : undefined;
    if (isRecord(child)) {
      current = child;
    } else {
      const created: Json = {};
      current[segment] = created;
      current = created;
    }
  }
  const last = segments[segments.length - 1] as string;
  if (value === null) delete current[last];
  else current[last] = structuredClone(value);
  return next;
}

interface ErrorSink {
  errors: string[];
  add(message: string): void;
}

function createSink(): ErrorSink {
  const errors: string[] = [];
  return {
    errors,
    add(message) {
      if (errors.length < LIMITS.errors && !errors.includes(message)) errors.push(message);
    },
  };
}

/**
 * Walks every JSON value, enforcing depth and reserved-key rules. With `content` set (the
 * default) it also enforces string and function-call rules, which apply to model output
 * but not to text the user typed into a form.
 */
function checkValueTree(
  value: unknown,
  where: string,
  sink: ErrorSink,
  depth = 0,
  content = true,
): void {
  if (depth > LIMITS.depth) {
    sink.add(`${where} nests deeper than ${LIMITS.depth} levels`);
    return;
  }
  if (typeof value === 'string') {
    if (!content) return;
    if (value.length > LIMITS.stringLength)
      sink.add(`${where} is longer than ${LIMITS.stringLength} characters`);
    const reason = unsafeTextReason(value);
    if (reason) sink.add(`${where} ${reason}; the demo profile renders plain text only`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      checkValueTree(item, `${where}[${index}]`, sink, depth + 1, content),
    );
    return;
  }
  if (!isRecord(value)) return;
  const call = content ? value['@call'] : undefined;
  if (typeof call === 'string') {
    const allowed = call.startsWith('@')
      ? ALLOWED_SYSTEM_FUNCTIONS.has(call)
      : ALLOWED_FUNCTIONS.includes(call);
    if (!allowed) sink.add(`${where} calls "${call}", which the demo profile does not allow`);
    if ('catalogId' in value && value.catalogId !== BASIC_CATALOG_ID) {
      sink.add(
        `${where} names catalog ${JSON.stringify(value.catalogId)}; only the Basic catalog is allowed`,
      );
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      sink.add(`${where} uses the reserved key "${key}"`);
      continue;
    }
    checkValueTree(child, `${where}.${key}`, sink, depth + 1, content);
  }
}

/** Collects every `{"@path": ...}` binding inside a value. */
function collectBindings(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach(item => collectBindings(item, out));
  else if (isRecord(value)) {
    if (typeof value['@path'] === 'string' && Object.keys(value).length === 1)
      out.push(value['@path']);
    else Object.values(value).forEach(child => collectBindings(child, out));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  /** When set, every message must target this surface ID. */
  surfaceId?: string;
  /** Agent event names the surface may emit. Defaults to every allowlisted action. */
  allowedActions?: readonly string[];
}

interface SurfaceState {
  components: Map<string, Json>;
  dataModel: Json;
  where: string;
}

function messageKind(message: Json): string | undefined {
  return ALL_MESSAGE_KINDS.find(kind => kind in message);
}

function checkComponentList(
  list: Json[],
  where: string,
  surface: SurfaceState,
  allowedActions: readonly string[],
  sink: ErrorSink,
): void {
  const idsInList = new Set<string>();
  list.forEach((component, index) => {
    const id = String(component.id);
    const at = `${where}.components[${index}] (id "${id}")`;
    if (idsInList.has(id)) sink.add(`${at} duplicates a component ID in the same list`);
    idsInList.add(id);
    const type = String(component.component);
    if (!ALLOWED_COMPONENTS.includes(type)) {
      sink.add(
        `${at} uses component "${type}"; allowed components are ${ALLOWED_COMPONENTS.join(', ')}`,
      );
      return;
    }
    if ('@catalogId' in component && component['@catalogId'] !== BASIC_CATALOG_ID) {
      sink.add(`${at} overrides @catalogId; only the Basic catalog is allowed`);
    }
    if ('@metadata' in component)
      sink.add(`${at} sets @metadata; extensions are not allowed in the demo profile`);
    for (const ref of COMPONENT_META.get(type)?.refs ?? []) {
      if (ref.kind === 'action' && ref.prop in component)
        checkAction(component[ref.prop], `${at}.${ref.prop}`, allowedActions, sink);
    }
    checkValueTree(component, at, sink);
    surface.components.set(id, component);
  });
}

function checkAction(
  action: unknown,
  where: string,
  allowedActions: readonly string[],
  sink: ErrorSink,
): void {
  if (!isRecord(action)) return;
  if ('functionCall' in action) {
    sink.add(
      `${where} runs a local function; the demo profile only allows allowlisted agent events`,
    );
    return;
  }
  const event = action.event;
  if (!isRecord(event)) return;
  const name = String(event.name);
  const spec = ACTION_SPECS.get(name);
  if (!spec || !allowedActions.includes(name)) {
    const allowed =
      allowedActions.length > 0 ? allowedActions.join(', ') : 'none for this scenario';
    sink.add(`${where}.event.name "${name}" is not allowlisted (allowed: ${allowed})`);
    return;
  }
  const context = isRecord(event.context) ? event.context : {};
  const keys = Object.keys(context).sort();
  const expected = [...spec.contextKeys].sort();
  if (keys.join(',') !== expected.join(',')) {
    sink.add(
      `${where}.event.context must have exactly the keys ${expected.join(', ')}; got ${keys.join(', ') || 'none'}`,
    );
  }
  // Every allowlisted context key is a user-editable field, so a literal would send a fixed
  // value instead of the user's edit. Confirm and cancel are host routes, not surface events.
  for (const [key, value] of Object.entries(context)) {
    if (contextBinding(value) === undefined) {
      sink.add(`${where}.event.context.${key} must be a data binding to the input that edits it`);
    }
  }
}

/** The `@path` of a context value that is exactly a data binding. */
function contextBinding(value: unknown): string | undefined {
  return isRecord(value) && typeof value['@path'] === 'string' && Object.keys(value).length === 1
    ? value['@path']
    : undefined;
}

/**
 * Checks that each allowlisted event's context binds to a distinct input `value` binding, so
 * the emitted values are the ones the user edited. Runs once all components are applied.
 */
function checkActionBindings(
  at: string,
  components: Map<string, Json>,
  inputPaths: ReadonlySet<string>,
  sink: ErrorSink,
): void {
  for (const [id, component] of components) {
    for (const ref of COMPONENT_META.get(String(component.component))?.refs ?? []) {
      if (ref.kind !== 'action') continue;
      const action = component[ref.prop];
      const event = isRecord(action) ? action.event : undefined;
      if (!isRecord(event) || !ACTION_SPECS.has(String(event.name))) continue;
      if (!isRecord(event.context)) continue;
      const boundBy = new Map<string, string>();
      for (const [key, value] of Object.entries(event.context)) {
        const path = contextBinding(value);
        if (path === undefined) continue;
        const where = `${at}: component "${id}".${ref.prop}.event.context.${key}`;
        if (!inputPaths.has(path)) {
          sink.add(`${where} binds ${path}, which no input component edits`);
        } else if (boundBy.has(path)) {
          sink.add(`${where} binds ${path}, which is already bound to "${boundBy.get(path)}"`);
        } else {
          boundBy.set(path, key);
        }
      }
    }
  }
}

/** Checks graph shape and bindings for one surface after all messages are applied. */
function checkSurfaceIntegrity(surfaceId: string, surface: SurfaceState, sink: ErrorSink): void {
  const at = `surface "${surfaceId}"`;
  const {components, dataModel} = surface;
  if (components.size === 0) {
    sink.add(`${at} has no components`);
    return;
  }
  if (components.size > LIMITS.components)
    sink.add(`${at} has more than ${LIMITS.components} components`);
  if (!components.has('root')) {
    sink.add(`${at} has no component with id "root"`);
    return;
  }

  const edges = new Map<string, {id: string; template: boolean}[]>();
  const parents = new Map<string, string[]>();
  for (const [id, component] of components) {
    const meta = COMPONENT_META.get(String(component.component));
    const out: {id: string; template: boolean}[] = [];
    const link = (target: unknown, prop: string, template = false): void => {
      if (typeof target !== 'string') return;
      if (!components.has(target))
        sink.add(`${at}: component "${id}".${prop} references missing component "${target}"`);
      else if (target === id) sink.add(`${at}: component "${id}" references itself`);
      else {
        out.push({id: target, template});
        parents.set(target, [...(parents.get(target) ?? []), id]);
      }
    };
    for (const ref of meta?.refs ?? []) {
      const value = component[ref.prop];
      if (ref.kind === 'child') link(value, ref.prop);
      else if (ref.kind === 'childList') {
        if (Array.isArray(value)) value.forEach((child, i) => link(child, `${ref.prop}[${i}]`));
        else if (isRecord(value)) {
          link(value.componentId, `${ref.prop}.componentId`, true);
          const path = String(value.path);
          if (path.startsWith('/')) {
            const hit = lookup(dataModel, path);
            if (!hit.found || !Array.isArray(hit.value)) {
              sink.add(
                `${at}: component "${id}" repeats over ${path}, which is not a list in the data model`,
              );
            }
          }
        }
      } else if (ref.kind === 'itemChild' && Array.isArray(value)) {
        value.forEach(
          (item, i) =>
            isRecord(item) && link(item[ref.itemKey as string], `${ref.prop}[${i}].${ref.itemKey}`),
        );
      }
    }
    edges.set(id, out);
  }

  for (const [id, from] of parents) {
    if (from.length > 1)
      sink.add(`${at}: component "${id}" has more than one parent (${from.join(', ')})`);
  }

  // Reachability, cycles, and which components render inside a list template.
  const state = new Map<string, 'visiting' | 'done'>();
  const inTemplate = new Set<string>();
  const visit = (id: string, templated: boolean): void => {
    if (templated) inTemplate.add(id);
    const seen = state.get(id);
    if (seen === 'visiting') {
      sink.add(`${at}: component "${id}" is part of a reference cycle`);
      return;
    }
    if (seen === 'done' && !templated) return;
    state.set(id, 'visiting');
    for (const edge of edges.get(id) ?? []) visit(edge.id, templated || edge.template);
    state.set(id, 'done');
  };
  visit('root', false);
  for (const id of components.keys()) {
    if (!state.has(id)) sink.add(`${at}: component "${id}" is not reachable from "root"`);
  }

  // Writable paths: input components create their bound value if it is missing.
  const writable = new Set<string>();
  for (const component of components.values()) {
    if (COMPONENT_META.get(String(component.component))?.isInput) {
      const value = component.value;
      if (isRecord(value) && typeof value['@path'] === 'string') writable.add(value['@path']);
    }
  }
  checkActionBindings(
    at,
    components,
    new Set([...writable].filter(path => path.startsWith('/'))),
    sink,
  );
  for (const [id, component] of components) {
    for (const path of collectBindings(component)) {
      if (path.startsWith('/')) {
        if (!POINTER_PATTERN.test(path))
          sink.add(`${at}: component "${id}" binds an invalid JSON Pointer "${path}"`);
        else if (!writable.has(path) && !lookup(dataModel, path).found) {
          sink.add(
            `${at}: component "${id}" binds ${path}, which is not in the data model or bound to an input`,
          );
        }
      } else if (!inTemplate.has(id)) {
        sink.add(`${at}: component "${id}" uses relative path "${path}" outside a list template`);
      } else if (!RELATIVE_POINTER_PATTERN.test(path)) {
        sink.add(`${at}: component "${id}" binds an invalid relative path "${path}"`);
      }
    }
  }
}

/**
 * Validates agent-to-renderer messages for the demo.
 *
 * @returns Human-readable problems; an empty array means the payload is accepted.
 */
export function validateMessages(messages: unknown, options: ValidateOptions = {}): string[] {
  const sink = createSink();
  const allowedActions = options.allowedActions ?? [...ACTION_SPECS.keys()];
  if (!Array.isArray(messages)) return ['messages must be a JSON array of A2UI v1.0 messages'];
  if (messages.length === 0) return ['messages must contain at least one createSurface message'];
  if (messages.length > LIMITS.messages)
    return [`messages must contain at most ${LIMITS.messages} messages`];
  let size: number;
  try {
    size = JSON.stringify(messages).length;
  } catch {
    return ['messages must be plain JSON'];
  }
  if (size > LIMITS.bytes) return [`messages exceed ${LIMITS.bytes} bytes`];

  const surfaces = new Map<string, SurfaceState>();
  messages.forEach((message: unknown, index) => {
    const where = `messages[${index}]`;
    if (!isRecord(message)) {
      sink.add(`${where} must be an object`);
      return;
    }
    const kind = messageKind(message);
    if (kind && !(ALLOWED_MESSAGE_KINDS as readonly string[]).includes(kind)) {
      sink.add(
        `${where} is a ${kind} message; the demo profile allows only ${ALLOWED_MESSAGE_KINDS.join(', ')}`,
      );
      return;
    }
    if (!validateWireMessage(message)) {
      const componentErrors = describeComponentErrors(message, where);
      const errors =
        componentErrors.length > 0
          ? componentErrors
          : formatAjvErrors(validateWireMessage.errors, where);
      errors.forEach(error => sink.add(error));
      return;
    }
    const body = message[kind as string] as Json;
    const surfaceId = String(body.surfaceId);
    const at = `${where}.${kind}`;
    if (options.surfaceId !== undefined && surfaceId !== options.surfaceId) {
      sink.add(`${at}.surfaceId must be "${options.surfaceId}"`);
      return;
    }
    if (kind === 'createSurface') {
      if (surfaces.has(surfaceId)) {
        sink.add(`${at} creates surface "${surfaceId}" twice`);
        return;
      }
      if (body.catalogId !== BASIC_CATALOG_ID)
        sink.add(`${at}.catalogId must be "${BASIC_CATALOG_ID}"`);
      if (body.sendDataModel === true)
        sink.add(`${at}.sendDataModel must not be true in the demo profile`);
      if ('metadata' in body) sink.add(`${at}.metadata is not allowed in the demo profile`);
      const surface: SurfaceState = {components: new Map(), dataModel: {}, where: at};
      surfaces.set(surfaceId, surface);
      if (isRecord(body.dataModel)) {
        checkValueTree(body.dataModel, `${at}.dataModel`, sink);
        surface.dataModel = structuredClone(body.dataModel);
      }
      if (Array.isArray(body.components))
        checkComponentList(body.components as Json[], at, surface, allowedActions, sink);
      return;
    }
    const surface = surfaces.get(surfaceId);
    if (!surface) {
      sink.add(`${at} targets surface "${surfaceId}" before a createSurface message`);
      return;
    }
    if (kind === 'updateComponents') {
      checkComponentList(body.components as Json[], at, surface, allowedActions, sink);
    } else {
      const path = typeof body.path === 'string' ? body.path : '/';
      if (!POINTER_PATTERN.test(path)) {
        sink.add(`${at}.path "${path}" is not a JSON Pointer`);
        return;
      }
      const reserved = reservedPointerSegment(path);
      if (reserved !== undefined) {
        sink.add(`${at}.path "${path}" uses the reserved key "${reserved}"`);
        return;
      }
      checkValueTree(body.value, `${at}.value`, sink);
      surface.dataModel = setPointer(surface.dataModel, path, body.value);
    }
  });

  if (sink.errors.length === 0 && surfaces.size === 0)
    sink.add('messages must include a createSurface message');
  // Integrity runs even after profile errors so a single repair turn sees every problem.
  for (const [surfaceId, surface] of surfaces) checkSurfaceIntegrity(surfaceId, surface, sink);
  return sink.errors;
}

/** Re-validates each component on its own to produce errors that name one property. */
function describeComponentErrors(message: Json, where: string): string[] {
  const kind = messageKind(message);
  const body = kind ? message[kind] : undefined;
  if (!isRecord(body) || !Array.isArray(body.components)) return [];
  const out: string[] = [];
  body.components.forEach((component: unknown, index) => {
    const at = `${where}.${kind}.components[${index}]`;
    if (!isRecord(component)) {
      out.push(`${at} must be an object`);
      return;
    }
    const type = component.component;
    const label = `${at} (id "${String(component.id)}")`;
    if (typeof type !== 'string' || !(type in catalogComponents) || type === 'Surface') {
      out.push(`${label} has unknown component type ${JSON.stringify(type)}`);
      return;
    }
    const validator = componentValidator(type);
    if (!validator(component)) out.push(...formatAjvErrors(validator.errors, label, 4));
  });
  return out;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/** Validates the Markdown answer under the same no-HTML, no-URL profile. */
export function validateMarkdown(markdown: unknown): string[] {
  if (typeof markdown !== 'string' || markdown.trim().length === 0)
    return ['markdown must be a non-empty string'];
  const errors: string[] = [];
  if (markdown.length > LIMITS.markdownLength)
    errors.push(`markdown is longer than ${LIMITS.markdownLength} characters`);
  const reason = unsafeTextReason(markdown);
  if (reason)
    errors.push(`markdown ${reason}; use plain Markdown text, lists, tables, and emphasis only`);
  return errors;
}

// ---------------------------------------------------------------------------
// Renderer-to-agent events
// ---------------------------------------------------------------------------

export interface ActionEventMessage {
  version: typeof PROTOCOL_VERSION;
  action: {
    name: string;
    surfaceId: string;
    sourceComponentId: string;
    timestamp: string;
    context: Record<string, unknown>;
    userMessage?: string;
  };
}

const ACTION_FIELDS = [
  'name',
  'surfaceId',
  'sourceComponentId',
  'timestamp',
  'context',
  'userMessage',
] as const;

/**
 * Validates a renderer-to-agent action event.
 *
 * Accepts the v1.0 wire envelope `{"version": "1.0", "action": {...}}` or the bare
 * `ActionPayload` that `@a2ui/web_core` emits from `onAction`. The published library
 * writes the version as `"v1.0"`; it is normalized to the schema's `"1.0"`. Library-only
 * payload fields are dropped before the official `renderer_to_agent.json` schema runs.
 */
export function validateActionEvent(
  event: unknown,
): {ok: true; message: ActionEventMessage} | {ok: false; errors: string[]} {
  if (!isRecord(event)) return {ok: false, errors: ['event must be an object']};
  let action: unknown = event;
  if ('version' in event || 'action' in event) {
    if (event.version !== PROTOCOL_VERSION && event.version !== `v${PROTOCOL_VERSION}`) {
      return {ok: false, errors: [`event.version must be "${PROTOCOL_VERSION}"`]};
    }
    const extra = Object.keys(event).filter(key => key !== 'version' && key !== 'action');
    if (extra.length > 0)
      return {ok: false, errors: [`event must be an action event; got ${extra.join(', ')}`]};
    action = event.action;
  }
  if (!isRecord(action)) return {ok: false, errors: ['event.action must be an object']};
  const picked: Json = {};
  for (const field of ACTION_FIELDS) if (field in action) picked[field] = action[field];
  const message = {version: PROTOCOL_VERSION, action: picked};
  if (!validateWireEvent(message))
    return {ok: false, errors: formatAjvErrors(validateWireEvent.errors, 'event')};
  // Context values are user input; actions.ts validates their content per field.
  const sink = createSink();
  checkValueTree(picked.context, 'event.action.context', sink, 0, false);
  if (sink.errors.length > 0) return {ok: false, errors: sink.errors};
  return {ok: true, message: message as unknown as ActionEventMessage};
}

// ---------------------------------------------------------------------------
// Prompt material
// ---------------------------------------------------------------------------

/** Schemas for the components and functions the profile allows, for the system prompt. */
export function profileCatalogExcerpt(): {
  components: Record<string, Json>;
  functions: Record<string, Json>;
} {
  return {
    components: Object.fromEntries(
      ALLOWED_COMPONENTS.map(name => [name, catalogComponents[name] as Json]),
    ),
    functions: Object.fromEntries(
      ALLOWED_FUNCTIONS.map(name => [name, catalogFunctions[name] as Json]),
    ),
  };
}
