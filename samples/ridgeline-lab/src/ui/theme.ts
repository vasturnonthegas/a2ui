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
 * Lab theme: calm neutrals, system type, and a single blue tint.
 *
 * Astryx tokens drive the host shell. The same tokens are forwarded to the A2UI
 * Basic catalog through its `--a2ui-*` custom properties (see `a2uiThemeVars`),
 * so both surfaces share one palette.
 */

import {defineTheme} from '@astryxdesign/core/theme';
import type {CSSProperties} from 'react';

const SYSTEM_FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, Roboto, "Helvetica Neue", sans-serif';
const SYSTEM_MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';

export const labTheme = defineTheme({
  name: 'ridgeline-lab',
  tokens: {
    '--color-accent': ['#0a66d8', '#4c9bff'],
    '--color-text-accent': ['#0a5cc2', '#6aacff'],
    '--color-background-body': ['#f5f5f7', '#101012'],
    '--color-background-surface': ['#fbfbfd', '#17171a'],
    '--color-background-card': ['#ffffff', '#1d1d21'],
    '--color-background-muted': ['#f0f0f3', '#232328'],
    '--color-border': ['#e2e2e7', '#2e2e34'],
    '--color-text-primary': ['#1d1d1f', '#f5f5f7'],
    '--color-text-secondary': ['#5f5f66', '#a1a1aa'],
    '--font-family-body': SYSTEM_FONT,
    '--font-family-heading': SYSTEM_FONT,
    '--font-family-code': SYSTEM_MONO,
    '--radius-container': '14px',
    '--radius-element': '9px',
  },
});

/**
 * Maps the Astryx tokens onto the Basic catalog's custom properties. Applied on
 * the element wrapping each A2UI surface.
 */
export const a2uiThemeVars = {
  '--a2ui-color-primary': 'var(--color-accent)',
  '--a2ui-color-on-primary': 'var(--color-on-accent)',
  '--a2ui-color-background': 'var(--color-background-card)',
  '--a2ui-color-on-background': 'var(--color-text-primary)',
  '--a2ui-color-surface': 'var(--color-background-muted)',
  '--a2ui-color-on-surface': 'var(--color-text-primary)',
  '--a2ui-color-input': 'var(--color-background-card)',
  '--a2ui-color-on-input': 'var(--color-text-primary)',
  '--a2ui-color-border': 'var(--color-border)',
  '--a2ui-border-radius': 'var(--radius-element)',
  '--a2ui-font-family-title': 'var(--font-family-heading)',
  '--a2ui-font-family-monospace': 'var(--font-family-code)',
  fontFamily: 'var(--font-family-body)',
} as CSSProperties;
