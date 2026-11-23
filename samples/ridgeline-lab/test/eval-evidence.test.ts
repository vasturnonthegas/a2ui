import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {BASIC_CATALOG_ID, renderEvidence, renderMarkdownEvidence} from '../src/eval/evidence.ts';

function surface(
  components: unknown[],
  dataModel: Record<string, unknown> = {},
  surfaceId = 'main',
) {
  return {
    version: '1.0',
    createSurface: {surfaceId, catalogId: BASIC_CATALOG_ID, components, dataModel},
  };
}

const heading = "RFI ${/rfi/id} due ${formatDate(value:${/rfi/due}, format:'MMM d, yyyy')}";

const punchForm = surface(
  [
    {
      id: 'root',
      component: 'Column',
      children: ['heading', 'items', 'title', 'priority', 'submit'],
    },
    {id: 'heading', component: 'Text', text: {'@call': 'formatString', args: {value: heading}}},
    {id: 'items', component: 'List', children: {path: '/rfi/items', componentId: 'item'}},
    {id: 'item', component: 'Text', text: {'@path': 'label'}},
    {id: 'title', component: 'TextField', label: 'Title', value: {'@path': '/form/title'}},
    {
      id: 'priority',
      component: 'ChoicePicker',
      label: 'Priority',
      options: [
        {label: 'High', value: 'high'},
        {label: 'Low', value: 'low'},
      ],
      value: {'@path': '/form/priority'},
    },
    {id: 'submitLabel', component: 'Text', text: 'Propose punch item'},
    {
      id: 'submit',
      component: 'Button',
      child: 'submitLabel',
      action: {
        event: {
          name: 'proposePunch',
          context: {
            title: {'@path': '/form/title'},
            priority: {'@path': '/form/priority'},
            recordId: 'HIDDEN-9999',
          },
        },
      },
    },
    {id: 'orphan', component: 'Text', text: 'ORPHAN-TEXT should never be visible'},
  ],
  {
    rfi: {
      id: 'RFI-0142',
      due: '2026-12-04',
      items: [{label: 'Anchor spacing'}, {label: 'Sealant type'}],
    },
    form: {title: 'Fix anchor', priority: ['high']},
    secretNote: 'UNBOUND-DATA should never be visible',
  },
);

