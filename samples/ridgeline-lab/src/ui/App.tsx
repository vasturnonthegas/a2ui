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
 * Ridgeline Lab shell.
 *
 * A grouped scenario list on the side and a workspace that renders one prompt
 * two ways: as A2UI v1.0 messages through the official React renderer, and as
 * Markdown. Recorded output loads automatically; live generation runs only
 * after the user opts in and asks for it. Form actions go to the server, which
 * stages a simulated write behind a confirmation step. No record is changed.
 */

import {AppShell} from '@astryxdesign/core/AppShell';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Grid} from '@astryxdesign/core/Grid';
import {Heading} from '@astryxdesign/core/Heading';
import {Layout, LayoutContent, LayoutHeader} from '@astryxdesign/core/Layout';
import {Spinner} from '@astryxdesign/core/Spinner';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Switch} from '@astryxdesign/core/Switch';
import {Text} from '@astryxdesign/core/Text';
import {Theme} from '@astryxdesign/core/theme';
import {Token} from '@astryxdesign/core/Token';
import {VisuallyHidden} from '@astryxdesign/core/VisuallyHidden';
import {type ReactNode, useCallback, useEffect, useRef, useState} from 'react';

import {A2uiPanel} from './A2uiPanel.js';
import {ActionLog, type LogEntry, type LogKind, makeLogEntry} from './ActionLog.js';
import {
  type ActionEvent,
  cancelAction,
  confirmAction,
  errorText,
  fetchScenarios,
  generate,
  type Generation,
  type GenerationMode,
  isAbort,
  type ScenarioSummary,
  sendAction,
} from './api.js';
import {ConfirmationCard, type PendingConfirmation} from './ConfirmationCard.js';
import {MarkdownPanel} from './MarkdownPanel.js';
import {MessageInspector} from './MessageInspector.js';
import {ScenarioNav} from './ScenarioNav.js';
import {labTheme} from './theme.js';

const MOBILE_WIDTH = 390;

type GenerationState =
  | {status: 'idle'}
  | {status: 'loading'; mode: GenerationMode}
  | {status: 'ready'; generation: Generation}
  | {status: 'error'; mode: GenerationMode; message: string};

/** A staged action. The token is held only here, in memory, for this tab. */
interface StagedConfirmation {
  scenarioId: string;
  token: string;
  pending: PendingConfirmation;
}

