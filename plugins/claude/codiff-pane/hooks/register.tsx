import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register, Timer } from 'claude-code';
import type {
  AgentSettings,
  DiffFile,
  FileStatus,
  Review,
  ReviewState,
  Scope,
  ViewState,
  WalkthroughState,
} from '../types';
import { ICONS, iconSvg } from './icons';
import type { IconName } from './icons';
import {
  buildTree,
  fileSource,
  flattenStops,
  hunkIndex,
  parseCodiffReview,
  toDiffFiles,
  toWalkthrough,
} from './lib';

const PANE = 'codiff';
const PREFS_KEY = 'prefs';

const DEFAULT_VIEW: ViewState = {
  mode: 'files',
  selected: null,
  scope: 'all',
  pullRequest: null,
  wrap: true,
  showTree: true,
  collapsed: [],
  viewed: [],
  stop: 0,
  menu: false,
  outline: false,
};

const reviewAtom = atom(
  { plugin: 'codiff-pane', key: 'review' } as const,
  { status: 'idle' } as ReviewState,
);
const viewAtom = atom({ plugin: 'codiff-pane', key: 'view' } as const, DEFAULT_VIEW);
const agentAtom = atom(
  { plugin: 'codiff-pane', key: 'agent' } as const,
  { agent: 'default' } as AgentSettings,
);
const walkthroughAtom = atom(
  { plugin: 'codiff-pane', key: 'walkthrough' } as const,
  { status: 'idle' } as WalkthroughState,
);

const SCOPES: { value: Scope; label: string }[] = [
  { value: 'all', label: 'Working tree' },
  { value: 'staged', label: 'Staged' },
  { value: 'unstaged', label: 'Unstaged' },
  { value: 'branch', label: 'Branch vs base' },
];
const AGENTS: { value: AgentSettings['agent']; label: string }[] = [
  { value: 'default', label: 'Codiff setting' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'pi', label: 'Pi' },
];
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']);
const STATUS: Record<FileStatus, { letter: string; color: string }> = {
  added: { letter: 'A', color: 'success' },
  untracked: { letter: 'U', color: 'success' },
  deleted: { letter: 'D', color: 'error' },
  modified: { letter: 'M', color: 'warning' },
  renamed: { letter: 'R', color: 'suggestion' },
  conflicted: { letter: 'C', color: 'error' },
};
// SVG is drawn as an image, outside the theme: mid-tones that read on light and dark.
const MUTED = '#8b949e';
const ACCENT = '#a371f7';
const GLYPHS: Partial<Record<IconName, string>> = {
  folder: '▸',
  check: '✓',
  sparkle: '✦',
  refresh: '↻',
  path: '⑂',
  bug: '●',
  wrench: '●',
  flask: '●',
  beaker: '●',
  doc: '●',
  gear: '●',
};
const SHOWN_HIDDEN = [
  { value: 'shown', label: 'Shown' },
  { value: 'hidden', label: 'Hidden' },
] as const satisfies { value: string; label: string }[];
const WRAPS = [
  { value: 'wrap', label: 'Wrap' },
  { value: 'cut', label: 'Cut off' },
] as const satisfies { value: string; label: string }[];
// Characters of diff one drawing carries; the engine cuts a tree at 100,000.
const DRAW_BUDGET = 70_000;
// Codiff's own walkthrough timeouts reach five minutes per model, with a fallback model after.
const WALKTHROUGH_TIMEOUT_MS = 600_000;

type Host = EngineInterface;

// Session state outlives a hot reload, so values an older version of this mod wrote can
// still be there: read anything not in today's shape as unset.
function currentWalkthrough(state: WalkthroughState): WalkthroughState {
  return state.status !== 'ready' ||
    (Array.isArray(state.files) &&
      state.walkthrough.support.every((group) => Array.isArray(group?.hunkIds)))
    ? state
    : { status: 'idle' };
}

function currentAgent(settings: AgentSettings): AgentSettings['agent'] {
  return AGENTS.some((option) => option.value === settings?.agent) ? settings.agent : 'default';
}

let refreshTimer: Timer | undefined;
let generation: Timer | undefined;

async function git($: Host, cwd: string, args: string[]) {
  return $.process.run(['git', ...args], { cwd, timeoutMs: 20_000 });
}

async function repositoryRoot($: Host) {
  const cwd: string = await $.session.cwd();
  const top = await git($, cwd, ['rev-parse', '--show-toplevel']);
  if (top.exitCode !== 0) throw new Error(`${cwd} is not inside a Git repository.`);
  return top.stdout.trim();
}

// A checkout of Codiff itself runs its own CLI, so the pane follows local changes to it.
async function localCodiffScript($: Host, root: string) {
  try {
    const manifest = JSON.parse(await $.fs.read(`${root}/package.json`)) as { name?: string };
    return manifest.name === 'codiff' && (await $.fs.exists(`${root}/bin/codiff.js`))
      ? `${root}/bin/codiff.js`
      : null;
  } catch {
    return null;
  }
}