describe('renderEvidence', () => {
  it('walks from root and resolves bindings, templates, and formatting functions', () => {
    const evidence = renderEvidence([punchForm]);
    assert.deepEqual(evidence.diagnostics, []);
    assert.deepEqual(
      evidence.lines.map(line => line.text),
      [
        '  RFI RFI-0142 due Dec 4, 2026',
        '    Anchor spacing',
        '    Sealant type',
        '  [input "Title"] value: "Fix anchor"',
        '  [choice "Priority"] options: High, Low; selected: High',
        '  [button "Propose punch item"] (sends to agent) submits: Title, Priority',
      ],
    );
    assert.deepEqual(
      evidence.lines.map(line => line.componentId),
      ['heading', 'item', 'item', 'title', 'priority', 'submit'],
    );
  });

  it('keeps unreachable components, unbound data, and protocol identifiers out', () => {
    const evidence = renderEvidence([punchForm]);
    for (const hidden of ['ORPHAN-TEXT', 'UNBOUND-DATA', 'HIDDEN-9999', 'proposePunch', 'main']) {
      assert.equal(evidence.text.includes(hidden), false, hidden);
    }
    assert.deepEqual(evidence.unreachable, {main: ['orphan']});
  });

  it('applies later data model and component updates in order', () => {
    const evidence = renderEvidence([
      punchForm,
      {version: '1.0', updateDataModel: {surfaceId: 'main', path: '/form/title', value: 'Reseal'}},
      {version: '1.0', updateDataModel: {surfaceId: 'main', path: '/rfi/items/1', value: null}},
      {
        version: '1.0',
        updateComponents: {
          surfaceId: 'main',
          components: [{id: 'heading', component: 'Text', text: 'Updated heading'}],
        },
      },
    ]);
    assert.equal(evidence.lines[0]?.text, '  Updated heading');
    assert.match(evidence.text, /value: "Reseal"/);
    assert.equal(evidence.text.includes('Sealant type'), false);
  });

  it('puts side-by-side Row children on one line', () => {
    const evidence = renderEvidence([
      surface([
        {id: 'root', component: 'Column', children: ['row', 'note']},
        {id: 'row', component: 'Row', children: ['task', 'owner']},
        {id: 'task', component: 'Text', text: 'Book inspection'},
        {id: 'owner', component: 'Text', text: 'Theo, due 2026-11-26'},
        {id: 'note', component: 'Text', text: 'Below the row'},
      ]),
    ]);
    assert.deepEqual(evidence.lines, [
      {surfaceId: 'main', componentId: 'row', text: '  Book inspection | Theo, due 2026-11-26'},
      {surfaceId: 'main', componentId: 'note', text: '  Below the row'},
    ]);
    assert.deepEqual(evidence.unreachable, {main: []});
  });

  it('drops deleted surfaces and labels multiple surfaces by ordinal only', () => {
    const one = surface([{id: 'root', component: 'Text', text: 'First'}], {}, 'a');
    const two = surface([{id: 'root', component: 'Text', text: 'Second'}], {}, 'b');
    const three = surface([{id: 'root', component: 'Text', text: 'Gone'}], {}, 'c');
    const evidence = renderEvidence([
      one,
      two,
      three,
      {version: '1.0', deleteSurface: {surfaceId: 'c'}},
    ]);
    assert.deepEqual(
      evidence.lines.map(line => line.text),
      ['[surface 1]', 'First', '[surface 2]', 'Second'],
    );
  });

  it('reports malformed input instead of rendering it', () => {
    assert.deepEqual(renderEvidence({not: 'an array'}).diagnostics, [
      'messages: expected an array of v1.0 messages',
    ]);
    const evidence = renderEvidence([
      {createSurface: {surfaceId: 'x'}},
      {version: '1.0', updateComponents: {surfaceId: 'missing', components: []}},
    ]);
    assert.deepEqual(evidence.diagnostics, [
      'messages[0]: not a v1.0 message',
      'messages[1]: updateComponents before createSurface',
    ]);
    assert.equal(evidence.text, '');
  });

  it('flags dangling children, cycles, unbound paths, and non-Basic components', () => {
    const evidence = renderEvidence([
      surface([
        {id: 'root', component: 'Column', children: ['missing', 'loop', 'unbound', 'custom']},
        {id: 'loop', component: 'Card', child: 'loop'},
        {id: 'unbound', component: 'Text', text: {'@path': '/nothing/here'}},
        {id: 'custom', component: 'Chart', data: []},
      ]),
    ]);
    assert.deepEqual(evidence.diagnostics, [
      'surface main/missing: child references a missing component',
      'surface main/loop: component cycle or excessive nesting',
      'surface main/unbound.text: binding resolved to no value',
      'surface main/custom: component type Chart is not in the Basic catalog',
    ]);
    assert.equal(evidence.text, '');
  });

  it('formats number precision the way the renderer does, flagging Intl range errors', () => {
    const formatNumber = (decimals: unknown) => ({
      '@call': 'formatNumber',
      args: {value: 1234.5, decimals},
    });
    const evidence = renderEvidence([
      surface(
        [
          {
            id: 'root',
            component: 'Column',
            children: ['floored', 'max', 'negative', 'tooMany', 'bound', 'inline', 'after'],
          },
          {id: 'floored', component: 'Text', text: formatNumber(2.7)},
          {id: 'max', component: 'Text', text: formatNumber(100)},
          {id: 'negative', component: 'Text', text: formatNumber(-1)},
          {id: 'tooMany', component: 'Text', text: formatNumber(101)},
          {id: 'bound', component: 'Text', text: formatNumber({'@path': '/precision'})},
          {
            id: 'inline',
            component: 'Text',
            text: {
              '@call': 'formatString',
              args: {value: 'Total ${formatNumber(value: 5, decimals: 200)} units'},
            },
          },
          {id: 'after', component: 'Text', text: 'Still rendered'},
        ],
        {precision: 101},
      ),
    ]);
    assert.deepEqual(
      evidence.lines.map(line => line.text),
      ['  1,234.50', `  1,234.5${'0'.repeat(99)}`, '  Total  units', '  Still rendered'],
    );
    assert.deepEqual(evidence.diagnostics, [
      'surface main/negative.text: formatNumber decimals -1 is outside 0 to 100, so the renderer shows no text',
      'surface main/tooMany.text: formatNumber decimals 101 is outside 0 to 100, so the renderer shows no text',
      'surface main/bound.text: formatNumber decimals 101 is outside 0 to 100, so the renderer shows no text',
      'surface main/inline.text: formatNumber decimals 200 is outside 0 to 100, so the renderer shows no text',
    ]);
  });

  it('flags surfaces that do not use the Basic catalog', () => {
    const evidence = renderEvidence([
      {
        version: '1.0',
        createSurface: {
          surfaceId: 's',
          catalogId: 'example.com:custom',
          components: [{id: 'root', component: 'Text', text: 'Hi'}],
        },
      },
    ]);
    assert.deepEqual(evidence.diagnostics, ['surface s: catalogId is not the v1.0 Basic catalog']);
  });
});

describe('renderMarkdownEvidence', () => {
  it('removes content that Markdown does not render', () => {
    const text = renderMarkdownEvidence(
      '# RFI-0142\n<!-- hidden RFI-9999 -->\nSee [the drawing](https://example.com/x) <span>now</span>',
    );
    assert.equal(text, '# RFI-0142\n\nSee the drawing now');
  });

  it('returns empty text for a non-string answer', () => {
    assert.equal(renderMarkdownEvidence(undefined), '');
  });
});
