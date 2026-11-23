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
 * Builds judge evidence from what a user can actually see.
 *
 * The renderer applies v1.0 messages in order, walks each live surface from `root`, and
 * resolves `@path` bindings, template children, and Basic catalog formatting functions
 * against the surface data model. Components outside the reachable tree, unbound data
 * model values, surface IDs, action names, and literal action context values never reach
 * the evidence text.
 */

import {parseMarkdownTables} from './markdown-tables.ts';

export const BASIC_CATALOG_ID = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

const MAX_DEPTH = 64;
const MAX_TEMPLATE_ITEMS = 200;

export interface EvidenceLine {
  surfaceId: string;
  componentId: string;
  text: string;
}

export interface RenderedEvidence {
  text: string;
  lines: EvidenceLine[];
  /** Problems that change what the user sees, such as dangling children or unbound paths. */
  diagnostics: string[];
  /** Component IDs per surface that no path from `root` reaches. */
  unreachable: Record<string, string[]>;
  surfaces: string[];
}

type JsonRecord = Record<string, unknown>;

interface Surface {
  id: string;
  catalogId: string | undefined;
  components: Map<string, JsonRecord>;
  dataModel: unknown;
}

interface Scope {
  surface: Surface;
  /** JSON Pointer of the current template item, or '' at the surface root. */
  base: string;
  diagnostics: string[];
  /** Visible labels of reachable inputs, keyed by the absolute pointer their value binds to. */
  inputLabels: Map<string, string>;
  /** Buttons whose submitted-field description is filled in after the walk. */
  buttons: Array<{line: EvidenceLine; pointers: string[]}>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodePointer(pointer: string): string[] {
  if (pointer === '' || pointer === '/') return [];
  return pointer
    .replace(/^\//, '')
    .split('/')
    .map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getPointer(root: unknown, pointer: string): unknown {
  let current = root;
  for (const segment of decodePointer(pointer)) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (isRecord(current)) {
      current = Object.hasOwn(current, segment) ? current[segment] : undefined;
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Applies an `updateDataModel` write; a `null` value deletes the key or array item.
 *
 * Like web_core's `DataModel.set`, deleting an array item empties its slot instead of
 * shifting later items down, so an indexed binding such as `/crew/2/name` keeps showing the
 * same item. Deleting past the end of an array changes nothing.
 */
function setPointer(root: unknown, pointer: string, value: unknown): unknown {
  const segments = decodePointer(pointer);
  if (segments.length === 0) return value === null ? {} : structuredClone(value);
  const container: unknown = isRecord(root) || Array.isArray(root) ? root : {};
  let current: unknown = container;
  for (const [index, segment] of segments.entries()) {
    const target = current as JsonRecord;
    const arrayIndex = Array.isArray(current) && /^\d+$/.test(segment) ? Number(segment) : -1;
    if (index === segments.length - 1) {
      if (value !== null) target[segment] = structuredClone(value);
      else if (arrayIndex >= 0) {
        const items = current as unknown[];
        if (arrayIndex < items.length) items[arrayIndex] = undefined;
      } else delete target[segment];
      break;
    }
    const next = target[segment];
    if (!isRecord(next) && !Array.isArray(next)) target[segment] = {};
    current = target[segment];
  }
  return container;
}

function joinPointer(base: string, path: string): string {
  if (path.startsWith('/')) return path;
  if (path === '' || path === '.') return base;
  return `${base}/${path}`;
}

/** Converts a resolved value to the string a renderer would display. */
function display(value: unknown, scope: Scope, where: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (
    Array.isArray(value) &&
    value.every(item => typeof item === 'string' || typeof item === 'number')
  ) {
    return value.join(', ');
  }
  if (value === undefined || value === null) {
    scope.diagnostics.push(`${where}: binding resolved to no value`);
    return '';
  }
  scope.diagnostics.push(`${where}: binding resolved to a non-text value`);
  return '';
}

function resolve(value: unknown, scope: Scope, where: string): unknown {
  if (isRecord(value)) {
    const path = value['@path'];
    if (typeof path === 'string') {
      return getPointer(scope.surface.dataModel, joinPointer(scope.base, path));
    }
    if (typeof value['@call'] === 'string') return callFunction(value, scope, where);
  }
  return value;
}

function resolveText(value: unknown, scope: Scope, where: string): string {
  if (value === undefined) return '';
  return display(resolve(value, scope, where), scope, where);
}

function callFunction(call: JsonRecord, scope: Scope, where: string): unknown {
  const name = String(call['@call']);
  const args = isRecord(call.args) ? call.args : {};
  const arg = (key: string): unknown => resolve(args[key], scope, `${where}.${name}.${key}`);
  switch (name) {
    case 'formatString':
      return interpolate(String(arg('value') ?? ''), scope, where);
    case 'formatNumber':
      return formatNumber(arg('value'), arg('decimals'), arg('grouping'), scope, where);
    case 'formatCurrency':
      return formatCurrency(arg('value'), arg('currency'), arg('decimals'), arg('grouping'));
    case 'formatDate':
      return formatDate(arg('value'), String(arg('format') ?? ''), scope, where);
    case 'pluralize': {
      // Same precedence as web_core: an explicit zero/one/two form wins, then CLDR rules.
      const count = Number(arg('value'));
      const forms = ['zero', 'one', 'two', 'few', 'many', 'other'];
      const resolved: Record<string, unknown> = {};
      for (const form of forms) if (args[form] !== undefined) resolved[form] = arg(form);
      let category: string;
      if (count === 0 && resolved.zero !== undefined) category = 'zero';
      else if (count === 1 && resolved.one !== undefined) category = 'one';
      else if (count === 2 && resolved.two !== undefined) category = 'two';
      else category = new Intl.PluralRules('en-US').select(count);
      return resolved[category] ?? resolved.other ?? '';
    }
    default:
      scope.diagnostics.push(`${where}: function ${name} does not render as text`);
      return undefined;
  }
}

function toNumber(value: unknown): number | undefined {
  let parsed = Number.NaN;
  if (typeof value === 'number') parsed = value;
  else if (typeof value === 'string' && value.trim()) parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Mirrors web_core's formatNumber, which hands `decimals` to Intl unchanged. Intl floors a
 * fractional precision and rejects one outside 0 to 100; the renderer reports that as an
 * expression error and shows no text, so this records a diagnostic and returns empty text
 * rather than letting one malformed call abort the whole report.
 */
function formatNumber(
  value: unknown,
  decimals: unknown,
  grouping: unknown,
  scope: Scope,
  where: string,
): string {
  const amount = toNumber(value);
  if (amount === undefined) return '';
  const digits = toNumber(decimals);
  try {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: grouping !== false,
    }).format(amount);
  } catch {
    scope.diagnostics.push(
      `${where}: formatNumber decimals ${String(digits)} is outside 0 to 100, so the renderer shows no text`,
    );
    return '';
  }
}

function formatCurrency(
  value: unknown,
  currency: unknown,
  decimals: unknown,
  grouping: unknown,
): string {
  const amount = toNumber(value);
  if (amount === undefined || typeof currency !== 'string') return '';
  const digits = toNumber(decimals);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: grouping !== false,
    }).format(amount);
  } catch {
    return '';
  }
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DATE_TOKEN = /'([^']*)'|yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|E|HH|H|hh|h|mm|ss|a/g;

