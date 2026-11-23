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
 * Ridgeline Lab evaluation CLI.
 *
 *   npm run eval                          recorded stub output, canned fixture grades, no network
 *   npm run eval -- --live                live Fireworks generation, live jev-1.14.0 per variant
 *   npm run eval -- --live --judge-only   recorded stub output, live judge, no Fireworks call
 *
 * Other flags: --scenario <id> (repeatable or comma-separated), --variant a2ui|markdown,
 * --checks-only (skip the judge), --print-evidence, --out <dir>, --help.
 */

import {fileURLToPath, pathToFileURL} from 'node:url';

import {actionsForScenario} from './actions.ts';
import {generate, validateMessages} from './agent.ts';
import {createJudge, loadFixtures, loadPricing, MODEL} from './eval/judge.ts';
import type {Judge} from './eval/judge.ts';
import {writeReports} from './eval/report.ts';
import {runEval, UnknownScenarioError} from './eval/run.ts';
import type {Variant} from './eval/types.ts';
import {VARIANTS} from './eval/types.ts';
import {scenarios} from './scenarios.ts';
import type {Scenario} from './scenarios.ts';

/** Validates a surface with the same per-scenario options that `generate` applies. */
export function validateForScenario(messages: unknown, scenario: Scenario): string[] {
  return validateMessages(messages, {
    surfaceId: scenario.id,
    allowedActions: actionsForScenario(scenario.id).map(spec => spec.name),
  });
}

export interface CliOptions {
  help: boolean;
  live: boolean;
  judgeOnly: boolean;
  checksOnly: boolean;
  printEvidence: boolean;
  scenarioIds: string[];
  variants: Variant[];
  outDir: string;
}

export class CliUsageError extends Error {}

export const USAGE = [
  'usage: npm run eval -- [--live] [--judge-only | --checks-only] [--scenario <id>]...',
  '                       [--variant a2ui|markdown] [--print-evidence] [--out <dir>]',
].join('\n');

const DEFAULT_OUT_DIR = fileURLToPath(new URL('../reports/', import.meta.url));

function isVariant(value: string): value is Variant {
  return (VARIANTS as readonly string[]).includes(value);
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    help: false,
    live: false,
    judgeOnly: false,
    checksOnly: false,
    printEvidence: false,
    scenarioIds: [],
    variants: [],
    outDir: DEFAULT_OUT_DIR,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? '';
    const equals = arg.indexOf('=');
    const flag = equals >= 0 ? arg.slice(0, equals) : arg;
    const take = (): string => {
      if (equals >= 0) return arg.slice(equals + 1);
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new CliUsageError(`missing value for ${flag}`);
      index++;
      return next;
    };
    switch (flag) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--live':
        options.live = true;
        break;
      case '--judge-only':
        options.judgeOnly = true;
        break;
      case '--checks-only':
        options.checksOnly = true;
        break;
      case '--print-evidence':
        options.printEvidence = true;
        break;
      case '--scenario': {
        const ids = take()
          .split(',')
          .map(id => id.trim())
          .filter(Boolean);
        options.scenarioIds.push(...ids);
        break;
      }
      case '--variant': {
        const variant = take();
        if (!isVariant(variant)) throw new CliUsageError(`unknown variant: ${variant}`);
        options.variants.push(variant);
        break;
      }
      case '--out':
        options.outDir = take();
        break;
      default:
        throw new CliUsageError(`unknown argument: ${arg}\n${USAGE}`);
    }
  }
  if (options.judgeOnly && options.checksOnly) {
    throw new CliUsageError('--judge-only and --checks-only are mutually exclusive');
  }
  return options;
}

function reportName(options: CliOptions, generatedAt: string | undefined): string {
  let name = 'eval-offline';
  if (generatedAt) {
    const mode = options.judgeOnly ? 'live-judge-only' : 'live';
    name = `eval-${mode}-${generatedAt.replace(/[:.]/g, '-')}`;
  }
  return options.scenarioIds.length || options.variants.length ? `${name}-partial` : name;
}

export async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const pricing = loadPricing();
  let judge: Judge | undefined;
  if (!options.checksOnly) {
    judge = createJudge(
      options.live ? {mode: 'live', pricing} : {mode: 'offline', fixtures: loadFixtures()},
    );
  }

  const report = await runEval({
    scenarios,
    generate,
    validateMessages: validateForScenario,
    judge,
    liveGeneration: options.live && !options.judgeOnly,
    scenarioIds: options.scenarioIds,
    variants: options.variants,
    inputUsdPerMillion: Number(pricing[MODEL]?.input_usd_per_million ?? 0),
  });
  // Offline reports stay byte-identical across runs; live reports carry their run time.
  if (options.live) report.generated_at = new Date().toISOString();
  const {jsonPath, markdownPath} = await writeReports(
    report,
    options.outDir,
    reportName(options, report.generated_at),
  );

  if (options.printEvidence) {
    for (const scenario of report.scenarios) {
      for (const variant of scenario.variants) {
        process.stdout.write(
          [
            `=== ${scenario.id} / ${variant.variant}`,
            `evidence_sha256 ${variant.evidence_sha256}`,
            `rubric_sha256 ${variant.grade?.rubric_sha256 ?? 'n/a'}`,
            variant.evidence,
            '',
            '',
          ].join('\n'),
        );
      }
    }
  }

  const {checks, grades, usage, reserved_micro_usd} = report.totals;
  const blocked =
    Object.entries(grades.blocked)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(' ') || 'none';
  process.stdout.write(
    [
      `generation=${report.generation} judge=${report.judge} scenarios=${report.scenarios.length}`,
      `checks passed=${checks.passed} failed=${checks.failed} warnings=${checks.warnings}`,
      `grades graded=${grades.graded} blocked: ${blocked}`,
      `judge calls=${usage.calls} input_tokens=${usage.input_tokens} ` +
        `reserved_usd=${(reserved_micro_usd / 1_000_000).toFixed(6)}`,
      `report ${jsonPath}`,
      `report ${markdownPath}`,
      '',
    ].join('\n'),
  );
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    code => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const usage = error instanceof CliUsageError || error instanceof UnknownScenarioError;
      process.stderr.write(`${error instanceof Error ? error.message : 'eval failed'}\n`);
      process.exitCode = usage ? 64 : 1;
    },
  );
}