// The `codiffPath` setting, read at load: a Codiff executable or a checkout's `bin/codiff.js`.
let configuredCodiff = '';

// Picks the CLI in the login shell, which expands `~`; `.js` entry points run under node.
const RUN_CODIFF = `p="$CODIFF_PATH"
[[ "$p" == "~/"* ]] && p="$HOME/\${p:2}"
if [[ -z "$p" ]]; then exec codiff "$@"; fi
if [[ "$p" == *.js || "$p" == *.mjs ]]; then exec node "$p" "$@"; fi
exec "$p" "$@"`;

// Runs the Codiff CLI through a login shell: a session the desktop app starts may lack the
// PATH that finds `codiff` and `node`, which Codiff's own launcher resolves the same way.
// The setting wins, then a Codiff checkout's own CLI, then `codiff` on PATH.
async function runCodiff($: Host, root: string, args: string[], timeoutMs: number) {
  const path = configuredCodiff || (await localCodiffScript($, root)) || '';
  const result = await $.process.run(['/bin/zsh', '-lc', RUN_CODIFF, 'codiff', ...args], {
    cwd: root,
    timeoutMs,
    env: { CODIFF_PATH: path },
  });
  if (result.exitCode === 127) {
    throw new Error(
      path
        ? `Codiff was not found at ${path}. Check the codiffPath setting.`
        : 'The Codiff CLI is not on your PATH. Install Codiff, or set codiffPath.',
    );
  }
  if (result.exitCode !== 0) {
    const reason =
      result.stderr.trim().split('\n').pop() || `Codiff exited with ${result.exitCode}.`;
    throw new Error(
      /--json/.test(reason) && /unknown|unexpected/i.test(reason)
        ? 'This Codiff does not support --json yet. Run `codiff update`, or set codiffPath to a newer checkout.'
        : reason,
    );
  }
  return parseCodiffReview(result.stdout);
}

