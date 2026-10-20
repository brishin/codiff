// @ts-check

const { getAgent } = require('./agent.cjs');
const { readConfig, writeConfig } = require('./config.cjs');
const { readRepositoryState, readWalkthroughRepositoryState } = require('./git-state.cjs');
const { readCachedNarrativeWalkthrough } = require('./cached-narrative-walkthrough.cjs');
const { mergeWalkthroughContexts, readWalkthroughContext } = require('./walkthrough-context.cjs');
const {
  getSectionWalkthroughHunks,
  isGeneratedWalkthroughFile,
} = require('../core/lib/narrative-walkthrough-diff.cjs');

/**
 * @typedef {import('../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../core/types.ts').NarrativeWalkthrough} NarrativeWalkthrough
 * @typedef {import('../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../core/types.ts').ReviewSource} ReviewSource
 * @typedef {'claude' | 'codex' | 'opencode' | 'pi'} AgentId
 * @typedef {{
 *   claudeSessionId?: string;
 *   codexSessionId?: string;
 *   opencodeSessionId?: string;
 *   piSessionId?: string;
 * }} SessionIds
 */

// Synthetic hunks (generated files, lockfiles) carry their section's patch only
// up to this size, so one lockfile cannot dominate the export.
const MAX_SYNTHETIC_PATCH_CHARS = 100_000;

/**
 * Generates a narrative walkthrough with the configured agent backend, the same
 * way the app does, reusing its stored walkthrough for an unchanged diff.
 *
 * @param {{
 *   agent?: AgentId;
 *   config: ReturnType<typeof readConfig>;
 *   sessionIds: SessionIds;
 *   state: RepositoryState;
 *   walkthroughContextPath?: string;
 * }} options
 * @returns {Promise<NarrativeWalkthrough>}
 */
const generateNarrativeWalkthrough = async ({
  agent: agentOverride,
  config,
  sessionIds,
  state,
  walkthroughContextPath,
}) => {
  const agent = getAgent(agentOverride || config.settings.agentBackend);
  const providedContext = walkthroughContextPath
    ? readWalkthroughContext(walkthroughContextPath, sessionIds.codexSessionId)
    : null;
  const sessionContext = await agent.readSessionContext(sessionIds[agent.sessionLaunchOptionKey]);
  const result = await readCachedNarrativeWalkthrough(
    state,
    agent,
    {
      fallbackModel: agent.fallbackModel,
      model: config.settings[agent.modelSettingKey],
      ...(agent.id === 'codex'
        ? {
            reasoningEffort: config.settings.openAIReasoningEffort || undefined,
            fastMode: config.settings.openAIFastMode,
          }
        : {}),
      onModelFallback: async (fallbackModel, originalModel) => {
        if (config.settings[agent.modelSettingKey] === originalModel) {
          config.settings[agent.modelSettingKey] = fallbackModel;
          writeConfig(config);
        }
      },
    },
    mergeWalkthroughContexts(providedContext, sessionContext),
    config.settings.walkthroughPrompt,
  );

  if (result.status !== 'ready') {
    throw new Error(result.reason || `${agent.label} could not generate a walkthrough.`);
  }
  return result.walkthrough;
};

/**
 * Flattens changed files into the walkthrough hunks every walkthrough hunk id
 * names, with each hunk's patch, so other tools can render a walkthrough
 * without reimplementing Codiff's diff model.
 *
 * @param {ReadonlyArray<ChangedFile>} files
 */
const exportReviewFiles = (files) =>
  files.map((file) => {
    const hunks = file.sections.flatMap((section) =>
      getSectionWalkthroughHunks(file, section).map((hunk) => {
        const isPatch = hunk.kind === 'patch' && 'patch' in hunk;
        const patch = isPatch
          ? hunk.patch
          : section.patch && section.patch.length <= MAX_SYNTHETIC_PATCH_CHARS
            ? section.patch
            : undefined;
        return {
          added: hunk.added,
          deleted: hunk.deleted,
          id: hunk.id,
          kind: hunk.kind,
          section: section.kind,
          ...(patch ? { patch } : {}),
          ...('summary' in hunk && hunk.summary ? { summary: hunk.summary } : {}),
        };
      }),
    );
    return {
      added: hunks.reduce((sum, hunk) => sum + hunk.added, 0),
      deleted: hunks.reduce((sum, hunk) => sum + hunk.deleted, 0),
      generated: isGeneratedWalkthroughFile(file),
      hunks,
      ...(file.oldPath && file.oldPath !== file.path ? { oldPath: file.oldPath } : {}),
      path: file.path,
      status: file.status,
    };
  });

/**
 * Reads a review target and, when asked, generates its walkthrough, returning
 * one JSON-safe document instead of opening the app.
 *
 * @param {SessionIds & {
 *   agent?: AgentId;
 *   repositoryPath: string;
 *   source?: ReviewSource;
 *   walkthrough?: boolean;
 *   walkthroughContextPath?: string;
 * }} options
 */
const exportReview = async ({
  agent,
  repositoryPath,
  source,
  walkthrough: withWalkthrough = false,
  walkthroughContextPath,
  ...sessionIds
}) => {
  const config = readConfig();
  const readOptions = { showWhitespace: config.settings.showWhitespace };
  // A walkthrough falls back to HEAD on a clean tree, as `codiff -w` does.
  const state = withWalkthrough
    ? await readWalkthroughRepositoryState(repositoryPath, source, readOptions)
    : await readRepositoryState(repositoryPath, source, readOptions);
  const walkthrough = withWalkthrough
    ? await generateNarrativeWalkthrough({
        agent,
        config,
        sessionIds,
        state,
        walkthroughContextPath,
      })
    : null;

  return {
    branch: state.branch,
    files: exportReviewFiles(state.files),
    kind: 'codiff-review',
    root: state.root,
    source: state.source,
    version: 1,
    walkthrough,
  };
};

module.exports = {
  exportReview,
  exportReviewFiles,
  generateNarrativeWalkthrough,
};
