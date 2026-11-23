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
 * Narrow side navigation listing scenarios grouped by product.
 *
 * Each scenario is a hash link (`#<id>`), so selection is keyboard reachable,
 * shareable, and survives reloads.
 */

import {SideNav, SideNavHeading, SideNavItem, SideNavSection} from '@astryxdesign/core/SideNav';
import {Spinner} from '@astryxdesign/core/Spinner';
import {Text} from '@astryxdesign/core/Text';
import {Token} from '@astryxdesign/core/Token';

import type {Product, ScenarioSummary} from './api.js';

const PRODUCTS: readonly Product[] = ['Ridgeline', 'Cortex', 'LocalFlow'];

const PRODUCT_SUBTITLE: Record<Product, string> = {
  Ridgeline: 'Construction projects',
  Cortex: 'Decision records',
  LocalFlow: 'Meeting notes',
};

interface ScenarioNavProps {
  scenarios: readonly ScenarioSummary[] | null;
  selectedId: string | null;
  error: string | null;
}

export function ScenarioNav({scenarios, selectedId, error}: ScenarioNavProps) {
  return (
    <SideNav
      aria-label="Scenarios"
      resizable={{defaultWidth: 248, minWidth: 208, maxWidth: 340}}
      header={<SideNavHeading heading="Ridgeline Lab" subheading="A2UI vs Markdown" />}
      topContent={
        scenarios === null && error === null ? (
          <Spinner size="sm" label="Loading scenarios" />
        ) : error !== null ? (
          <Text type="supporting">{error}</Text>
        ) : null
      }
    >
      {PRODUCTS.map(product => {
        const items = (scenarios ?? []).filter(s => s.product === product);
        if (items.length === 0) {
          return null;
        }
        return (
          <SideNavSection key={product} title={product} subtitle={PRODUCT_SUBTITLE[product]}>
            {items.map(scenario => (
              <SideNavItem
                key={scenario.id}
                label={scenario.title}
                href={`#${scenario.id}`}
                isSelected={scenario.id === selectedId}
                endContent={
                  scenario.mobile ? <Token size="sm" color="blue" label="Mobile" /> : undefined
                }
              />
            ))}
          </SideNavSection>
        );
      })}
    </SideNav>
  );
}