async function scopeArguments(
  $: Host,
  root: string,
  view: Pick<ViewState, 'scope' | 'pullRequest'>,
) {
  if (view.scope === 'pull-request' && view.pullRequest) return [`#${view.pullRequest}`];
  if (view.scope !== 'branch') return [];
  const head = (
    await git($, root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  ).stdout.trim();
  return ['--branch', head.replace(/^origin\//, '') || 'main'];
}

const SCOPE_LABELS: Record<Scope, string> = {
  all: 'Working tree: staged, unstaged, and untracked',
  staged: 'Staged changes',
  unstaged: 'Unstaged changes',
  branch: 'Branch vs base',
  'pull-request': 'Pull request',
};

async function loadReview($: Host) {
  const current = await read($, reviewAtom);
  if (current.status !== 'ready')
    await update($, reviewAtom, () => ({ status: 'loading' }) as ReviewState);
  try {
    const review = await readReview($, await read($, viewAtom));
    await update($, reviewAtom, () => ({ status: 'ready', review }) as ReviewState);
  } catch (error) {
    await update(
      $,
      reviewAtom,
      () => ({ status: 'error', error: String((error as Error)?.message ?? error) }) as ReviewState,
    );
  }
}

async function readReview($: Host, view: ViewState): Promise<Review> {
  const root = await repositoryRoot($);
  const codiff = await runCodiff(
    $,
    root,
    ['--json', ...(await scopeArguments($, root, view)), root],
    60_000,
  );
  const { source } = codiff;
  return {
    root: codiff.root,
    branch: codiff.branch,
    label:
      source?.type === 'pull-request' && source.number
        ? `PR #${source.number}${source.title ? `: ${source.title}` : ''}`
        : SCOPE_LABELS[view.scope],
    files: toDiffFiles(codiff.files, view.scope),
    loadedAt: Date.now(),
  };
}

function scheduleRefresh($: Host, ms = 400) {
  refreshTimer?.cancel();
  refreshTimer = $.clock.after(ms, () => {
    void loadReview($);
  });
}

async function savePrefs($: Host) {
  const view = await read($, viewAtom);
  const agent = await read($, agentAtom);
  const { wrap, showTree } = view;
  // A pull request is opened per command, never restored in a later session.
  const scope = view.scope === 'pull-request' ? 'all' : view.scope;
  await $.store.set(PREFS_KEY, { view: { scope, wrap, showTree }, agent });
}

// What a walkthrough was written against: staged and unstaged views share the working tree's.
const walkthroughTarget = (view: Pick<ViewState, 'scope' | 'pullRequest'>) =>
  view.scope === 'pull-request'
    ? `pr:${view.pullRequest}`
    : view.scope === 'branch'
      ? 'branch'
      : 'working-tree';

async function setView($: Host, patch: Partial<ViewState>, { reload = false } = {}) {
  const before = await read($, viewAtom);
  const after = { ...before, ...patch };
  const isNewTarget = walkthroughTarget(before) !== walkthroughTarget(after);
  // A new target has its own files and walkthrough: reset what belonged to the old one.
  await update($, viewAtom, (view) => ({
    ...view,
    ...patch,
    ...(isNewTarget ? { viewed: [], collapsed: [], stop: 0 } : {}),
  }));
  if (isNewTarget) {
    generation?.cancel();
    await update($, walkthroughAtom, () => ({ status: 'idle' }) as WalkthroughState);
  }
  await savePrefs($);
  if (reload) await loadReview($);
}

// Codiff's own pipeline writes the walkthrough: its prompt, digest, agent backend, model
// settings, validation, and cache. This session's transcript rides along as context.
async function generateWalkthrough($: Host) {
  const [settings, view] = await Promise.all([read($, agentAtom), read($, viewAtom)]);
  const agent = currentAgent(settings);
  try {
    const root = await repositoryRoot($);
    const sessionId: string = await $.session.id();
    // Staged and unstaged comparisons walk the whole working tree, as Codiff does.
    const scope = await scopeArguments($, root, view);
    const codiff = await runCodiff(
      $,
      root,
      [
        '--json',
        '--walkthrough',
        '--claude-session',
        sessionId,
        ...(agent === 'default' ? [] : ['--agent', agent]),
        ...scope,
        root,
      ],
      WALKTHROUGH_TIMEOUT_MS,
    );
    if (!codiff.walkthrough) throw new Error('Codiff returned no walkthrough.');
    const walkthrough = toWalkthrough(codiff.walkthrough);
    const files = toDiffFiles(codiff.files);
    await update(
      $,
      walkthroughAtom,
      () => ({ status: 'ready', walkthrough, files, generatedAt: Date.now() }) as WalkthroughState,
    );
  } catch (error) {
    await update(
      $,
      walkthroughAtom,
      () => ({ status: 'error', error: String((error as Error).message) }) as WalkthroughState,
    );
  }
}

// A walkthrough can take minutes, longer than the press or command dispatch that asked for
// it should stay alive, so it runs on a timer of its own; a second ask while one runs is a no-op.
async function startWalkthrough($: Host) {
  if ((await read($, walkthroughAtom)).status === 'loading') return;
  await update(
    $,
    walkthroughAtom,
    () => ({ status: 'loading', startedAt: Date.now() }) as WalkthroughState,
  );
  await setView($, { mode: 'walkthrough', stop: 0 });
  generation?.cancel();
  generation = $.clock.after(0, () => {
    void generateWalkthrough($);
  });
}

async function openPane($: Host, mode?: ViewState['mode']) {
  if (mode) await setView($, { mode });
  await loadReview($);
  return $.ui.open({ id: PANE, title: 'Codiff', focus: true, columns: 120, rows: 32 });
}

export const register: Register = (on, options) => {
  configuredCodiff = typeof options.codiffPath === 'string' ? options.codiffPath.trim() : '';

  on('session.start', async ($, e, next) => {
    const prefs = (await $.store.get(PREFS_KEY)) as
      | { view?: Partial<ViewState>; agent?: Partial<AgentSettings> }
      | undefined;
    if (prefs?.view) await update($, viewAtom, (view) => ({ ...view, ...prefs.view }));
    const savedAgent = prefs?.agent?.agent;
    if (savedAgent) await update($, agentAtom, () => ({ agent: savedAgent }));
    await $.command.register({
      name: 'codiff',
      description: 'Review working-tree changes, or a pull request, in a Codiff pane',
      argumentHint: '[PR number]',
    });
    return next(e);
  });

  on('command.run', { command: 'codiff' }, async ($, e) => {
    const args = e.args.trim();
    const pullRequest = /^#?(\d+)$/.exec(args)?.[1];
    if (args && !pullRequest) return { text: 'Usage: /codiff [PR number]' };
    const view = await read($, viewAtom);
    if (pullRequest) {
      await setView($, {
        scope: 'pull-request',
        pullRequest: Number(pullRequest),
        selected: null,
        mode: 'files',
      });
    } else if (view.scope === 'pull-request') {
      await setView($, { scope: 'all', selected: null });
    }
    await openPane($);
    return { text: pullRequest ? `Codiff opened PR #${pullRequest}.` : 'Codiff opened.' };
  });

  // Keep the pane live while Claude edits the checkout.
  on('tool.call', async ($, e, next) => {
    const result = await next(e);
    if (WRITE_TOOLS.has(e.tool)) {
      // A pull request's diff does not change with local edits.
      void Promise.all([read($, reviewAtom), read($, viewAtom)])
        .then(
          ([state, view]) =>
            state.status !== 'idle' && view.scope !== 'pull-request' && scheduleRefresh($),
        )
        .catch(() => {});
    }
    return result;
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e);
    const { Box, Text, Button, Code, Markdown } = els;
    const Select = 'Select' in els ? els.Select : undefined;
    const Svg = 'Svg' in els ? els.Svg : undefined;
    const [state, view, settings, storedWalkthrough] = await Promise.all([
      read($, reviewAtom),
      read($, viewAtom),
      read($, agentAtom),
      read($, walkthroughAtom),
    ]);
    const agent = currentAgent(settings);
    const wt = currentWalkthrough(storedWalkthrough);
    const columns: number =
      (e.props as { bodyColumns?: number }).bodyColumns ?? e.viewport?.columns ?? 100;
    const wide = columns >= 110;

    // Phosphor icons where the surface draws SVG; a glyph on the terminal.
    const icon = (name: IconName, hex = MUTED, size = 14, color?: string) =>
      Svg ? (
        <Svg source={iconSvg(name, hex)} alt={name} width={size} height={size} />
      ) : (
        <Text color={color} dimColor={!color}>
          {GLYPHS[name] ?? '•'}
        </Text>
      );

    const pill = (status: FileStatus) => {
      const s = STATUS[status];
      return (
        <Text backgroundColor={s.color} color="inverseText" weight="bold" mono size="footnote">
          {` ${s.letter} `}
        </Text>
      );
    };

    const stats = (added: number, deleted: number) => (
      <Text tabular size="footnote">
        <Text color="diffAdded">+{added}</Text> <Text color="diffRemoved">−{deleted}</Text>
      </Text>
    );

    // GitHub-style proportion bar: five blocks split between additions and deletions.
    const statBar = (added: number, deleted: number, width = 5) => {
      const total = added + deleted;
      let plus = total ? Math.round((added / total) * width) : 0;
      let minus = total ? Math.round((deleted / total) * width) : 0;
      if (added && !plus) plus = 1;
      if (deleted && !minus) minus = 1;
      while (plus + minus > width) plus > minus ? plus-- : minus--;
      return (
        <Text size="footnote">
          <Text color="diffAdded">{'■'.repeat(plus)}</Text>
          <Text color="diffRemoved">{'■'.repeat(minus)}</Text>
          <Text dimColor>{'■'.repeat(width - plus - minus)}</Text>
        </Text>
      );
    };

    const choice = <T extends string>(
      key: string,
      label: string,
      value: T,
      options: { value: T; label: string }[],
      onPick: (value: T) => void,
    ) => {
      if (Select) {
        return (
          <Select
            key={key}
            label={label}
            value={value}
            options={options.map((o) => ({ value: o.value, label: o.label }))}
            onSelect={(picked: string) => onPick(picked as T)}
          />
        );
      }
      const index = options.findIndex((o) => o.value === value);
      const nextOption = options[(index + 1) % options.length];
      return (
        <Button
          key={key}
          label={`${label}: ${options[index]?.label ?? value}`}
          onPress={() => nextOption && onPick(nextOption.value)}
        />
      );
    };

    const splitPath = (path: string) => {
      const slash = path.lastIndexOf('/');
      return { dir: slash >= 0 ? path.slice(0, slash + 1) : '', base: path.slice(slash + 1) };
    };

    if (state.status === 'idle' || state.status === 'loading') {
      return (
        <Box flexDirection="row" gap="sm" alignItems="center">
          {icon('refresh')}
          <Text dimColor>Reading the checkout…</Text>
        </Box>
      );
    }
    if (state.status === 'error') {
      return (
        <Box flexDirection="column" gap={1} borderStyle="round" borderColor="error" paddingX={1}>
          <Text color="error" weight="semibold">
            Codiff could not read this checkout
          </Text>
          <Text>{state.error}</Text>
          <Button
            key="retry"
            label="Retry"
            hotkey="r"
            variant="primary"
            onPress={() => loadReview($)}
          />
        </Box>
      );
    }

    const { review } = state;
    const added = review.files.reduce((sum, f) => sum + f.added, 0);
    const deleted = review.files.reduce((sum, f) => sum + f.deleted, 0);
    const fileCount = `${review.files.length} file${review.files.length === 1 ? '' : 's'}`;

    const optionsPanel =
      view.mode === 'files' ? (
        <Box
          flexDirection="row"
          flexWrap="wrap"
          gap={2}
          borderStyle="round"
          borderDimColor
          paddingX={1}
        >
          {choice(
            'scope',
            'Compare',
            view.scope,
            view.pullRequest
              ? [...SCOPES, { value: 'pull-request', label: `PR #${view.pullRequest}` }]
              : SCOPES,
            (scope) => setView($, { scope, selected: null }, { reload: true }),
          )}
          {choice('wrap', 'Long lines', view.wrap ? 'wrap' : 'cut', WRAPS, (value) =>
            setView($, { wrap: value === 'wrap' }),
          )}
          {choice('tree', 'File tree', view.showTree ? 'shown' : 'hidden', SHOWN_HIDDEN, (value) =>
            setView($, { showTree: value === 'shown' }),
          )}
        </Box>
      ) : (
        <Box
          flexDirection="row"
          flexWrap="wrap"
          gap={2}
          borderStyle="round"
          borderDimColor
          paddingX={1}
        >
          {choice('agent', 'Agent', agent, AGENTS, (value) =>
            update($, agentAtom, () => ({ agent: value })).then(() => savePrefs($)),
          )}
          <Text size="footnote" dimColor>
            Models, effort, and the walkthrough prompt come from Codiff's settings.
          </Text>
        </Box>
      );

    const header = (
      <Box flexDirection="column" gap="sm">
        <Box
          flexDirection="row"
          justifyContent="space-between"
          alignItems="center"
          flexWrap="wrap"
          gap={1}
        >
          <Box flexDirection="row" gap="sm" alignItems="center">
            {icon('path', ACCENT, 18, 'suggestion')}
            <Box flexDirection="column">
              <Text size="heading" weight="semibold">
                {review.branch ?? 'detached HEAD'}
              </Text>
              <Text size="footnote" dimColor>
                {review.label}
              </Text>
            </Box>
          </Box>
          <Box flexDirection="row" gap="sm" alignItems="center">
            {stats(added, deleted)}
            {statBar(added, deleted)}
            <Text size="footnote" dimColor>
              {fileCount}
            </Text>
          </Box>
        </Box>
        <Box
          flexDirection="row"
          justifyContent="space-between"
          alignItems="center"
          flexWrap="wrap"
          gap={1}
        >
          <Box flexDirection="row">
            <Button
              key="mode-files"
              label={`Files · ${review.files.length}`}
              hotkey="f"
              variant={view.mode === 'files' ? 'primary' : 'secondary'}
              onPress={() => setView($, { mode: 'files', menu: false })}
            />
            <Button
              key="mode-walkthrough"
              label="✦ Walkthrough"
              hotkey="w"
              variant={view.mode === 'walkthrough' ? 'primary' : 'secondary'}
              onPress={() => setView($, { mode: 'walkthrough', menu: false })}
            />
          </Box>
          <Box flexDirection="row" gap={1}>
            <Button
              key="menu"
              label={`${view.mode === 'files' ? 'View' : 'Agent'} ${view.menu ? '▴' : '▾'}`}
              hotkey="v"
              onPress={() => setView($, { menu: !view.menu })}
            />
            <Button key="refresh" label="↻ Refresh" hotkey="r" onPress={() => loadReview($)} />
          </Box>
        </Box>
        {view.menu ? optionsPanel : null}
      </Box>
    );

    if (!review.files.length) {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Box
            flexDirection="column"
            alignItems="center"
            borderStyle="round"
            borderDimColor
            paddingY={1}
          >
            {icon('check', '#3fb950', 24, 'success')}
            <Text weight="semibold">Nothing to review</Text>
            <Text size="footnote" dimColor>
              No changes for this comparison.
            </Text>
          </Box>
        </Box>
      );
    }

    const wrap = view.wrap ? 'wrap' : 'truncate-end';
    const toggleIn = (list: string[], path: string) =>
      list.includes(path) ? list.filter((p) => p !== path) : [...list, path];

    const fileCard = (file: DiffFile, collapsible: boolean) => {
      const isViewed = view.viewed.includes(file.path);
      const isCollapsed = collapsible && (isViewed || view.collapsed.includes(file.path));
      const { dir, base } = splitPath(file.path);
      return (
        <Box key={`file:${file.path}`} flexDirection="column" gap="xs">
          <Box
            flexDirection="row"
            justifyContent="space-between"
            alignItems="center"
            gap={1}
            flexWrap="wrap"
          >
            <Box flexDirection="row" gap="sm" alignItems="center" flexShrink={1}>
              {collapsible ? (
                <Button
                  key={`collapse:${file.path}`}
                  plain
                  label={isCollapsed ? '▸' : '▾'}
                  onPress={() => setView($, { collapsed: toggleIn(view.collapsed, file.path) })}
                />
              ) : null}
              {pill(file.status)}
              <Button
                key={`open:${file.path}`}
                plain
                onPress={() => setView($, { selected: file.path })}
              >
                <Text dimColor mono>
                  {dir}
                </Text>
                <Text weight="semibold" mono>
                  {base}
                </Text>
              </Button>
              {file.oldPath ? (
                <Text size="footnote" dimColor>
                  from {file.oldPath}
                </Text>
              ) : null}
            </Box>
            <Box flexDirection="row" gap="sm" alignItems="center">
              {stats(file.added, file.deleted)}
              {statBar(file.added, file.deleted)}
              <Button
                key={`viewed:${file.path}`}
                label={isViewed ? '☑ Viewed' : '☐ Viewed'}
                onPress={() => setView($, { viewed: toggleIn(view.viewed, file.path) })}
              />
            </Box>
          </Box>
          {isCollapsed ? null : fileSource(file) ? (
            <Code format="diff" path={file.path} source={fileSource(file)} wrap={wrap} />
          ) : (
            <Text dimColor>
              {file.hunks.find((hunk) => hunk.summary)?.summary ?? 'No textual changes.'}
            </Text>
          )}
        </Box>
      );
    };

    const filesView = () => {
      const tree = buildTree(review.files);
      const viewedCount = review.files.filter((f) => view.viewed.includes(f.path)).length;
      const treeView = view.showTree ? (
        <Box
          flexDirection="column"
          width={wide ? 40 : undefined}
          flexShrink={0}
          borderStyle="round"
          borderDimColor
          paddingX={1}
        >
          <Box flexDirection="row" justifyContent="space-between">
            <Text size="footnote" weight="semibold" dimColor>
              CHANGED FILES
            </Text>
            <Text size="footnote" dimColor tabular>
              {viewedCount}/{review.files.length} viewed
            </Text>
          </Box>
          <Box key="row:all" flexDirection="row" gap="sm">
            <Text color="suggestion" mono>
              {view.selected === null ? '▍' : ' '}
            </Text>
            <Button key="all-files" plain onPress={() => setView($, { selected: null })}>
              <Text
                color={view.selected === null ? 'suggestion' : undefined}
                weight="semibold"
                hover={{ color: 'suggestion' }}
              >
                All files
              </Text>
            </Button>
          </Box>
          {tree.map((row) => {
            if (row.kind === 'dir') {
              return (
                <Box
                  key={`dir:${row.path}`}
                  flexDirection="row"
                  gap="sm"
                  paddingLeft={row.depth * 2 + 1}
                >
                  {icon('folder', MUTED, 13)}
                  <Text dimColor>{row.name}</Text>
                </Box>
              );
            }
            const status = STATUS[row.file.status];
            const isSelected = view.selected === row.path;
            const isViewed = view.viewed.includes(row.path);
            return (
              <Box
                key={`row:${row.path}`}
                flexDirection="row"
                justifyContent="space-between"
                gap="sm"
              >
                <Box flexDirection="row" gap="sm" flexShrink={1}>
                  <Text color="suggestion" mono>
                    {isSelected ? '▍' : ' '}
                  </Text>
                  <Box flexDirection="row" gap="sm" paddingLeft={row.depth * 2}>
                    <Text color={status.color} weight="bold" mono>
                      {status.letter}
                    </Text>
                    <Button
                      key={`tree:${row.path}`}
                      plain
                      onPress={() => setView($, { selected: row.path })}
                    >
                      <Text
                        color={isSelected ? 'suggestion' : undefined}
                        weight={isSelected ? 'semibold' : undefined}
                        dimColor={isViewed && !isSelected}
                        hover={{ color: 'suggestion' }}
                      >
                        {row.name}
                      </Text>
                    </Button>
                  </Box>
                </Box>
                <Box flexDirection="row" gap="sm" alignItems="center">
                  {isViewed ? icon('check', '#3fb950', 12, 'success') : null}
                  {statBar(row.file.added, row.file.deleted, 4)}
                </Box>
              </Box>
            );
          })}
        </Box>
      ) : null;

      let diffView;
      const selectedIndex = view.selected
        ? review.files.findIndex((f) => f.path === view.selected)
        : -1;
      const selectedFile = review.files[selectedIndex];
      if (selectedFile) {
        const file = selectedFile;
        const previous = review.files[selectedIndex - 1];
        const following = review.files[selectedIndex + 1];
        const markViewed = [...new Set([...view.viewed, file.path])];
        diffView = (
          <Box flexDirection="column" gap="sm" flexGrow={1}>
            {fileCard(file, false)}
            <Box flexDirection="row" justifyContent="space-between" alignItems="center">
              <Button
                key="prev-file"
                label={previous ? `← ${splitPath(previous.path).base}` : '←'}
                hotkey="k"
                onPress={() => previous && setView($, { selected: previous.path })}
              />
              <Text size="footnote" dimColor tabular>
                File {selectedIndex + 1} of {review.files.length}
              </Text>
              <Button
                key="next-file"
                label={
                  following ? `Viewed, next: ${splitPath(following.path).base} →` : 'Mark viewed'
                }
                hotkey="j"
                variant="primary"
                onPress={() =>
                  setView(
                    $,
                    following
                      ? { selected: following.path, viewed: markViewed }
                      : { viewed: markViewed },
                  )
                }
              />
            </Box>
          </Box>
        );
      } else {
        let budget = DRAW_BUDGET;
        const shown: DiffFile[] = [];
        for (const file of review.files) {
          const isCollapsed = view.viewed.includes(file.path) || view.collapsed.includes(file.path);
          const size = isCollapsed ? 0 : fileSource(file).length;
          if (shown.length && size > budget) break;
          budget -= size;
          shown.push(file);
        }
        const rest = review.files.length - shown.length;
        diffView = (
          <Box flexDirection="column" gap="sm" flexGrow={1}>
            {shown.map((file) => fileCard(file, true))}
            {rest > 0 ? (
              <Box borderStyle="round" borderDimColor paddingX={1}>
                <Text dimColor>
                  {rest} more file{rest === 1 ? '' : 's'} not drawn here. Pick one in the tree, or
                  mark files as viewed.
                </Text>
              </Box>
            ) : null}
          </Box>
        );
      }

      return (
        <Box flexDirection={wide ? 'row' : 'column'} gap={wide ? 2 : 1}>
          {treeView}
          {diffView}
        </Box>
      );
    };

    const walkthroughView = () => {
      if (wt.status === 'idle' || wt.status === 'loading' || wt.status === 'error') {
        const agentLabel =
          agent === 'default'
            ? "Codiff's configured agent"
            : AGENTS.find((a) => a.value === agent)?.label;
        return (
          <Box
            flexDirection="column"
            alignItems="center"
            gap="sm"
            borderStyle="round"
            borderDimColor
            paddingY={1}
            paddingX={2}
          >
            {icon('sparkle', ACCENT, 28, 'suggestion')}
            <Text size="heading" weight="semibold">
              {wt.status === 'loading'
                ? 'Writing your walkthrough…'
                : wt.status === 'error'
                  ? 'Walkthrough failed'
                  : 'Guided walkthrough'}
            </Text>
            {wt.status === 'error' ? (
              <Text color="error">{wt.error}</Text>
            ) : (
              <Text dimColor>
                {wt.status === 'loading'
                  ? `Codiff is asking ${agentLabel} to group ${fileCount} into chapters and stops.`
                  : `Group these ${fileCount} into chapters and stops, ordered by review leverage.`}
              </Text>
            )}
            {wt.status === 'loading' ? null : (
              <Button
                key="generate"
                label={wt.status === 'error' ? 'Try again' : 'Generate walkthrough'}
                hotkey="g"
                variant="primary"
                onPress={() => startWalkthrough($)}
              />
            )}
            <Text size="footnote" dimColor>
              Runs Codiff's walkthrough pipeline with {agentLabel} · sends the diff and this
              conversation
            </Text>
          </Box>
        );
      }

      const { walkthrough } = wt;
      const stops = flattenStops(walkthrough);
      const hasSupport = walkthrough.support.length > 0;
      const total = stops.length + (hasSupport ? 1 : 0);
      const index = Math.min(Math.max(view.stop, 0), total - 1);
      const hunks = hunkIndex(wt.files);
      const goTo = (stop: number) => setView($, { stop });
      const chapterIcon = (name: string): IconName => (name in ICONS ? (name as IconName) : 'path');

      const progress = (
        <Text>
          {Array.from({ length: total }, (_, i) => (
            <Text color={i <= index ? 'suggestion' : undefined} dimColor={i > index}>
              {i ? ' ' : ''}━━━
            </Text>
          ))}
        </Text>
      );

      const outline = (
        <Box
          flexDirection="column"
          width={wide ? 36 : undefined}
          flexShrink={0}
          gap="sm"
          borderStyle="round"
          borderDimColor
          paddingX={1}
        >
          {walkthrough.chapters.map((chapter, c) => (
            <Box key={`chapter:${chapter.id}`} flexDirection="column">
              <Box flexDirection="row" gap="sm" alignItems="center">
                {icon(chapterIcon(chapter.icon), ACCENT, 13, 'suggestion')}
                <Text weight="semibold" size="footnote">
                  {chapter.title.toUpperCase()}
                </Text>
              </Box>
              {stops.map((entry, i) =>
                entry.chapterIndex === c ? (
                  <Box key={`stop-row:${i}`} flexDirection="row" gap="sm">
                    <Text color="suggestion" mono>
                      {i === index ? '▍' : ' '}
                    </Text>
                    <Button key={`stop:${i}`} plain onPress={() => goTo(i)}>
                      <Text dimColor mono>
                        {String(i + 1).padStart(String(total).length, ' ')}{' '}
                      </Text>
                      <Text
                        color={i === index ? 'suggestion' : undefined}
                        weight={i === index ? 'semibold' : undefined}
                        hover={{ color: 'suggestion' }}
                      >
                        {entry.stop.title}
                      </Text>
                    </Button>
                  </Box>
                ) : null,
              )}
            </Box>
          ))}
          {hasSupport ? (
            <Box key="stop-row:support" flexDirection="row" gap="sm">
              <Text color="suggestion" mono>
                {index === stops.length ? '▍' : ' '}
              </Text>
              <Button key="stop:support" plain onPress={() => goTo(stops.length)}>
                <Text
                  color={index === stops.length ? 'suggestion' : undefined}
                  dimColor={index !== stops.length}
                  hover={{ color: 'suggestion' }}
                >
                  Supporting changes ·{' '}
                  {walkthrough.support.reduce((sum, group) => sum + group.hunkIds.length, 0)}
                </Text>
              </Button>
            </Box>
          ) : null}
        </Box>
      );

      // Consecutive hunks of one file share a header; the desktop frames each Code itself.
      const hunkGroups = (
        ids: readonly string[],
        notes: readonly { hunkId: string; body: string }[] = [],
      ) => {
        const groups: { file: DiffFile | undefined; ids: string[] }[] = [];
        for (const id of ids) {
          const file = hunks.get(id)?.file;
          const last = groups[groups.length - 1];
          if (last && file && last.file === file) last.ids.push(id);
          else groups.push({ file, ids: [id] });
        }
        return groups.map(({ file, ids: group }) => {
          if (!file) {
            return (
              <Text key={`gone:${group[0]}`} dimColor>
                {group[0]} is no longer in the diff.
              </Text>
            );
          }
          const { dir, base } = splitPath(file.path);
          return (
            <Box key={`group:${group[0]}`} flexDirection="column" gap="xs">
              <Box flexDirection="row" gap="sm" alignItems="center" flexWrap="wrap">
                {pill(file.status)}
                <Button
                  key={`hunk-open:${group[0]}`}
                  plain
                  onPress={() => setView($, { mode: 'files', selected: file.path })}
                >
                  <Text dimColor mono>
                    {dir}
                  </Text>
                  <Text weight="semibold" mono>
                    {base}
                  </Text>
                </Button>
                {group.length > 1 ? (
                  <Text size="footnote" dimColor>
                    {group.length} hunks
                  </Text>
                ) : null}
              </Box>
              {group.map((id) => {
                const note = notes.find((n) => n.hunkId === id)?.body;
                return [
                  note ? (
                    <Text key={`note:${id}`} italic size="footnote">
                      {note}
                    </Text>
                  ) : null,
                  hunks.get(id)!.hunk.text ? (
                    <Code
                      format="diff"
                      path={file.path}
                      source={hunks.get(id)!.hunk.text}
                      wrap={wrap}
                    />
                  ) : (
                    <Text key={`summary:${id}`} dimColor>
                      {hunks.get(id)!.hunk.summary ?? 'No textual changes.'}
                    </Text>
                  ),
                ];
              })}
            </Box>
          );
        });
      };

      let page;
      const current = stops[index];
      if (current) {
        const { chapter, stop } = current;
        page = (
          <Box flexDirection="column" gap="sm">
            <Box flexDirection="row" gap="sm" alignItems="center">
              {icon(chapterIcon(chapter.icon), ACCENT, 13, 'suggestion')}
              <Text size="footnote" dimColor>
                {chapter.title.toUpperCase()} · STOP {index + 1} OF {stops.length}
              </Text>
            </Box>
            <Text size="title" weight="semibold">
              {stop.title}
            </Text>
            {stop.summary ? (
              <Box borderStyle="quote" borderColor="suggestion" paddingLeft={1}>
                <Text weight="medium">{stop.summary}</Text>
              </Box>
            ) : null}
            {stop.prose ? <Markdown text={stop.prose} /> : null}
            {hunkGroups(stop.hunkIds, stop.notes)}
          </Box>
        );
      } else {
        let budget = DRAW_BUDGET;
        const groups = walkthrough.support.map((group) => ({
          ...group,
          hunkIds: group.hunkIds.filter((id) => {
            budget -= hunks.get(id)?.hunk.text.length ?? 0;
            return budget >= 0;
          }),
        }));
        const hidden =
          walkthrough.support.reduce((sum, group) => sum + group.hunkIds.length, 0) -
          groups.reduce((sum, group) => sum + group.hunkIds.length, 0);
        page = (
          <Box flexDirection="column" gap="sm">
            <Text size="footnote" dimColor>
              OFF THE MAIN PATH
            </Text>
            <Text size="title" weight="semibold">
              Supporting changes
            </Text>
            {groups.map((group) =>
              group.hunkIds.length ? (
                <Box key={`support:${group.id}`} flexDirection="column" gap="xs">
                  <Text weight="semibold">
                    {group.reason}
                    {group.summary ? (
                      <Text dimColor weight="regular">
                        {' '}
                        · {group.summary}
                      </Text>
                    ) : null}
                  </Text>
                  {hunkGroups(group.hunkIds)}
                </Box>
              ) : null,
            )}
            {hidden > 0 ? <Text dimColor>{hidden} more hunks are not drawn here.</Text> : null}
          </Box>
        );
      }

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column" gap="xs">
            <Box flexDirection="row" gap="sm" alignItems="center">
              {icon('sparkle', ACCENT, 18, 'suggestion')}
              <Text size="title" weight="semibold">
                {walkthrough.title}
              </Text>
            </Box>
            {walkthrough.focus ? <Text dimColor>{walkthrough.focus}</Text> : null}
            {progress}
          </Box>
          <Box flexDirection={wide ? 'row' : 'column'} gap={wide ? 2 : 1}>
            {wide || view.outline ? outline : null}
            {wide ? null : (
              <Button
                key="outline"
                label={`${view.outline ? 'Hide' : 'Show'} outline · ${stops.length} stops`}
                hotkey="o"
                onPress={() => setView($, { outline: !view.outline })}
              />
            )}
            <Box flexDirection="column" flexGrow={1} gap={1}>
              {page}
              <Box flexDirection="row" justifyContent="space-between" alignItems="center">
                <Button
                  key="prev-stop"
                  label="← Previous"
                  hotkey="k"
                  onPress={() => goTo(Math.max(0, index - 1))}
                />
                <Text size="footnote" dimColor tabular>
                  {index + 1} of {total}
                </Text>
                <Button
                  key="next-stop"
                  label={index + 1 < total ? 'Next stop →' : 'Done'}
                  hotkey="j"
                  variant="primary"
                  onPress={() =>
                    index + 1 < total ? goTo(index + 1) : setView($, { mode: 'files' })
                  }
                />
              </Box>
            </Box>
          </Box>
        </Box>
      );
    };

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {view.mode === 'files' ? filesView() : walkthroughView()}
      </Box>
    );
  });
};
