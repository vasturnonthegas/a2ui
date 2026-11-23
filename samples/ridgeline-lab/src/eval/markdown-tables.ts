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
 * Reads GFM tables the way the lab's Markdown panel renders them.
 *
 * The document goes through the panel's parser (react-markdown with remark-gfm and raw HTML
 * skipped), and a rehype hook reads the table rows it produces, with their source offsets.
 * Only cells the panel renders are reported: a row keeps as many cells as the header has
 * columns, so cells past that count are dropped and short rows are padded with empty cells.
 */

import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export interface MarkdownTableRow {
  /** Source offset where the row starts, after any container prefix such as `> `. */
  start: number;
  /** Source offset where the row ends, before its line ending. */
  end: number;
  /** Visible text of each rendered cell, in column order. */
  cells: string[];
  /** Whether the source row has cells past the header's column count, which never render. */
  hasOverflow: boolean;
}

export interface MarkdownTable {
  start: number;
  end: number;
  /** The header row first, then body rows; the delimiter row is not a row. */
  rows: MarkdownTableRow[];
}

/** The parts of a HAST node that the table reader uses. */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: {alt?: unknown};
  children?: HastNode[];
  position?: {start: {offset?: number}; end: {offset?: number}};
}

/**
 * Text a HAST subtree shows, read the way the Markdown evidence reads it: elements are
 * unwrapped, a link shows its label, an image shows `[image: alt]`, and raw HTML is skipped.
 */
function hastText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  if (node.type === 'element' && node.tagName === 'img') {
    const alt = typeof node.properties?.alt === 'string' ? node.properties.alt : '';
    return alt ? `[image: ${alt}]` : '[image]';
  }
  return (node.children ?? []).map(hastText).join('');
}

function hastElements(node: HastNode, tagName: string): HastNode[] {
  const own = node.type === 'element' && node.tagName === tagName ? [node] : [];
  return [...own, ...(node.children ?? []).flatMap(child => hastElements(child, tagName))];
}

function readRow(row: HastNode): MarkdownTableRow | undefined {
  const start = row.position?.start.offset;
  const end = row.position?.end.offset;
  if (start === undefined || end === undefined) return undefined;
  const cells = (row.children ?? []).filter(
    cell => cell.type === 'element' && (cell.tagName === 'th' || cell.tagName === 'td'),
  );
  // Source cells are contiguous, so the last rendered cell reaches the end of the row unless
  // dropped cells follow it. Padding cells have no source position.
  const lastEnd = cells.findLast(cell => cell.position)?.position?.end.offset;
  return {
    start,
    end,
    cells: cells.map(hastText),
    hasOverflow: lastEnd !== undefined && lastEnd < end,
  };
}

/** Every GFM table the Markdown panel renders for `markdown`, in document order. */
export function parseMarkdownTables(markdown: string): MarkdownTable[] {
  const tables: HastNode[] = [];
  const capture = () => (tree: HastNode) => {
    tables.push(...hastElements(tree, 'table'));
  };
  renderToStaticMarkup(
    createElement(
      Markdown,
      {remarkPlugins: [remarkGfm], rehypePlugins: [capture], skipHtml: true},
      markdown,
    ),
  );
  return tables.flatMap(table => {
    const start = table.position?.start.offset;
    const end = table.position?.end.offset;
    if (start === undefined || end === undefined) return [];
    const rows = hastElements(table, 'tr')
      .map(readRow)
      .filter((row): row is MarkdownTableRow => row !== undefined);
    return [{start, end, rows}];
  });
}