/** Formats a TR35 pattern in UTC so evidence is identical on every machine. */
function formatDate(value: unknown, pattern: string, scope: Scope, where: string): string {
  const date =
    typeof value === 'string' || typeof value === 'number' ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) {
    scope.diagnostics.push(`${where}: formatDate received an invalid date`);
    return '';
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  const hours = date.getUTCHours();
  const month = MONTHS[date.getUTCMonth()] ?? '';
  const weekday = WEEKDAYS[date.getUTCDay()] ?? '';
  const tokens: Record<string, () => string> = {
    yyyy: () => String(date.getUTCFullYear()),
    yy: () => pad(date.getUTCFullYear() % 100),
    MMMM: () => month,
    MMM: () => month.slice(0, 3),
    MM: () => pad(date.getUTCMonth() + 1),
    M: () => String(date.getUTCMonth() + 1),
    dd: () => pad(date.getUTCDate()),
    d: () => String(date.getUTCDate()),
    EEEE: () => weekday,
    E: () => weekday.slice(0, 3),
    HH: () => pad(hours),
    H: () => String(hours),
    hh: () => pad(hours % 12 || 12),
    h: () => String(hours % 12 || 12),
    mm: () => pad(date.getUTCMinutes()),
    ss: () => pad(date.getUTCSeconds()),
    a: () => (hours < 12 ? 'AM' : 'PM'),
  };
  return pattern.replace(DATE_TOKEN, (match: string, literal: string | undefined) =>
    literal !== undefined ? literal : (tokens[match]?.() ?? match),
  );
}

