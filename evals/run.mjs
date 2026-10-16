#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import {
  defaultCasesPath,
  getWalkthroughMetrics,
  nowMs,
  readCases,
  resolveCaseRepo,
  resolveRunDir,
  roundMs,
  writeJson,
} from './lib.mjs';

const require = createRequire(import.meta.url);
const { getAgent } = require('../electron/agent.cjs');
const { readConfig } = require('../electron/config.cjs');
const { readRepositoryState } = require('../electron/git-state.cjs');
const {
  buildNarrativeWalkthroughPrompt,
  readNarrativeWalkthrough,
  resolveNarrativeWalkthroughModel,
} = require('../electron/narrative-walkthrough.cjs');
const { resolveReviewUrl } = require('../electron/review-source.cjs');

const args = process.argv.slice(2);
const readOption = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const optionNames = new Set([
  '--agent',
  '--case',
  '--cases',
  '--effort',
  '--model',
  '--repetitions',
]);
let label = '';
for (let index = 0; index < args.length; index += 1) {
  if (optionNames.has(args[index])) {
    index += 1;
  } else if (!args[index].startsWith('--')) {
    label = args[index];
    break;
  }
}
label ||= `run-${Date.now()}`;
const repetitions = Number(readOption('--repetitions', '2'));
const caseFilter = readOption('--case', '');
const effort = readOption('--effort', 'high');
const productionDefaults = args.includes('--production-defaults');
const agentName = readOption('--agent', 'codex');
const settings = readConfig().settings;
const configuredModel = agentName === 'claude' ? settings.claudeModel : settings.openAIModel;
const model = readOption(
  '--model',
  productionDefaults ? getAgent(agentName).defaultModel : configuredModel,
);
const customPrompt = args.includes('--custom-prompt') ? settings.walkthroughPrompt || '' : '';
const casesPath = resolve(readOption('--cases', defaultCasesPath));
const runDir = resolveRunDir(label);
const cases = (await readCases(casesPath)).filter((item) => !caseFilter || item.id === caseFilter);

if (!Number.isInteger(repetitions) || repetitions < 1) {
  throw new Error('--repetitions must be a positive integer.');
}
if (!['claude', 'codex'].includes(agentName)) {
  throw new Error('--agent must be claude or codex.');
}
if (args.includes('--custom-prompt') && !customPrompt) {
  throw new Error('--custom-prompt requires a walkthroughPrompt setting in the Codiff config.');
}
if (!['low', 'medium', 'high'].includes(effort)) {
  throw new Error('--effort must be low, medium, or high.');
}
if (cases.length === 0) {
  throw new Error(`No eval case matched ${JSON.stringify(caseFilter)}.`);
}

await mkdir(runDir, { recursive: true });
await writeJson(join(runDir, 'run.json'), {
  agent: agentName,
  casesPath,
  customPrompt: customPrompt || null,
  effort,
  label,
  model,
  productionDefaults,
  repetitions,
  startedAt: new Date().toISOString(),
});

for (const evalCase of cases) {
  for (let attempt = 1; attempt <= repetitions; attempt += 1) {
    const attemptDir = join(runDir, evalCase.id, `attempt-${attempt}`);
    await mkdir(attemptDir, { recursive: true });
    await writeJson(join(attemptDir, 'case.json'), evalCase);

    const repo = resolveCaseRepo(evalCase);
    const source =
      evalCase.pr != null
        ? { provider: 'github', type: 'pull-request', url: resolveReviewUrl(repo, evalCase.pr) }
        : { ref: evalCase.commit, type: 'commit' };
    const baseAgent = getAgent(agentName);
    const stateStarted = nowMs();
    const state = await readRepositoryState(repo, source);
    const stateMs = roundMs(nowMs() - stateStarted);
    const promptStarted = nowMs();
    const expectedPrompt = buildNarrativeWalkthroughPrompt(
      state,
      null,
      baseAgent.label,
      customPrompt,
    );
    const promptBuildMs = roundMs(nowMs() - promptStarted);
    await writeFile(join(attemptDir, 'prompt.txt'), expectedPrompt);
    if (typeof state.source.description === 'string' && state.source.description.trim()) {
      await writeFile(join(attemptDir, 'source-description.txt'), state.source.description);
    }

    const caseModel = productionDefaults
      ? resolveNarrativeWalkthroughModel(state, baseAgent, model)
      : model;
    let rawResponse = '';
    let actualPrompt = '';
    let agentStartedAt = 0;
    let agentFinishedAt = 0;
    let agentMetrics = null;
    let actualModel = caseModel;
    const phases = [];
    const generationStarted = nowMs();
    const agent = {
      ...baseAgent,
      run: async (...runArgs) => {
        actualPrompt = runArgs[1];
        agentStartedAt = nowMs();
        try {
          rawResponse = await baseAgent.run(...runArgs);
          return rawResponse;
        } finally {
          agentFinishedAt = nowMs();
        }
      },
    };

    const result = await readNarrativeWalkthrough(
      state,
      agent,
      {
        fallbackModel: baseAgent.fallbackModel,
        model: caseModel,
        onMetrics: (metrics) => {
          agentMetrics = metrics;
        },
        onModelFallback: (fallbackModel) => {
          actualModel = fallbackModel;
        },
        onProgress: (phase) => {
          phases.push({
            elapsedMs: roundMs(nowMs() - generationStarted),
            phase,
          });
        },
        reasoningEffort: effort,
      },
      null,
      customPrompt,
    );
    const generationFinished = nowMs();
    const firstResponse = phases.find((event) => event.phase === 'response-received');

    if (actualPrompt && actualPrompt !== expectedPrompt) {
      await writeFile(join(attemptDir, 'actual-prompt.txt'), actualPrompt);
    }
    if (rawResponse) {
      await writeFile(join(attemptDir, 'raw-response.txt'), rawResponse);
    }
    if (result.status === 'ready') {
      await writeJson(join(attemptDir, 'walkthrough.json'), result.walkthrough);
    }

    const meta = {
      actualModel,
      agentMs: agentStartedAt && agentFinishedAt ? roundMs(agentFinishedAt - agentStartedAt) : null,
      commit: evalCase.commit,
      effort,
      exitStatus: result.status,
      firstResponseMs: firstResponse?.elapsedMs ?? null,
      generationMs: roundMs(generationFinished - generationStarted),
      metrics: result.status === 'ready' ? getWalkthroughMetrics(state, result.walkthrough) : null,
      model: caseModel,
      phases,
      postprocessMs: agentFinishedAt ? roundMs(generationFinished - agentFinishedAt) : null,
      promptBuildMs,
      promptChars: actualPrompt.length || expectedPrompt.length,
      rawResponseChars: rawResponse.length,
      reason: result.status === 'ready' ? null : result.reason,
      stateMs,
      transport: agentMetrics?.transport ?? null,
      usage: agentMetrics?.usage ?? null,
    };
    await writeJson(join(attemptDir, 'meta.json'), meta);
    process.stdout.write(
      `${evalCase.id} attempt ${attempt}: ${result.status}, ${(meta.generationMs / 1000).toFixed(
        2,
      )}s, first response ${
        meta.firstResponseMs == null ? 'n/a' : `${(meta.firstResponseMs / 1000).toFixed(2)}s`
      }, ${meta.promptChars} prompt chars\n`,
    );
  }
}

process.stdout.write(`Artifacts: ${runDir}\n`);
process.stdout.write(
  `Next: node evals/judge.mjs ${basename(runDir)} && node evals/report.mjs ${basename(runDir)}\n`,
);
