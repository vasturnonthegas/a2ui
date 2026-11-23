/**
 * Markdown renderer handed to the A2UI Basic catalog's `Text` component.
 *
 * Wraps the official `@a2ui/markdown-it` renderer (markdown-it with raw HTML
 * disabled, then DOMPurify). The demo profile forbids links and remote media,
 * so after sanitizing, every link becomes plain text with its target written
 * out, every media element becomes a text placeholder, and no element keeps an
 * attribute other than `class`.
 */

import {renderMarkdown} from '@a2ui/markdown-it';
import type {MarkdownRenderer} from '@a2ui/web_core';

const MEDIA = 'img, picture, video, audio, source, track, iframe, embed, object, svg, math';

function textNode(doc: Document, text: string): Text {
  return doc.createTextNode(text);
}

/** Returns sanitized HTML with links and media replaced by plain text. */
export function stripLinksAndMedia(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const body = doc.body;

  for (const media of Array.from(body.querySelectorAll(MEDIA))) {
    const alt = media.getAttribute('alt') ?? '';
    media.replaceWith(textNode(doc, `[media not loaded${alt ? `: ${alt}` : ''}]`));
  }

  for (const link of Array.from(body.querySelectorAll('a'))) {
    const href = link.getAttribute('href') ?? '';
    const label = link.textContent ?? '';
    const span = doc.createElement('span');
    span.textContent = href && href !== label ? `${label} (${href})` : label;
    link.replaceWith(span);
  }

  for (const element of Array.from(body.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name !== 'class') {
        element.removeAttribute(attribute.name);
      }
    }
  }

  return body.innerHTML;
}

export const safeMarkdownRenderer: MarkdownRenderer = async (markdown, options) =>
  stripLinksAndMedia(await renderMarkdown(markdown, options));
