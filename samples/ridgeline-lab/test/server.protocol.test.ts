import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {validateMessages} from '../src/agent.ts';
import {BASIC_CATALOG_ID, validateActionEvent, validateMarkdown} from '../src/protocol.ts';
import {findScenario, scenarios} from '../src/scenarios.ts';

type Component = Record<string, unknown>;

function surface(components: Component[], extra: Record<string, unknown> = {}): unknown[] {
  return [
    {
      version: '1.0',
      createSurface: {surfaceId: 's', catalogId: BASIC_CATALOG_ID, components, ...extra},
    },
  ];
}

const okTree: Component[] = [
  {id: 'root', component: 'Column', children: ['title']},
  {id: 'title', component: 'Text', text: '## Hello'},
];

function expectError(
  messages: unknown,
  pattern: RegExp,
  options?: Parameters<typeof validateMessages>[1],
): void {
  const errors = validateMessages(messages, options);
  assert.ok(
    errors.some(error => pattern.test(error)),
    `expected an error matching ${pattern}, got:\n${errors.join('\n') || '(none)'}`,
  );
}

describe('validateMessages', () => {
  it('accepts every scenario stub under its scenario profile', () => {
    for (const scenario of scenarios) {
      const allowedActions =
        scenario.id === 'punch-proposal'
          ? ['proposePunch']
          : scenario.id === 'daily-log'
            ? ['draftDailyLog']
            : [];
      assert.deepEqual(
        validateMessages(scenario.stub.messages, {surfaceId: scenario.id, allowedActions}),
        [],
        scenario.id,
      );
      assert.deepEqual(validateMarkdown(scenario.stub.markdown), [], `${scenario.id} markdown`);
    }
  });

  it('accepts a minimal tree and a list template with relative bindings', () => {
    assert.deepEqual(validateMessages(surface(okTree)), []);
    const templated = surface(
      [
        {id: 'root', component: 'List', children: {componentId: 'row', path: '/items'}},
        {id: 'row', component: 'Text', text: {'@path': 'label'}},
      ],
      {dataModel: {items: [{label: 'One'}]}},
    );
    assert.deepEqual(validateMessages(templated), []);
  });

  it('enforces the official v1.0 wire schema', () => {
    expectError(
      [
        {
          version: '0.9',
          createSurface: {surfaceId: 's', catalogId: BASIC_CATALOG_ID, components: okTree},
        },
      ],
      /version/,
    );
    expectError(
      surface([...okTree, {id: 'x', component: 'Text', text: 'a', color: 'red'}]),
      /unknown property "color"/,
    );
    expectError(
      surface([{id: 'root', component: 'Marquee', text: 'hi'}]),
      /unknown component type "Marquee"/,
    );
    expectError(
      surface([{id: 'root', component: 'Text', text: 'a', variant: 'h1'}]),
      /must be one of/,
    );
  });

  it('enforces the strict demo profile', () => {
    expectError(
      surface([{id: 'root', component: 'Image', url: 'https://example.test/a.png'}]),
      /component "Image"/,
    );
    expectError(surface([{id: 'root', component: 'Text', text: '<b>bold</b>'}]), /raw HTML/);
    expectError(
      surface([{id: 'root', component: 'Text', text: 'see [docs](https://x.test)'}]),
      /URL|link/,
    );
    expectError(surface(okTree, {dataModel: {site: 'www.example.test'}}), /URL/);
    expectError(
      surface([
        {id: 'root', component: 'Text', text: {'@call': 'openUrl', args: {url: 'https://x.test'}}},
      ]),
      /openUrl/,
    );
    expectError(surface(okTree, {sendDataModel: true}), /sendDataModel/);
    expectError(
      [...surface(okTree), {version: '1.0', deleteSurface: {surfaceId: 's'}}],
      /deleteSurface/,
    );
    expectError(
      [
        {
          version: '1.0',
          callRendererFunction: {
            functionCallId: 'c1',
            callFunction: {'@call': 'required', catalogId: BASIC_CATALOG_ID, args: {value: 'x'}},
          },
        },
      ],
      /callRendererFunction/,
    );
    expectError(surface(okTree), /surfaceId must be "other"/, {surfaceId: 'other'});
    expectError(
      [
        {
          version: '1.0',
          createSurface: {
            surfaceId: 's',
            catalogId: 'https://evil.test/catalog.json',
            components: okTree,
          },
        },
      ],
      /catalogId must be/,
    );
    assert.deepEqual(
      validateMessages(surface(okTree, {dataModel: {note: 'Weather data: snow'}})),
      [],
    );
  });

  it('allows only allowlisted agent events with exact context keys', () => {
    const button = (action: unknown): Component[] => [
      {id: 'root', component: 'Column', children: ['field', 'go']},
      {id: 'field', component: 'TextField', label: 'Title', value: {'@path': '/f/title'}},
      {id: 'go', component: 'Button', child: 'goLabel', action},
      {id: 'goLabel', component: 'Text', text: 'Go'},
    ];
    expectError(surface(button({event: {name: 'deleteProject', context: {}}})), /not allowlisted/);
    expectError(
      surface(button({functionCall: {'@call': 'required', args: {value: 'x'}}})),
      /local function/,
    );
    expectError(
      surface(button({event: {name: 'draftDailyLog', context: {notes: {'@path': '/f/title'}}}})),
      /exactly the keys logDate, notes/,
    );
    expectError(
      surface(
        button({
          event: {
            name: 'proposePunch',
            context: {title: {'@path': '/f/title'}, description: 'd', priority: 'low'},
          },
        }),
      ),
      /not allowlisted \(allowed: none/,
      {allowedActions: []},
    );
  });

  it('requires editable action context to come from the bound input controls', () => {
    const logForm = (context: Record<string, unknown>): Component[] => [
      {id: 'root', component: 'Column', children: ['date', 'notes', 'shown', 'go']},
      {id: 'date', component: 'DateTimeInput', label: 'Date', value: {'@path': '/log/date'}},
      {id: 'notes', component: 'TextField', label: 'Notes', value: {'@path': '/log/notes'}},
      {id: 'shown', component: 'Text', text: {'@path': '/log/summary'}},
      {
        id: 'go',
        component: 'Button',
        child: 'goLabel',
        action: {event: {name: 'draftDailyLog', context}},
      },
      {id: 'goLabel', component: 'Text', text: 'Draft'},
    ];
    const dataModel = {log: {date: '2026-11-23', notes: 'Snow.', summary: 'Snow day'}};
    const options = {allowedActions: ['draftDailyLog']};
    assert.deepEqual(
      validateMessages(
        surface(logForm({logDate: {'@path': '/log/date'}, notes: {'@path': '/log/notes'}}), {
          dataModel,
        }),
        options,
      ),
      [],
    );
    // A literal would submit a fixed string instead of the user's edit.
    expectError(
      surface(logForm({logDate: '2026-11-23', notes: {'@path': '/log/notes'}}), {dataModel}),
      /context\.logDate must be a data binding to the input that edits it/,
      options,
    );
    // Data the user can see but not edit is not an input binding.
    expectError(
      surface(logForm({logDate: {'@path': '/log/date'}, notes: {'@path': '/log/summary'}}), {
        dataModel,
      }),
      /context\.notes binds \/log\/summary, which no input component edits/,
      options,
    );
    // Two fields bound to one control would send the same edit twice.
    expectError(
      surface(logForm({logDate: {'@path': '/log/date'}, notes: {'@path': '/log/date'}}), {
        dataModel,
      }),
      /binds \/log\/date, which is already bound to "logDate"/,
      options,
    );
    // The check runs on the final surface, so a later updateComponents is covered too.
    expectError(
      [
        ...surface(logForm({logDate: {'@path': '/log/date'}, notes: {'@path': '/log/notes'}}), {
          dataModel,
        }),
        {
          version: '1.0',
          updateComponents: {
            surfaceId: 's',
            components: [{id: 'notes', component: 'Text', text: {'@path': '/log/notes'}}],
          },
        },
      ],
      /context\.notes binds \/log\/notes, which no input component edits/,
      options,
    );
  });

  it('checks component graph and data binding integrity', () => {
    expectError(
      surface([{id: 'main', component: 'Text', text: 'x'}]),
      /no component with id "root"/,
    );
    expectError(
      surface([{id: 'root', component: 'Card', child: 'ghost'}]),
      /missing component "ghost"/,
    );
    expectError(
      surface([...okTree, {id: 'stray', component: 'Text', text: 'x'}]),
      /"stray" is not reachable/,
    );
    expectError(
      surface([
        {id: 'root', component: 'Column', children: ['a']},
        {id: 'a', component: 'Card', child: 'b'},
        {id: 'b', component: 'Card', child: 'a'},
      ]),
      /cycle|more than one parent/,
    );
    expectError(
      surface([
        {id: 'root', component: 'Column', children: ['t', 't2']},
        {id: 't', component: 'Text', text: 'x'},
        {id: 't2', component: 'Card', child: 't'},
      ]),
      /more than one parent/,
    );
    expectError(
      surface([{id: 'root', component: 'Text', text: {'@path': '/missing'}}]),
      /\/missing, which is not in the data model/,
    );
    expectError(
      surface([{id: 'root', component: 'Text', text: {'@path': 'label'}}]),
      /outside a list template/,
    );
    expectError(
      surface([
        {id: 'root', component: 'List', children: {componentId: 'r', path: '/items'}},
        {id: 'r', component: 'Text', text: 'x'},
      ]),
      /not a list in the data model/,
    );
    expectError(
      surface([...okTree, {id: 'title', component: 'Text', text: 'dup'}]),
      /duplicates a component ID/,
    );
  });

  it('applies updateComponents and updateDataModel in order', () => {
    const messages = [
      ...surface([{id: 'root', component: 'Text', text: {'@path': '/greeting'}}], {dataModel: {}}),
      {version: '1.0', updateDataModel: {surfaceId: 's', path: '/greeting', value: 'Hi'}},
    ];
    assert.deepEqual(validateMessages(messages), []);
    expectError(
      [{version: '1.0', updateComponents: {surfaceId: 's', components: okTree}}],
      /before a createSurface/,
    );
  });

  it('rejects reserved keys from JSON input', () => {
    const parsed = JSON.parse('{"__proto__": {"x": 1}}') as Record<string, unknown>;
    expectError(surface(okTree, {dataModel: parsed}), /reserved key "__proto__"/);
  });

  it('rejects reserved updateDataModel path segments without applying them', () => {
    const marker = 'ridgelineReservedPathMarker';
    for (const path of [
      `/__proto__/${marker}`,
      `/constructor/prototype/${marker}`,
      `/items/__proto__`,
    ]) {
      const messages = [
        ...surface(okTree, {dataModel: {}}),
        {version: '1.0', updateDataModel: {surfaceId: 's', path, value: 'x'}},
      ];
      expectError(messages, /reserved key "(__proto__|constructor)"/);
      assert.equal(Object.hasOwn(Object.prototype, marker), false, path);
      assert.equal(({} as Record<string, unknown>)[marker], undefined, path);
    }
  });
});

describe('validateMarkdown', () => {
  it('rejects HTML, links, and images', () => {
    assert.match(validateMarkdown('<script>alert(1)</script>').join(), /raw HTML/);
    assert.match(validateMarkdown('![x](y.png)').join(), /link or image/);
    assert.match(validateMarkdown('Email ops@example.test').join(), /URL/);
    assert.deepEqual(validateMarkdown('| a | b |\n| --- | --- |\n| 1 < 2 | **ok** |'), []);
  });
});

describe('validateActionEvent', () => {
  const payload = {
    name: 'proposePunch',
    surfaceId: 'punch-proposal',
    sourceComponentId: 'proposeButton',
    timestamp: '2026-11-23T16:00:00.000Z',
    context: {title: 'T', description: 'D', priority: ['medium']},
  };

  it('accepts the v1.0 envelope, the library version spelling, and a bare ActionPayload', () => {
    for (const event of [
      {version: '1.0', action: payload},
      {version: 'v1.0', action: payload},
      {...payload, catalogId: 'x'},
    ]) {
      const result = validateActionEvent(event);
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(result.message.version, '1.0');
      assert.deepEqual(Object.keys(result.message.action).sort(), Object.keys(payload).sort());
    }
  });

  it('rejects events that do not match renderer_to_agent.json', () => {
    const {timestamp: _omitted, ...noTimestamp} = payload;
    assert.equal(validateActionEvent({version: '1.0', action: noTimestamp}).ok, false);
    assert.equal(
      validateActionEvent({version: '1.0', action: {...payload, timestamp: 'yesterday'}}).ok,
      false,
    );
    assert.equal(validateActionEvent({version: '1.0', action: payload, extra: true}).ok, false);
    assert.equal(validateActionEvent({version: '0.9', action: payload}).ok, false);
    assert.equal(validateActionEvent('proposePunch').ok, false);
  });

  it('rejects reserved keys in the resolved context', () => {
    const context = JSON.parse('{"title": "T", "__proto__": {"polluted": true}}') as Record<
      string,
      unknown
    >;
    assert.equal(validateActionEvent({...payload, context}).ok, false);
  });

  it('finds every scenario by id', () => {
    for (const id of [
      'rfi-triage',
      'project-brief',
      'punch-proposal',
      'daily-log',
      'decision-card',
      'meeting-actions',
    ]) {
      assert.ok(findScenario(id), id);
    }
  });
});