function readHash(): string | null {
  const id = decodeURIComponent(window.location.hash.replace(/^#/, ''));
  return id === '' ? null : id;
}

function useHashSelection(): string | null {
  const [hash, setHash] = useState(readHash);
  useEffect(() => {
    const onChange = () => setHash(readHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

function PanelCard({
  title,
  badge,
  headingId,
  children,
}: {
  title: string;
  badge: string;
  headingId: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={headingId}>
      <Card padding={5} height="100%">
        <VStack gap={4}>
          <HStack gap={2} vAlign="center" hAlign="between" wrap="wrap">
            <Heading level={2} id={headingId}>
              {title}
            </Heading>
            <Token size="sm" label={badge} />
          </HStack>
          {children}
        </VStack>
      </Card>
    </section>
  );
}

/** Constrains a panel to phone width for mobile scenarios. */
function MobileFrame({isMobile, children}: {isMobile: boolean; children: ReactNode}) {
  if (!isMobile) {
    return <>{children}</>;
  }
  return (
    <VStack gap={2} hAlign="center">
      <Text type="supporting">Mobile width · {MOBILE_WIDTH} px</Text>
      <VStack
        width="100%"
        maxWidth={MOBILE_WIDTH}
        padding={4}
        gap={3}
        style={{
          border: 'var(--border-width) solid var(--color-border)',
          borderRadius: 'var(--radius-page)',
          background: 'var(--color-background-surface)',
        }}
      >
        {children}
      </VStack>
    </VStack>
  );
}

function GenerationBody({
  state,
  render,
}: {
  state: GenerationState;
  render: (generation: Generation) => ReactNode;
}) {
  switch (state.status) {
    case 'idle':
      return <Text type="supporting">Choose a scenario to load its recorded output.</Text>;
    case 'loading':
      return (
        <Spinner
          size="lg"
          label={
            state.mode === 'live' ? 'Generating with the live model…' : 'Loading recorded output…'
          }
        />
      );
    case 'error':
      return (
        <Banner
          status="error"
          title={
            state.mode === 'live' ? 'Live generation failed' : 'Could not load recorded output'
          }
          description={state.message}
          collapsible={false}
        />
      );
    case 'ready':
      return <>{render(state.generation)}</>;
  }
}

export function App() {
  const [scenarios, setScenarios] = useState<ScenarioSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const hashId = useHashSelection();
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [state, setState] = useState<GenerationState>({status: 'idle'});
  const [staged, setStaged] = useState<StagedConfirmation | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [announcement, setAnnouncement] = useState('');

  const requestSeq = useRef(0);
  const inflight = useRef<AbortController | null>(null);
  const logSeq = useRef(0);

  const selected =
    scenarios?.find(s => s.id === hashId) ?? (hashId === null ? scenarios?.[0] : undefined) ?? null;
  const selectedId = selected?.id ?? null;
  const selectedIdRef = useRef<string | null>(selectedId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const appendLog = useCallback((kind: LogKind, summary: string, payload?: unknown) => {
    logSeq.current += 1;
    const entry = makeLogEntry(logSeq.current, kind, summary, payload);
    setLog(current => [...current, entry]);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchScenarios(controller.signal)
      .then(setScenarios)
      .catch((error: unknown) => {
        if (!isAbort(error)) {
          setListError(`Scenarios unavailable: ${errorText(error)}`);
        }
      });
    return () => controller.abort();
  }, []);

  /**
   * Starts a generation and drops any earlier one. A response is applied only
   * if it belongs to the latest request, so switching scenario or mode while a
   * request is pending never shows stale output.
   */
  const runGeneration = useCallback((scenarioId: string, mode: GenerationMode) => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    requestSeq.current += 1;
    const seq = requestSeq.current;
    setState({status: 'loading', mode});
    setAnnouncement(
      mode === 'live' ? 'Generating with the live model.' : 'Loading recorded output.',
    );

    generate(scenarioId, mode, controller.signal)
      .then(generation => {
        if (seq !== requestSeq.current) {
          return;
        }
        setState({status: 'ready', generation});
        setAnnouncement(
          generation.mode === 'live' ? 'Live output ready.' : 'Recorded output ready.',
        );
      })
      .catch((error: unknown) => {
        if (seq !== requestSeq.current || isAbort(error)) {
          return;
        }
        setState({status: 'error', mode, message: errorText(error)});
        setAnnouncement('Generation failed.');
      })
      .finally(() => {
        if (inflight.current === controller) {
          inflight.current = null;
        }
      });
  }, []);

  // Recorded output loads automatically whenever the scenario changes.
  useEffect(() => {
    if (selectedId !== null) {
      runGeneration(selectedId, 'stub');
    }
  }, [selectedId, runGeneration]);

  useEffect(() => () => inflight.current?.abort(), []);

  // A confirmation belongs to one scenario; drop it (and release it on the
  // server) when the user moves on.
  useEffect(() => {
    if (staged !== null && staged.scenarioId !== selectedId) {
      cancelAction(staged.pending.id, staged.token).catch(() => undefined);
      setStaged(null);
      appendLog(
        'cancelled',
        `Left the scenario, so staged action ${staged.pending.id} was cancelled.`,
      );
    }
  }, [selectedId, staged, appendLog]);

  const onLiveToggle = useCallback(
    (enabled: boolean) => {
      setLiveEnabled(enabled);
      if (!enabled && state.status !== 'idle' && selectedId !== null) {
        const showingLive =
          (state.status === 'ready' && state.generation.mode === 'live') ||
          (state.status !== 'ready' && state.mode === 'live');
        if (showingLive) {
          runGeneration(selectedId, 'stub');
        }
      }
    },
    [state, selectedId, runGeneration],
  );

  const onAction = useCallback(
    (event: ActionEvent) => {
      const scenarioId = selectedIdRef.current;
      if (scenarioId === null) {
        return;
      }
      appendLog(
        'event',
        `Sent “${event.action.name}” from ${event.action.sourceComponentId}.`,
        event,
      );
      sendAction(scenarioId, event)
        .then(result => {
          if (selectedIdRef.current !== scenarioId) {
            if (result.action) {
              cancelAction(result.action.id, result.action.token).catch(() => undefined);
            }
            return;
          }
          if (result.status === 'confirmation_required' && result.action) {
            const {token, ...visible} = result.action;
            setStaged({
              scenarioId,
              token,
              pending: {
                id: visible.id,
                actionName: event.action.name,
                expiresAt: visible.expiresAt,
                arguments: visible.arguments,
                message: result.message,
              },
            });
            appendLog('staged', result.message, result);
            setAnnouncement('Confirmation required.');
          } else {
            appendLog('drafted', result.message, result);
            setAnnouncement(result.message);
          }
        })
        .catch((error: unknown) => {
          appendLog('error', `Action rejected: ${errorText(error)}`);
        });
    },
    [appendLog],
  );

  const resolveStaged = useCallback(
    async (decision: 'confirm' | 'cancel') => {
      if (staged === null) {
        return;
      }
      const {id} = staged.pending;
      try {
        const result =
          decision === 'confirm'
            ? await confirmAction(id, staged.token)
            : await cancelAction(id, staged.token);
        appendLog(result.status, result.message, {id, status: result.status});
        setAnnouncement(result.message);
      } catch (error) {
        appendLog('error', `Could not ${decision} ${id}: ${errorText(error)}`);
      } finally {
        setStaged(null);
      }
    },
    [staged, appendLog],
  );

  const onConfirm = useCallback(() => resolveStaged('confirm'), [resolveStaged]);
  const onCancel = useCallback(() => resolveStaged('cancel'), [resolveStaged]);

  const shownMode: GenerationMode | null =
    state.status === 'ready' ? state.generation.mode : state.status === 'idle' ? null : state.mode;
  const isMobile = selected?.mobile === true;
  const isLoading = state.status === 'loading';

  const header = selected ? (
    <LayoutHeader hasDivider padding={6}>
      <VStack gap={4}>
        <VStack gap={1.5}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Token size="sm" label={selected.product} />
            {isMobile && <Token size="sm" label="Mobile layout" />}
            {shownMode === 'live' ? (
              <Token size="sm" color="blue" label="Live model output" />
            ) : (
              <Token size="sm" label="Recorded output" />
            )}
          </HStack>
          <Heading level={1}>{selected.title}</Heading>
          <Text type="supporting">{selected.description}</Text>
        </VStack>
        <HStack gap={4} vAlign="center" hAlign="between" wrap="wrap">
          <Switch
            label="Live model"
            description="Off by default. When on, generation calls the configured model with your server key."
            value={liveEnabled}
            onChange={onLiveToggle}
          />
          <HStack gap={2} wrap="wrap">
            <Button
              label="Reload recorded"
              variant="secondary"
              isDisabled={isLoading}
              onClick={() => runGeneration(selected.id, 'stub')}
            />
            <Button
              label="Generate live"
              variant="primary"
              isDisabled={!liveEnabled}
              isLoading={isLoading && shownMode === 'live'}
              tooltip={liveEnabled ? undefined : 'Turn on Live model first.'}
              onClick={() => runGeneration(selected.id, 'live')}
            />
          </HStack>
        </HStack>
      </VStack>
    </LayoutHeader>
  ) : (
    <LayoutHeader hasDivider padding={6}>
      <Heading level={1}>Ridgeline Lab</Heading>
    </LayoutHeader>
  );

  const content = (
    <LayoutContent padding={6} label="Workspace">
      <VStack gap={6}>
        {selected === null && scenarios !== null && hashId !== null && (
          <Banner
            status="warning"
            title="Unknown scenario"
            description={`No scenario named “${hashId}”. Pick one from the list.`}
            collapsible={false}
          />
        )}
        {selected && (
          <Card variant="muted" padding={4}>
            <VStack gap={1}>
              <Text type="label" color="secondary">
                Prompt (shared by both outputs)
              </Text>
              <Text as="p" display="block">
                {selected.prompt}
              </Text>
            </VStack>
          </Card>
        )}

        <Grid columns={{minWidth: 360, max: 2, repeat: 'fit'}} gap={4} align="stretch">
          <PanelCard title="A2UI" badge="v1.0 · Basic catalog" headingId="panel-a2ui">
            <MobileFrame isMobile={isMobile}>
              <GenerationBody
                state={state}
                render={generation => (
                  <A2uiPanel messages={generation.messages} onAction={onAction} />
                )}
              />
            </MobileFrame>
          </PanelCard>
          <PanelCard title="Markdown" badge="react-markdown · no HTML" headingId="panel-markdown">
            <MobileFrame isMobile={isMobile}>
              <GenerationBody
                state={state}
                render={generation => <MarkdownPanel markdown={generation.markdown} />}
              />
            </MobileFrame>
          </PanelCard>
        </Grid>

        {staged && (
          <ConfirmationCard pending={staged.pending} onConfirm={onConfirm} onCancel={onCancel} />
        )}

        <Grid columns={{minWidth: 360, max: 2, repeat: 'fit'}} gap={4} align="start">
          <PanelCard title="Message inspector" badge="raw JSON" headingId="panel-inspector">
            <GenerationBody
              state={state}
              render={generation => <MessageInspector generation={generation} />}
            />
          </PanelCard>
          <PanelCard title="Action log" badge="tokens redacted" headingId="panel-log">
            <ActionLog entries={log} />
          </PanelCard>
        </Grid>
      </VStack>
    </LayoutContent>
  );

  return (
    <Theme theme={labTheme} mode="system">
      <AppShell
        variant="surface"
        banner={
          <Banner
            status="info"
            container="section"
            title="Synthetic local demo"
            description="All projects, people, and records are invented. Actions are simulated and never change a real record."
            collapsible={false}
          />
        }
        sideNav={<ScenarioNav scenarios={scenarios} selectedId={selectedId} error={listError} />}
      >
        <Layout height="fill" header={header} content={content} />
        <VisuallyHidden as="div" role="status" aria-live="polite">
          {announcement}
        </VisuallyHidden>
      </AppShell>
    </Theme>
  );
}
