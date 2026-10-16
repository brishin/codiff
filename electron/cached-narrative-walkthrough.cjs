// @ts-check

const {
  getNarrativeWalkthroughCacheKey,
  readNarrativeWalkthrough,
  resolveNarrativeWalkthroughModel,
} = require('./narrative-walkthrough.cjs');
const { readStoredWalkthrough, writeStoredWalkthrough } = require('./walkthrough-store.cjs');

/**
 * @typedef {import('../core/types.ts').NarrativeWalkthrough} NarrativeWalkthrough
 * @typedef {import('../core/types.ts').NarrativeWalkthroughResult} NarrativeWalkthroughResult
 * @typedef {import('../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../core/types.ts').WalkthroughContext} WalkthroughContext
 * @typedef {import('./agent.cjs').Agent} Agent
 * @typedef {import('./agent.cjs').AgentOptions} AgentOptions
 */

/**
 * Generates a narrative walkthrough, reusing the stored one for the exact same
 * model input unless `force` asks for a fresh one. Every caller that generates
 * walkthroughs (the app, `--share`, `--json`) goes through here, so they share
 * one cache under ~/.codiff/walkthroughs.
 *
 * @param {RepositoryState} state
 * @param {Agent} agent
 * @param {AgentOptions & {model?: unknown; reasoningEffort?: string}} agentOptions
 * @param {WalkthroughContext | null | undefined} context
 * @param {string | undefined} customPrompt
 * @param {{force?: boolean; previousWalkthrough?: NarrativeWalkthrough}} [options]
 * @returns {Promise<NarrativeWalkthroughResult>}
 */
const readCachedNarrativeWalkthrough = async (
  state,
  agent,
  agentOptions,
  context,
  customPrompt,
  options = {},
) => {
  const model = resolveNarrativeWalkthroughModel(
    state,
    agent,
    agentOptions.model,
    agentOptions.reasoningEffort,
  );
  const cacheKeyFor = (/** @type {unknown} */ keyModel) =>
    getNarrativeWalkthroughCacheKey(
      state,
      agent,
      keyModel,
      context,
      customPrompt,
      agentOptions.reasoningEffort,
    );

  if (!options.force) {
    const cachedWalkthrough = readStoredWalkthrough(cacheKeyFor(model));
    if (cachedWalkthrough) {
      return {
        status: 'ready',
        walkthrough: {
          ...cachedWalkthrough,
          ...(context ? { context } : {}),
          agent: agent.id,
          repo: { branch: state.branch, root: state.root },
          source: state.source,
        },
      };
    }
  }

  let generatedModel = model;
  const onModelFallback = agentOptions.onModelFallback;
  const result = await readNarrativeWalkthrough(
    state,
    agent,
    {
      ...agentOptions,
      model,
      onModelFallback: async (fallbackModel, originalModel) => {
        generatedModel = fallbackModel;
        await onModelFallback?.(fallbackModel, originalModel);
      },
    },
    context,
    customPrompt,
    options.previousWalkthrough,
  );
  if (result.status === 'ready') {
    try {
      // Context is per conversation, not per diff: callers attach their own on a hit.
      const cacheableWalkthrough = { ...result.walkthrough };
      delete cacheableWalkthrough.context;
      writeStoredWalkthrough(cacheKeyFor(generatedModel), cacheableWalkthrough);
    } catch {
      // Caching is optional; a filesystem failure must not hide a generated result.
    }
  }
  return result;
};

module.exports = { readCachedNarrativeWalkthrough };
