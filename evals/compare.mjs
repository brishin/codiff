#!/usr/bin/env node

import { join } from 'node:path';
import process from 'node:process';
import { readJson, resolveRunDir } from './lib.mjs';

const [baselineLabel, candidateLabel, enforceFlag] = process.argv.slice(2);
if (!baselineLabel || !candidateLabel) {
  throw new Error('usage: node evals/compare.mjs <baseline-label> <candidate-label> [--enforce]');
}

const isValidTiming = (value) => Number.isFinite(value) && value > 0;

const baseline = await readJson(join(resolveRunDir(baselineLabel), 'summary.json'));
const candidate = await readJson(join(resolveRunDir(candidateLabel), 'summary.json'));
if (!baseline || !candidate) {
  throw new Error('Run evals/report.mjs for both labels before comparing them.');
}

const baselineRows = new Map(baseline.rows.map((row) => [row.case, row]));
const comparisons = candidate.rows
  .filter((row) => baselineRows.has(row.case))
  .map((row) => {
    const base = baselineRows.get(row.case);
    return {
      case: row.case,
      keyDecisionsChange: (row.keyDecisions ?? 0) - (base.keyDecisions ?? 0),
      qualityChange: row.quality - base.quality,
      speedup: base.generationMs / row.generationMs,
      stateSpeedup:
        isValidTiming(base.stateMs) && isValidTiming(row.stateMs)
          ? base.stateMs / row.stateMs
          : null,
    };
  });
const qualityRatio =
  baseline.summary.averageQuality === 0
    ? 1
    : candidate.summary.averageQuality / baseline.summary.averageQuality;
const speedup =
  candidate.summary.medianGenerationMs === 0
    ? 0
    : baseline.summary.medianGenerationMs / candidate.summary.medianGenerationMs;
const baselineStateMs = baseline.summary.medianStateMs;
const candidateStateMs = candidate.summary.medianStateMs;
const baselineStateAvailable = isValidTiming(baselineStateMs);
const candidateStateAvailable = isValidTiming(candidateStateMs);
const stateMetricsAvailable = baselineStateAvailable && candidateStateAvailable;
const stateSpeedup = stateMetricsAvailable ? baselineStateMs / candidateStateMs : null;
const stateRegressionAllowanceMs = baselineStateAvailable
  ? Math.max(3, baselineStateMs * 0.05)
  : null;
const stateGatePassed =
  !baselineStateAvailable ||
  (candidateStateAvailable && candidateStateMs <= baselineStateMs + stateRegressionAllowanceMs);
const qualityGatePassed = qualityRatio >= 0.9;

process.stdout.write(`# Walkthrough eval comparison\n\n`);
process.stdout.write(`- Baseline: \`${baselineLabel}\`\n`);
process.stdout.write(`- Candidate: \`${candidateLabel}\`\n`);
process.stdout.write(`- Aggregate speedup: ${speedup.toFixed(2)}x\n`);
process.stdout.write(
  `- Repository state: ${
    stateMetricsAvailable
      ? `${baselineStateMs.toFixed(1)}ms -> ${candidateStateMs.toFixed(1)}ms (${stateSpeedup.toFixed(2)}x)`
      : baselineStateAvailable
        ? `${baselineStateMs.toFixed(1)}ms -> n/a`
        : 'n/a'
  }\n`,
);
process.stdout.write(
  `- Quality: ${baseline.summary.averageQuality.toFixed(1)} -> ${candidate.summary.averageQuality.toFixed(1)} (${((qualityRatio - 1) * 100).toFixed(1)}%)\n`,
);
process.stdout.write(
  `- Key decisions: ${(baseline.summary.averageKeyDecisions ?? 0).toFixed(1)} -> ${(
    candidate.summary.averageKeyDecisions ?? 0
  ).toFixed(1)}\n`,
);
process.stdout.write(
  `- Repository-state gate: ${baselineStateAvailable ? (stateGatePassed ? 'PASS' : 'FAIL') : 'N/A'}${
    baselineStateAvailable ? ` (max +${stateRegressionAllowanceMs.toFixed(1)}ms)` : ''
  }\n`,
);
process.stdout.write(`- 10% quality gate: ${qualityGatePassed ? 'PASS' : 'FAIL'}\n\n`);
process.stdout.write(
  '| Case | State speedup | Generation speedup | Quality change | Key decisions change |\n|---|---:|---:|---:|---:|\n',
);
for (const comparison of comparisons) {
  process.stdout.write(
    `| ${comparison.case} | ${
      comparison.stateSpeedup == null ? 'n/a' : `${comparison.stateSpeedup.toFixed(2)}x`
    } | ${comparison.speedup.toFixed(2)}x | ${comparison.qualityChange >= 0 ? '+' : ''}${comparison.qualityChange.toFixed(1)} | ${comparison.keyDecisionsChange >= 0 ? '+' : ''}${comparison.keyDecisionsChange.toFixed(1)} |\n`,
  );
}

if (enforceFlag === '--enforce' && (!qualityGatePassed || !stateGatePassed)) {
  process.exitCode = 2;
}
