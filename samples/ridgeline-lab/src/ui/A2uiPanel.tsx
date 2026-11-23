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
 * Renders a generation's v1.0 messages with the official A2UI React renderer.
 *
 * One `MessageProcessor` from `@a2ui/web_core`, loaded with the v1 Basic
 * catalog, is created per message list and disposed when the list changes.
 * Surfaces render through `A2uiSurface` from `@a2ui/react`. User actions are
 * reshaped into the v1.0 renderer-to-agent `action` event and handed upward.
 */

import {A2uiSurface, MarkdownContext, type ReactCatalogComponent} from '@a2ui/react';
import {MessageProcessor, type ProcessableMessagePayload, type SurfaceModel} from '@a2ui/web_core';
import {basicCatalog} from '@a2ui/web_core/catalogs/basic/v1';
import {Banner} from '@astryxdesign/core/Banner';
import {VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {useEffect, useRef, useState} from 'react';

import {type ActionEvent, errorText} from './api.js';
import {safeMarkdownRenderer} from './markdown-renderer.js';
import {toActionEvent, toRendererMessages} from './renderer-compat.js';
import {a2uiThemeVars} from './theme.js';

type Surface = SurfaceModel<ReactCatalogComponent>;

interface A2uiPanelProps {
  messages: readonly unknown[];
  onAction: (event: ActionEvent) => void;
}

function surfaceKey(surface: Surface): string {
  return surface.id;
}

export function A2uiPanel({messages, onAction}: A2uiPanelProps) {
  const [surfaces, setSurfaces] = useState<Surface[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const onActionRef = useRef(onAction);

  useEffect(() => {
    onActionRef.current = onAction;
  }, [onAction]);

  useEffect(() => {
    const processor = new MessageProcessor<ReactCatalogComponent>(
      [basicCatalog],
      payload => {
        onActionRef.current(toActionEvent(payload));
      },
      {version: 'v1.0'},
    );
    const surfaceErrorSubs: Array<{unsubscribe(): void}> = [];
    const sync = () => setSurfaces(Array.from(processor.getSurfaces().values()));
    const created = processor.onSurfaceCreated(surface => {
      surfaceErrorSubs.push(
        surface.onError.subscribe(error => {
          setErrors(current => [...current, `${error.code}: ${error.message}`]);
        }),
      );
      sync();
    });
    const deleted = processor.onSurfaceDeleted(sync);

    setErrors([]);
    try {
      // Canonical "1.0" wires are adapted here only; see renderer-compat.ts.
      processor.processMessages(
        toRendererMessages(messages) as unknown as ProcessableMessagePayload,
      );
    } catch (error) {
      setErrors([errorText(error)]);
    }
    sync();

    return () => {
      created.unsubscribe();
      deleted.unsubscribe();
      for (const sub of surfaceErrorSubs) {
        sub.unsubscribe();
      }
      processor.dispose();
    };
  }, [messages]);

  return (
    <VStack gap={3} style={a2uiThemeVars}>
      {errors.length > 0 && (
        <Banner
          status="error"
          title="The renderer rejected part of this payload"
          description={errors.join(' · ')}
          collapsible={false}
        />
      )}
      {surfaces.length === 0 && errors.length === 0 && (
        <Text type="supporting">No surface was created by these messages.</Text>
      )}
      <MarkdownContext.Provider value={safeMarkdownRenderer}>
        {surfaces.map(surface => (
          <A2uiSurface key={surfaceKey(surface)} surface={surface} />
        ))}
      </MarkdownContext.Provider>
    </VStack>
  );
}