/** Resolves `${path}` and simple `${fn(key:value)}` expressions in a formatString template. */
function interpolate(template: string, scope: Scope, where: string): string {
  let output = '';
  let index = 0;
  while (index < template.length) {
    if (template.startsWith('\\${', index)) {
      output += '${';
      index += 3;
      continue;
    }
    if (!template.startsWith('${', index)) {
      output += template.charAt(index);
      index++;
      continue;
    }
    let depth = 1;
    let end = index + 2;
    while (end < template.length && depth > 0) {
      if (template.startsWith('${', end)) {
        depth++;
        end += 2;
        continue;
      }
      if (template.charAt(end) === '}') depth--;
      if (depth > 0) end++;
    }
    if (depth > 0) {
      scope.diagnostics.push(`${where}: unterminated formatString expression`);
      output += template.slice(index);
      break;
    }
    const value = evaluateExpression(template.slice(index + 2, end).trim(), scope, where);
    output += display(value, scope, where);
    index = end + 1;
  }
  return output;
}

function evaluateExpression(expression: string, scope: Scope, where: string): unknown {
  const call = /^([A-Za-z_]\w*)\((.*)\)$/s.exec(expression);
  if (!call) return getPointer(scope.surface.dataModel, joinPointer(scope.base, expression));
  const name = call[1] ?? '';
  const args: JsonRecord = {};
  for (const part of splitTopLevel(call[2] ?? '')) {
    const separator = part.indexOf(':');
    if (separator < 0) {
      scope.diagnostics.push(`${where}: formatString call ${name} has a positional argument`);
      return undefined;
    }
    const key = part.slice(0, separator).trim();
    const raw = part.slice(separator + 1).trim();
    if (/^'.*'$/s.test(raw)) args[key] = raw.slice(1, -1);
    else if (/^\$\{.*\}$/s.test(raw)) args[key] = {'@path': raw.slice(2, -1).trim()};
    else if (raw === 'true' || raw === 'false') args[key] = raw === 'true';
    else if (toNumber(raw) !== undefined) args[key] = Number(raw);
    else args[key] = {'@path': raw};
  }
  return callFunction({'@call': name, args}, scope, where);
}

