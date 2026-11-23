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
 * Raw view of the v1.0 messages the A2UI panel rendered.
 */

import {Badge} from '@astryxdesign/core/Badge';
import {CodeBlock} from '@astryxdesign/core/CodeBlock';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Token} from '@astryxdesign/core/Token';

import type {Generation} from './api.js';

export function MessageInspector({generation}: {generation: Generation}) {
  const count = generation.messages.length;
  return (
    <VStack gap={3}>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <HStack gap={1} vAlign="center">
          <Badge label={count} />
          <Text type="supporting">{count === 1 ? 'message' : 'messages'}</Text>
        </HStack>
        <Token size="sm" label={generation.model ?? 'Recorded fixture'} />
        {generation.repaired && <Token size="sm" label="Repaired once by the server" />}
      </HStack>
      <CodeBlock
        code={JSON.stringify(generation.messages, null, 2)}
        language="json"
        title="A2UI v1.0 messages"
        width="100%"
        maxHeight={420}
        hasLineNumbers
        isCollapsible
      />
    </VStack>
  );
}
