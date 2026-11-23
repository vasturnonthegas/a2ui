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
 * Server-renders MarkdownPanel to check that GFM tables become real table
 * rows and cells, while raw HTML, links and images keep their safe rendering.
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

import {findScenario} from '../src/scenarios.ts';
import {MarkdownPanel} from '../src/ui/MarkdownPanel.tsx';

function render(markdown: string): string {
  return renderToStaticMarkup(createElement(MarkdownPanel, {markdown}));
}

/** Text content of every element with the given tag, in document order. */
function cellsOf(html: string, tag: 'th' | 'td'): string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  return [...html.matchAll(pattern)].map(([, inner]) => {
    assert.ok(inner !== undefined, `<${tag}> match has a content capture`);
    return inner.replace(/<[^>]+>/g, '').trim();
  });
}

describe('MarkdownPanel', () => {
  it('renders the recorded meeting actions as table cells', () => {
    const scenario = findScenario('meeting-actions');
    assert.ok(scenario, 'meeting-actions scenario exists');
    const html = render(scenario.stub.markdown);

    assert.match(html, /<table\b/);
    assert.deepEqual(cellsOf(html, 'th'), ['Action', 'Owner', 'Due']);
    assert.deepEqual(cellsOf(html, 'td'), [
      'Send written window delivery confirmation',
      'Marcus Oyelaran',
      '2026-11-24',
      'Answer shower niche RFI-034',
      'Lena Brandt',
      '2026-11-25',
      'Book framing inspection for the week of 2026-12-01',
      'Theo Castellanos',
      '2026-11-26',
    ]);
    assert.doesNotMatch(html, /\| --- \|/);
  });

  it('keeps links, images and raw HTML inert inside table cells', () => {
    const html = render(
      [
        '| Source | Photo | Note |',
        '| --- | --- | --- |',
        '| [spec](https://example.com/spec) | ![crack](https://example.com/c.png) | <b>bold</b> |',
        '',
        'Outside: [doc](https://example.com/doc) <script>alert(1)</script>',
      ].join('\n'),
    );

    assert.deepEqual(cellsOf(html, 'td'), [
      'spec (https://example.com/spec)',
      '[image not loaded: crack]',
      'bold',
    ]);
    assert.doesNotMatch(html, /<a\b/);
    assert.doesNotMatch(html, /<img\b/);
    assert.doesNotMatch(html, /<b>|<script/);
    assert.match(html, /doc \(https:\/\/example\.com\/doc\)/);
  });
});