function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const char of input) {
    if (char === "'") quoted = !quoted;
    if (!quoted && (char === '{' || char === '(')) depth++;
    if (!quoted && (char === '}' || char === ')')) depth--;
    if (!quoted && depth === 0 && char === ',') {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function applyMessages(messages: unknown, diagnostics: string[]): Map<string, Surface> {
  const surfaces = new Map<string, Surface>();
  if (!Array.isArray(messages)) {
    diagnostics.push('messages: expected an array of v1.0 messages');
    return surfaces;
  }
  const upsert = (surface: Surface, components: unknown, where: string) => {
    if (!Array.isArray(components)) return;
    for (const [index, component] of components.entries()) {
      if (!isRecord(component) || typeof component.id !== 'string') {
        diagnostics.push(`${where}.components[${index}]: component without a string id`);
        continue;
      }
      surface.components.set(component.id, component);
    }
  };
  for (const [index, message] of messages.entries()) {
    const where = `messages[${index}]`;
    if (!isRecord(message) || message.version !== '1.0') {
      diagnostics.push(`${where}: not a v1.0 message`);
      continue;
    }
    const {createSurface, updateComponents, updateDataModel, deleteSurface} = message;
    if (isRecord(createSurface)) {
      const id = String(createSurface.surfaceId);
      if (surfaces.has(id)) diagnostics.push(`${where}: surface ${id} created twice`);
      const {catalogId, dataModel} = createSurface;
      const surface: Surface = {
        id,
        catalogId: typeof catalogId === 'string' ? catalogId : undefined,
        components: new Map(),
        dataModel: isRecord(dataModel) ? structuredClone(dataModel) : {},
      };
      surfaces.set(id, surface);
      upsert(surface, createSurface.components, where);
    } else if (isRecord(updateComponents)) {
      const surface = surfaces.get(String(updateComponents.surfaceId));
      if (!surface) diagnostics.push(`${where}: updateComponents before createSurface`);
      else upsert(surface, updateComponents.components, where);
    } else if (isRecord(updateDataModel)) {
      const surface = surfaces.get(String(updateDataModel.surfaceId));
      const path = typeof updateDataModel.path === 'string' ? updateDataModel.path : '/';
      if (!surface) diagnostics.push(`${where}: updateDataModel before createSurface`);
      else surface.dataModel = setPointer(surface.dataModel, path, updateDataModel.value);
    } else if (isRecord(deleteSurface)) {
      surfaces.delete(String(deleteSurface.surfaceId));
    } else if (!('callRendererFunction' in message) && !('agentFunctionResponse' in message)) {
      diagnostics.push(`${where}: unsupported message type`);
    }
  }
  return surfaces;
}

/** Renders the visible text of an ordered list of v1.0 messages. */
export function renderEvidence(messages: unknown): RenderedEvidence {
  const diagnostics: string[] = [];
  const lines: EvidenceLine[] = [];
  const unreachable: Record<string, string[]> = {};
  const surfaces = applyMessages(messages, diagnostics);

  let ordinal = 0;
  for (const surface of surfaces.values()) {
    ordinal++;
    if (surface.catalogId !== BASIC_CATALOG_ID) {
      diagnostics.push(`surface ${surface.id}: catalogId is not the v1.0 Basic catalog`);
    }
    const visited = new Set<string>();
    const scope: Scope = {surface, base: '', diagnostics, inputLabels: new Map(), buttons: []};
    // Surface IDs are protocol identifiers; only an ordinal separates multiple surfaces.
    if (surfaces.size > 1) {
      lines.push({surfaceId: surface.id, componentId: '', text: `[surface ${ordinal}]`});
    }
    if (!surface.components.has('root')) {
      diagnostics.push(`surface ${surface.id}: no root component`);
    } else {
      renderComponent('root', scope, 0, new Set(), visited, lines);
    }
    for (const {line, pointers} of scope.buttons) {
      const labels = new Set<string>();
      for (const pointer of pointers) {
        const label = scope.inputLabels.get(pointer);
        if (label) labels.add(label);
      }
      if (labels.size) line.text += ` submits: ${[...labels].join(', ')}`;
    }
    unreachable[surface.id] = [...surface.components.keys()].filter(id => !visited.has(id)).sort();
  }

  const text = lines.map(line => line.text).join('\n');
  return {text, lines, diagnostics, unreachable, surfaces: [...surfaces.keys()]};
}

/** Collects the inline text of a subtree, used for button labels and modal triggers. */
function inlineText(id: string, scope: Scope, stack: Set<string>, visited: Set<string>): string {
  const collected: EvidenceLine[] = [];
  renderComponent(id, scope, 0, stack, visited, collected);
  return collected
    .map(line => line.text.trim())
    .filter(Boolean)
    .join(' ');
}

function quoted(value: string): string {
  return value ? ` "${value}"` : '';
}

function renderComponent(
  id: string,
  scope: Scope,
  depth: number,
  stack: Set<string>,
  visited: Set<string>,
  out: EvidenceLine[],
): void {
  const {surface} = scope;
  const where = `surface ${surface.id}/${id}`;
  const component = surface.components.get(id);
  if (!component) {
    scope.diagnostics.push(`${where}: child references a missing component`);
    return;
  }
  const frame = `${id}@${scope.base}`;
  if (stack.has(frame) || depth > MAX_DEPTH) {
    scope.diagnostics.push(`${where}: component cycle or excessive nesting`);
    return;
  }
  visited.add(id);
  const nextStack = new Set(stack).add(frame);
  const indent = '  '.repeat(depth);
  const emit = (text: string): EvidenceLine | undefined => {
    if (!text.trim()) return undefined;
    const line = {surfaceId: surface.id, componentId: id, text: `${indent}${text}`};
    out.push(line);
    return line;
  };
  const text = (key: string): string => resolveText(component[key], scope, `${where}.${key}`);
  const registerInput = (label: string) => {
    const binding = component.value;
    const path = isRecord(binding) ? binding['@path'] : undefined;
    if (label && typeof path === 'string') {
      scope.inputLabels.set(joinPointer(scope.base, path), label);
    }
  };
  const child = (childId: unknown, childDepth = depth + 1) => {
    if (typeof childId === 'string') {
      renderComponent(childId, scope, childDepth, nextStack, visited, out);
    }
  };
  const inline = (childId: unknown) =>
    typeof childId === 'string' ? inlineText(childId, scope, nextStack, visited) : '';

  const catalogOverride = component['@catalogId'];
  if (typeof catalogOverride === 'string' && catalogOverride !== BASIC_CATALOG_ID) {
    scope.diagnostics.push(`${where}: component uses a non-Basic catalog`);
    return;
  }

  const kind = component.component;
  switch (kind) {
    case 'Text':
      emit(text('text'));
      return;
    case 'Image': {
      const description = text('description');
      emit(description ? `[image: ${description}]` : '[image]');
      return;
    }
    case 'Video':
    case 'AudioPlayer': {
      const description = text('description');
      emit(`[${kind === 'Video' ? 'video' : 'audio'}${description ? `: ${description}` : ''}]`);
      return;
    }
    case 'Icon':
    case 'Divider':
      return;
    case 'Row':
      // Side-by-side children share one line, so layout stays visible in the evidence.
      if (Array.isArray(component.children)) {
        emit(component.children.map(inline).filter(Boolean).join(' | '));
        return;
      }
      renderChildren(component.children, scope, depth, nextStack, visited, out, where);
      return;
    case 'Column':
    case 'List':
      renderChildren(component.children, scope, depth, nextStack, visited, out, where);
      return;
    case 'Card':
      child(component.child, depth);
      return;
    case 'Tabs':
      if (Array.isArray(component.tabs)) {
        for (const [index, tab] of component.tabs.entries()) {
          if (!isRecord(tab)) continue;
          const title = resolveText(tab.title, scope, `${where}.tabs[${index}].title`);
          emit(`[tab${quoted(title)}]`);
          child(tab.child);
        }
      }
      return;
    case 'Modal':
      emit(`[modal opened by${quoted(inline(component.trigger)) || ' trigger'}]`);
      child(component.content);
      return;
    case 'Button': {
      const line = emit(
        `[button${quoted(inline(component.child))}]${actionKind(component.action)}`,
      );
      if (line) {
        scope.buttons.push({line, pointers: boundContextPointers(component.action, scope.base)});
      }
      return;
    }
    case 'TextField': {
      const label = text('label');
      const placeholder = text('placeholder');
      registerInput(label || placeholder);
      const hint = placeholder ? ` (placeholder: "${placeholder}")` : '';
      emit(`[input${quoted(label)}] value: "${text('value')}"${hint}`);
      return;
    }
    case 'CheckBox': {
      const label = text('label');
      registerInput(label);
      const checked = resolve(component.value, scope, `${where}.value`) === true;
      emit(`[checkbox${quoted(label)}] ${checked ? 'checked' : 'unchecked'}`);
      return;
    }
    case 'ChoicePicker': {
      const options = Array.isArray(component.options) ? component.options.filter(isRecord) : [];
      const selected = resolve(component.value, scope, `${where}.value`);
      const selectedValues = Array.isArray(selected) ? selected.map(String) : [];
      const labeled = options.map((option, index) => ({
        value: String(option.value),
        label: resolveText(option.label, scope, `${where}.options[${index}].label`),
      }));
      const all = labeled.map(option => option.label).join(', ');
      const chosen = labeled
        .filter(option => selectedValues.includes(option.value))
        .map(option => option.label)
        .join(', ');
      const label = text('label');
      registerInput(label);
      emit(`[choice${quoted(label)}] options: ${all}; selected: ${chosen || 'none'}`);
      return;
    }
    case 'Slider': {
      const min = typeof component.min === 'number' ? component.min : 0;
      const label = text('label');
      registerInput(label);
      emit(
        `[slider${quoted(label)}] value: ${text('value')} (range ${min}-${String(component.max)})`,
      );
      return;
    }
    case 'DateTimeInput': {
      const label = text('label');
      registerInput(label);
      emit(`[date input${quoted(label)}] value: "${text('value')}"`);
      return;
    }
    default:
      scope.diagnostics.push(
        `${where}: component type ${String(kind)} is not in the Basic catalog`,
      );
  }
}

function renderChildren(
  children: unknown,
  scope: Scope,
  depth: number,
  stack: Set<string>,
  visited: Set<string>,
  out: EvidenceLine[],
  where: string,
): void {
  if (Array.isArray(children)) {
    for (const childId of children) {
      if (typeof childId === 'string') {
        renderComponent(childId, scope, depth + 1, stack, visited, out);
      }
    }
    return;
  }
  const templateId = isRecord(children) ? children.componentId : undefined;
  const templatePath = isRecord(children) ? children.path : undefined;
  if (typeof templateId !== 'string' || typeof templatePath !== 'string') {
    scope.diagnostics.push(`${where}: children is neither an ID list nor a template`);
    return;
  }
  visited.add(templateId);
  const listPath = joinPointer(scope.base, templatePath);
  const items = getPointer(scope.surface.dataModel, listPath);
  if (!Array.isArray(items)) {
    scope.diagnostics.push(`${where}: template path ${templatePath} is not a list`);
    return;
  }
  if (items.length > MAX_TEMPLATE_ITEMS) {
    scope.diagnostics.push(`${where}: template truncated to ${MAX_TEMPLATE_ITEMS} items`);
  }
  const prefix = listPath === '/' ? '' : listPath;
  for (let index = 0; index < Math.min(items.length, MAX_TEMPLATE_ITEMS); index++) {
    const itemScope: Scope = {...scope, base: `${prefix}/${index}`};
    renderComponent(templateId, itemScope, depth + 1, stack, visited, out);
  }
}

/**
 * Says what kind of action a button has without exposing protocol names. Event names,
 * context keys, and literal context values are not visible to a user.
 */
function actionKind(action: unknown): string {
  if (!isRecord(action)) return '';
  if (isRecord(action.event)) return ' (sends to agent)';
  if (isRecord(action.functionCall) && action.functionCall['@call'] === 'openUrl') {
    return ' (opens link)';
  }
  return '';
}

/** Absolute pointers an event's context binds to, so they can be named by input label. */
function boundContextPointers(action: unknown, base: string): string[] {
  if (!isRecord(action) || !isRecord(action.event) || !isRecord(action.event.context)) return [];
  const pointers: string[] = [];
  for (const value of Object.values(action.event.context)) {
    const path = isRecord(value) ? value['@path'] : undefined;
    if (typeof path === 'string') pointers.push(joinPointer(base, path));
  }
  return pointers;
}

/**
 * Escapes table cell text so it parses back as the same literal text, and so the link,
 * image, comment, and tag rewrites in `renderMarkdownEvidence` cannot match it: Markdown
 * punctuation gets a backslash and `<` becomes a character reference.
 */
function literalCell(text: string): string {
  return text.replace(/[\\`*_~[\]()|!&]/g, '\\$&').replace(/</g, '&lt;');
}

/**
 * Rewrites each GFM table row that has cells past the header's column count as a row of only
 * the cells the Markdown panel renders, so dropped cells never reach the evidence. This runs
 * on the raw answer because the later rewrites can remove a pipe inside link or HTML syntax,
 * which would pull a dropped cell back into the table. The rewritten row stays on its line,
 * and every other row and line is unchanged.
 */
function withoutDroppedCells(markdown: string): string {
  const rows = parseMarkdownTables(markdown)
    .flatMap(table => table.rows)
    .filter(row => row.hasOverflow);
  let text = markdown;
  for (const row of rows.reverse()) {
    const cells = row.cells.map(literalCell).join(' | ');
    text = `${text.slice(0, row.start)}| ${cells} |${text.slice(row.end)}`;
  }
  return text;
}

/**
 * Returns the visible text of a Markdown answer. HTML comments and raw tags do not render,
 * so they are removed; link and image targets are dropped in favor of their visible labels.
 * Table cells that the panel drops are removed first.
 */
export function renderMarkdownEvidence(markdown: unknown): string {
  if (typeof markdown !== 'string') return '';
  return withoutDroppedCells(markdown)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<[^>\n]+>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match: string, alt: string) =>
      alt ? `[image: ${alt}]` : '[image]',
    )
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
