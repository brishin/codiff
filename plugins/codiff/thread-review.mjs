import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { clearTimeout, setTimeout } from 'node:timers';
import { defaultReviewPreferences } from '../../core/defaults.ts';
import agents from '../../electron/agent.cjs';
import codex from '../../electron/codex.cjs';
import configStore from '../../electron/config.cjs';
import common from '../../electron/git-state/common.cjs';
import workingTree from '../../electron/git-state/working-tree.cjs';
import commands from '../../electron/login-shell-environment.cjs';
import narrative from '../../electron/narrative-walkthrough.cjs';

export const getThreadId = (meta = {}) => {
  let turn = meta['x-codex-turn-metadata'];
  if (typeof turn === 'string') {
    turn = JSON.parse(turn);
  }
  const ids = [meta.threadId, meta.thread_id, turn?.thread_id].filter(Boolean);
  if (!ids.length || ids.some((id) => typeof id !== 'string' || id !== ids[0])) {
    throw new Error(
      'The desktop host did not supply a consistent thread ID. Reopen this tab in a local chat.',
    );
  }
  return ids[0];
};

// Read metadata only: never resume a thread, start a turn, or run a model.
export const readThread = async (threadId) => {
  const environment = await commands.getCommandEnvironment();
  const child = spawn(
    codex.getCodexCommand([join(homedir(), '.local/bin/codex'), ...codex.getCodexInstallPaths()]),
    ['app-server'],
    {
      cwd: homedir(),
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const pending = new Map();
  let nextId = 0;
  const fail = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', () => fail(new Error('The local thread lookup service exited.')));
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      return;
    }
    const request = pending.get(response.id);
    if (!request) {
      return;
    }
    pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.error) {
      request.reject(new Error(response.error.message));
    } else {
      request.resolve(response.result);
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Local thread lookup timed out (${method}).`));
      }, 15_000);
      pending.set(id, { reject, resolve, timer });
      child.stdin.write(`${JSON.stringify({ id, jsonrpc: '2.0', method, params })}\n`);
    });
  try {
    await rpc('initialize', { clientInfo: { name: 'codiff_thread_review', version: '0.2.0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
    const response = await rpc('thread/read', { threadId });
    if (response.thread?.id !== threadId || !isAbsolute(response.thread?.cwd ?? '')) {
      throw new Error('This thread has no local checkout available to Codiff.');
    }
    return response.thread;
  } finally {
    lines.close();
    child.kill();
    fail(new Error('Thread lookup finished.'));
  }
};

export const generateThreadWalkthrough = async (
  state,
  config,
  generate = narrative.readNarrativeWalkthrough,
) => {
  const agent = agents.getAgent(config.settings.agentBackend);
  if (!state.files.length) {
    throw new Error('There are no working-tree changes to explain.');
  }
  const result = await generate(
    state,
    agent,
    {
      fallbackModel: agent.fallbackModel,
      model: config.settings[agent.modelSettingKey],
      ...(agent.id === 'codex'
        ? {
            fastMode: config.settings.openAIFastMode,
            reasoningEffort: config.settings.openAIReasoningEffort || undefined,
          }
        : {}),
    },
    undefined,
    config.settings.walkthroughPrompt,
  );
  if (result.status !== 'ready') {
    throw new Error(result.reason || 'Walkthrough generation failed.');
  }
  if (!result.walkthrough.chapters.some((chapter) => chapter.stops.length)) {
    throw new Error('The agent returned no readable walkthrough steps. Try generating again.');
  }
  return result.walkthrough;
};

export const loadThreadReview = async (meta, { generateWalkthrough = false } = {}) => {
  const threadId = getThreadId(meta);
  const thread = await readThread(threadId);
  const state = await workingTree.readWorkingTreeState(thread.cwd, { eagerContents: true });
  const branch =
    (await common.gitOrEmpty(state.root, ['symbolic-ref', '--short', 'HEAD'])).trim() || null;
  const exportedAt = new Date().toISOString();
  const config = configStore.readConfig();
  const agent = agents.getAgent(config.settings.agentBackend);
  const walkthrough = generateWalkthrough
    ? await generateThreadWalkthrough({ ...state, branch }, config)
    : null;
  return {
    comparison: 'Current working tree: staged, unstaged, and untracked changes',
    snapshot: {
      branch,
      codiffVersion: '1.16.2',
      exportedAt,
      files: state.files,
      kind: 'codiff-walkthrough-share',
      preferences: defaultReviewPreferences,
      repository: { root: state.root, source: state.source, title: 'Thread changes' },
      version: 1,
      walkthrough: walkthrough ?? {
        agent: agent.id,
        chapters: [],
        focus: 'Current checkout changes. Includes changes made outside this conversation.',
        generatedAt: exportedAt,
        kind: 'narrative',
        repo: { branch, root: state.root },
        source: state.source,
        support: [],
        title: 'Thread changes',
        version: 4,
      },
    },
    threadId,
    threadTitle: thread.name || 'Thread changes',
  };
};
