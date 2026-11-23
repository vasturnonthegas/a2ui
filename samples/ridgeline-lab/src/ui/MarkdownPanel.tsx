/**
 * Renders the Markdown variant of a generation with react-markdown.
 *
 * Raw HTML is skipped, images are never fetched (their alt text is shown
 * instead), and links render as plain text with the target written out, so
 * source citations stay readable and no element references a remote resource.
 */

import {Blockquote} from '@astryxdesign/core/Blockquote';
import {CodeBlock} from '@astryxdesign/core/CodeBlock';
import {Divider} from '@astryxdesign/core/Divider';
import {Heading} from '@astryxdesign/core/Heading';
import {List, ListItem} from '@astryxdesign/core/List';
import {VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Children, isValidElement, type ReactNode} from 'react';
import Markdown, {type Components} from 'react-markdown';

// The panel title is an h2, so Markdown headings start one level below it.
function headingOf(level: 3 | 4 | 5) {
  return function MarkdownHeading({children}: {children?: ReactNode}) {
    return <Heading level={level}>{children}</Heading>;
  };
}

/** react-markdown puts newline text between list items; List expects only items. */
function listItems(children: ReactNode): ReactNode[] {
  return Children.toArray(children).filter(child => isValidElement(child));
}

const components: Components = {
  h1: headingOf(3),
  h2: headingOf(4),
  h3: headingOf(5),
  h4: headingOf(5),
  h5: headingOf(5),
  h6: headingOf(5),
  p({children}) {
    return (
      <Text as="p" display="block">
        {children}
      </Text>
    );
  },
  ul({children}) {
    return (
      <List listStyle="disc" density="compact">
        {listItems(children)}
      </List>
    );
  },
  ol({children, start}) {
    return (
      <List listStyle="decimal" density="compact" start={start ?? 1}>
        {listItems(children)}
      </List>
    );
  },
  li({children}) {
    return <ListItem label={<Text>{children}</Text>} align="first-line" />;
  },
  blockquote({children}) {
    return <Blockquote>{children}</Blockquote>;
  },
  hr() {
    return <Divider />;
  },
  // Links are shown as text, never as navigable anchors.
  a({children, href}) {
    const label = typeof children === 'string' ? children : undefined;
    return (
      <Text type="inherit" color="accent">
        {children}
        {href && href !== label ? ` (${href})` : null}
      </Text>
    );
  },
  // Images are never loaded; only their description is shown.
  img({alt}) {
    return <Text type="supporting">{`[image not loaded${alt ? `: ${alt}` : ''}]`}</Text>;
  },
  pre({children}) {
    const [child] = Children.toArray(children);
    const source =
      isValidElement<{children?: ReactNode}>(child) && typeof child.props.children === 'string'
        ? child.props.children
        : '';
    return <CodeBlock code={source.replace(/\n$/, '')} width="100%" size="sm" isWrapped />;
  },
  code({children}) {
    return <Text type="code">{children}</Text>;
  },
};

export function MarkdownPanel({markdown}: {markdown: string}) {
  return (
    <VStack gap={3}>
      <Markdown skipHtml components={components}>
        {markdown}
      </Markdown>
    </VStack>
  );
}
