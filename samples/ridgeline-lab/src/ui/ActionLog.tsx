/**
 * Chronological log of action events and server replies, newest first.
 *
 * Payloads pass through `redact` before they are stored, so confirmation
 * tokens never appear here.
 */

import {CodeBlock} from '@astryxdesign/core/CodeBlock';
import {List, ListItem} from '@astryxdesign/core/List';
import {VStack} from '@astryxdesign/core/Stack';
import {StatusDot} from '@astryxdesign/core/StatusDot';
import {Text} from '@astryxdesign/core/Text';

import {redact} from './redact.js';

export type LogKind = 'event' | 'staged' | 'drafted' | 'confirmed' | 'cancelled' | 'error';

export interface LogEntry {
  seq: number;
  at: string;
  kind: LogKind;
  summary: string;
  payload?: unknown;
}

type DotVariant = 'success' | 'warning' | 'error' | 'accent' | 'neutral';

const KIND: Record<LogKind, {label: string; dot: DotVariant}> = {
  event: {label: 'Event sent', dot: 'accent'},
  staged: {label: 'Needs confirmation', dot: 'warning'},
  drafted: {label: 'Drafted (simulated)', dot: 'neutral'},
  confirmed: {label: 'Confirmed (simulated)', dot: 'success'},
  cancelled: {label: 'Cancelled', dot: 'neutral'},
  error: {label: 'Error', dot: 'error'},
};

/** Builds a log entry with its payload already redacted. */
export function makeLogEntry(
  seq: number,
  kind: LogKind,
  summary: string,
  payload?: unknown,
): LogEntry {
  return {
    seq,
    at: new Date().toISOString(),
    kind,
    summary,
    ...(payload === undefined ? {} : {payload: redact(payload)}),
  };
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

function newestFirst(entries: readonly LogEntry[]): LogEntry[] {
  return [...entries].sort((a, b) => b.seq - a.seq);
}

function LogRow({entry}: {entry: LogEntry}) {
  const kind = KIND[entry.kind];
  return (
    <ListItem
      align="first-line"
      startContent={<StatusDot variant={kind.dot} label={kind.label} />}
      label={
        <Text weight="medium" wordBreak="break-word">
          {kind.label}
        </Text>
      }
      endContent={
        <Text type="supporting" hasTabularNumbers>
          {formatClock(entry.at)}
        </Text>
      }
      description={
        <VStack gap={2}>
          <Text type="supporting" wordBreak="break-word">
            {entry.summary}
          </Text>
          {entry.payload !== undefined && (
            <CodeBlock
              code={JSON.stringify(entry.payload, null, 2)}
              language="json"
              size="sm"
              width="100%"
              maxHeight={220}
              isWrapped
              hasLanguageLabel={false}
            />
          )}
        </VStack>
      }
    />
  );
}

export function ActionLog({entries}: {entries: readonly LogEntry[]}) {
  if (entries.length === 0) {
    return (
      <Text type="supporting">
        Submit a form in the A2UI output to see its v1.0 action event here. Tokens are always
        redacted.
      </Text>
    );
  }
  return (
    <List hasDividers edge="flush" aria-label="Action log, newest first">
      {newestFirst(entries).map(entry => (
        <LogRow key={entry.seq} entry={entry} />
      ))}
    </List>
  );
}
