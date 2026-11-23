import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {generate} from '../src/agent.ts';
import {validateForScenario} from '../src/eval.ts';
import {renderEvidence} from '../src/eval/evidence.ts';
import {createJudge, loadFixtures, rubricProblems} from '../src/eval/judge.ts';
import {runEval} from '../src/eval/run.ts';
import {scenarios} from '../src/scenarios.ts';

const EXPECTED_IDS = [
  'daily-log',
  'decision-card',
  'meeting-actions',
  'project-brief',
  'punch-proposal',
  'rfi-triage',
];

describe('recorded scenarios', () => {
  it('cover the six contract scenario IDs', () => {
    assert.deepEqual(scenarios.map(scenario => scenario.id).sort(), EXPECTED_IDS);
  });

  for (const scenario of scenarios) {
    it(`${scenario.id}: rubric is a frozen set of 4-8 single questions`, () => {
      assert.deepEqual(rubricProblems(scenario.rubric), []);
      assert.equal(Object.isFrozen(scenario.rubric.questions), true);
    });

    it(`${scenario.id}: stub surface renders with every component reachable`, () => {
      const evidence = renderEvidence(scenario.stub.messages);
      assert.deepEqual(evidence.diagnostics, []);
      assert.deepEqual(Object.values(evidence.unreachable).flat(), []);
    });
  }

  it('validates each surface with its own scenario surface ID and actions', () => {
    const punch = scenarios.find(scenario => scenario.id === 'punch-proposal');
    const rfi = scenarios.find(scenario => scenario.id === 'rfi-triage');
    assert.ok(punch && rfi);
    assert.deepEqual(validateForScenario(punch.stub.messages, punch), []);
    assert.deepEqual(validateForScenario(punch.stub.messages, rfi), [
      'messages[0].createSurface.surfaceId must be "rfi-triage"',
    ]);
  });

  it('recorded stub output passes every deterministic check in both variants', async () => {
    const report = await runEval({
      scenarios,
      generate,
      validateMessages: validateForScenario,
      liveGeneration: false,
      judge: createJudge({mode: 'offline', fixtures: loadFixtures()}),
    });
    const failures = report.scenarios.flatMap(result =>
      result.variants.flatMap(variant =>
        variant.checks
          .filter(check => !check.ok)
          .map(check => `${result.id}/${variant.variant}/${check.id}: ${check.detail}`),
      ),
    );
    assert.deepEqual(failures, []);
    for (const result of report.scenarios) {
      assert.equal(result.generation.mode, 'stub');
      assert.equal(result.variants.length, 2);
      for (const variant of result.variants) {
        // Every recorded lane has a canned grade recorded against exactly this evidence.
        const lane = `${result.id}/${variant.variant}`;
        assert.equal(variant.grade?.status, 'GRADED', `${lane}: ${variant.grade?.blocked_reason}`);
        assert.equal(variant.grade?.source, 'fixture', lane);
      }
    }
    assert.deepEqual(report.totals.grades, {graded: 12, blocked: {}});
    assert.equal(report.totals.usage.calls, 0);
    assert.equal(report.totals.reserved_micro_usd, 0);
  });
});
