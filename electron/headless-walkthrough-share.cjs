// @ts-check

const { readFileSync } = require('node:fs');
const { readConfig } = require('./config.cjs');
const { createCloudflareAccessClient } = require('./cloudflare-access.cjs');
const {
  readGitIdentity,
  readRepositoryState,
  readWalkthroughRepositoryState,
} = require('./git-state.cjs');
const { generateNarrativeWalkthrough } = require('./headless-review-export.cjs');
const { normalizeNarrativeWalkthrough } = require('./narrative-walkthrough.cjs');
const { uploadSharedSnapshot } = require('./shared-walkthrough-upload.cjs');
const { resolveWalkthroughShareTarget } = require('./walkthrough-sharing.cjs');

/**
 * @typedef {import('../core/types.ts').ReviewSource} ReviewSource
 */

/**
 * @param {{
 *   codiffVersion: string;
 *   forcePublic?: boolean;
 *   openExternal: (url: string) => Promise<void>;
 *   serviceUrlOverride?: string;
 *   snapshot: Record<string, unknown>;
 *   target?: {authenticated: boolean; internal: boolean; serviceUrl: string};
 *   uploader: {email?: string; name?: string};
 * }} options
 */
const uploadSnapshot = async ({
  codiffVersion,
  forcePublic,
  openExternal,
  serviceUrlOverride,
  snapshot,
  target: targetOverride,
  uploader,
}) => {
  const target =
    targetOverride ||
    resolveWalkthroughShareTarget({
      email: uploader.email,
      forcePublic,
      overrideUrl: serviceUrlOverride,
    });
  if (!target) {
    throw new Error('Sharing is not available for this user.');
  }

  const accessClient = target.authenticated
    ? createCloudflareAccessClient({ serviceUrl: target.serviceUrl })
    : null;

  try {
    return await uploadSharedSnapshot({
      authenticate: accessClient?.authenticate,
      fetchImpl: accessClient?.fetch,
      openClaimPage: false,
      openExternal,
      serviceUrl: target.serviceUrl,
      snapshot: {
        ...snapshot,
        codiffVersion,
        exportedAt: new Date().toISOString(),
      },
      uploader: target.internal ? uploader : undefined,
    });
  } finally {
    accessClient?.clear();
  }
};

/**
 * @param {{
 *   codiffVersion: string;
 *   forcePublic?: boolean;
 *   config: ReturnType<typeof readConfig>;
 *   openExternal: (url: string) => Promise<void>;
 *   serviceUrlOverride?: string;
 *   state: import('../core/types.ts').RepositoryState;
 *   uploader: {email?: string; name?: string};
 *   walkthrough: import('../core/types.ts').NarrativeWalkthrough;
 * }} options
 */
const uploadWalkthrough = async ({
  codiffVersion,
  forcePublic,
  config,
  openExternal,
  serviceUrlOverride,
  state,
  uploader,
  walkthrough,
}) =>
  uploadSnapshot({
    codiffVersion,
    forcePublic,
    openExternal,
    serviceUrlOverride,
    snapshot: {
      branch: state.branch,
      files: state.files,
      kind: 'codiff-walkthrough-share',
      preferences: {
        codeFontFamily: config.settings.codeFontFamily,
        codeFontSize: config.settings.codeFontSize,
        diffStyle: config.settings.diffStyle,
        showWhitespace: config.settings.showWhitespace,
        theme: config.settings.theme,
        wordWrap: config.settings.wordWrap,
      },
      repository: {
        root: state.root,
        source: state.source,
        title: state.source.type === 'commit' ? state.commitMetadata?.subject : undefined,
      },
      reviewComments: state.reviewComments,
      version: 1,
      walkthrough,
    },
    uploader,
  });

/**
 * @param {string} repositoryPath
 * @param {ReviewSource} source
 * @param {ReturnType<typeof readConfig>} config
 */
const readShareState = async (repositoryPath, source, config) =>
  Promise.all([
    readRepositoryState(repositoryPath, source, {
      showWhitespace: config.settings.showWhitespace,
    }),
    readGitIdentity(repositoryPath),
  ]);

/**
 * @param {string} repositoryPath
 * @param {ReviewSource | undefined} source
 * @param {ReturnType<typeof readConfig>} config
 */
const readGeneratedShareState = async (repositoryPath, source, config) =>
  Promise.all([
    readWalkthroughRepositoryState(repositoryPath, source, {
      showWhitespace: config.settings.showWhitespace,
    }),
    readGitIdentity(repositoryPath),
  ]);

/**
 * @param {{
 *   agent?: 'claude' | 'codex' | 'opencode' | 'pi';
 *   codiffVersion: string;
 *   forcePublic?: boolean;
 *   openExternal: (url: string) => Promise<void>;
 *   repositoryPath: string;
 *   serviceUrlOverride?: string;
 *   source?: ReviewSource;
 *   walkthroughFile: string;
 * }} options
 */
const shareWalkthroughFile = async ({
  agent,
  codiffVersion,
  forcePublic,
  openExternal,
  repositoryPath,
  serviceUrlOverride,
  source = { type: 'working-tree' },
  walkthroughFile,
}) => {
  const config = readConfig();
  const [state, uploader] = await readShareState(repositoryPath, source, config);

  let input;
  try {
    input = JSON.parse(readFileSync(walkthroughFile, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read walkthrough file: ${detail}`);
  }

  const walkthrough = normalizeNarrativeWalkthrough(input, state.files, {
    agent,
    branch: state.branch,
    generatedAt: state.generatedAt,
    root: state.root,
    source: state.source,
  });

  return uploadWalkthrough({
    codiffVersion,
    forcePublic,
    config,
    openExternal,
    serviceUrlOverride,
    state,
    uploader,
    walkthrough,
  });
};

/**
 * @param {{
 *   agent?: 'claude' | 'codex' | 'opencode' | 'pi';
 *   claudeSessionId?: string;
 *   codexSessionId?: string;
 *   codiffVersion: string;
 *   forcePublic?: boolean;
 *   openExternal: (url: string) => Promise<void>;
 *   opencodeSessionId?: string;
 *   piSessionId?: string;
 *   repositoryPath: string;
 *   serviceUrlOverride?: string;
 *   source?: ReviewSource;
 *   walkthroughContextPath?: string;
 * }} options
 */
const generateAndShareWalkthrough = async ({
  agent: agentOverride,
  claudeSessionId,
  codexSessionId,
  codiffVersion,
  forcePublic,
  openExternal,
  opencodeSessionId,
  piSessionId,
  repositoryPath,
  serviceUrlOverride,
  source,
  walkthroughContextPath,
}) => {
  const config = readConfig();
  const [state, uploader] = await readGeneratedShareState(repositoryPath, source, config);
  const walkthrough = await generateNarrativeWalkthrough({
    agent: agentOverride,
    config,
    sessionIds: { claudeSessionId, codexSessionId, opencodeSessionId, piSessionId },
    state,
    walkthroughContextPath,
  });

  return uploadWalkthrough({
    codiffVersion,
    forcePublic,
    config,
    openExternal,
    serviceUrlOverride,
    state,
    uploader,
    walkthrough,
  });
};

module.exports = {
  generateAndShareWalkthrough,
  shareWalkthroughFile,
  uploadSnapshot,
};
