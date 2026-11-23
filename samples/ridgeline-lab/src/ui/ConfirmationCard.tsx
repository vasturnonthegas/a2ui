/**
 * Confirmation step for a staged, simulated write.
 *
 * The server stages the action and returns an opaque token. This card shows
 * what would be written and lets the user confirm or cancel; neither path
 * changes a real record. The token stays with the caller and is never shown.
 */

import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Heading} from '@astryxdesign/core/Heading';
import {MetadataList, MetadataListItem} from '@astryxdesign/core/MetadataList';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Token} from '@astryxdesign/core/Token';
import {useEffect, useRef, useState} from 'react';

export interface PendingConfirmation {
  id: string;
  actionName: string;
  expiresAt: string;
  arguments: Record<string, unknown>;
  message: string;
}

interface ConfirmationCardProps {
  pending: PendingConfirmation;
  onConfirm: () => Promise<void>;
  onCancel: () => Promise<void>;
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(formatValue).join(', ');
  }
  if (typeof value === 'string') {
    return value === '' ? '(empty)' : value;
  }
  return JSON.stringify(value);
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString();
}

function useIsExpired(expiresAt: string): boolean {
  const [expired, setExpired] = useState(() => Date.parse(expiresAt) <= Date.now());
  useEffect(() => {
    const remaining = Date.parse(expiresAt) - Date.now();
    if (!(remaining > 0)) {
      setExpired(true);
      return;
    }
    setExpired(false);
    const timer = window.setTimeout(() => setExpired(true), remaining);
    return () => window.clearTimeout(timer);
  }, [expiresAt]);
  return expired;
}

export function ConfirmationCard({pending, onConfirm, onCancel}: ConfirmationCardProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const expired = useIsExpired(pending.expiresAt);
  const headingId = `confirm-${pending.id}-title`;

  // Move focus here when a new confirmation appears, so keyboard and screen
  // reader users land on the decision. This only runs when one is staged.
  useEffect(() => {
    headingRef.current?.focus();
  }, [pending.id]);

  return (
    <section aria-labelledby={headingId}>
      <Card elevation="low" padding={5}>
        <VStack gap={4}>
          <HStack gap={2} vAlign="center" hAlign="between" wrap="wrap">
            <Heading level={3} ref={headingRef} tabIndex={-1} id={headingId}>
              Confirm simulated action
            </Heading>
            <Token label="Simulated · no record is written" />
          </HStack>
          <Text type="supporting">{pending.message}</Text>
          <MetadataList label={{position: 'start', width: 120}}>
            <MetadataListItem label="Action">
              <Text type="code">{pending.actionName}</Text>
            </MetadataListItem>
            {Object.entries(pending.arguments).map(([key, value]) => (
              <MetadataListItem key={key} label={key}>
                <Text>{formatValue(value)}</Text>
              </MetadataListItem>
            ))}
            <MetadataListItem label="Expires">
              <Text color={expired ? 'secondary' : 'primary'}>
                {expired
                  ? `Expired at ${formatTime(pending.expiresAt)}`
                  : formatTime(pending.expiresAt)}
              </Text>
            </MetadataListItem>
          </MetadataList>
          <HStack gap={2} hAlign="end" wrap="wrap">
            <Button label="Cancel" variant="secondary" clickAction={onCancel} />
            <Button
              label="Confirm (simulated)"
              variant="primary"
              clickAction={onConfirm}
              isDisabled={expired}
              tooltip={expired ? 'This confirmation expired. Submit the form again.' : undefined}
            />
          </HStack>
        </VStack>
      </Card>
    </section>
  );
}
