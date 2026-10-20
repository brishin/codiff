// Codiff's own file statuses (core/types.ts GitFileStatus).
export type FileStatus = 'added' | 'conflicted' | 'deleted' | 'modified' | 'renamed' | 'untracked';

export type DiffHunk = {
  // Codiff's walkthrough hunk id, `<path>:<section>:h<n>`: what walkthrough stops name.
  id: string;
  // `synthetic` hunks stand for generated, binary, or metadata-only changes.
  kind: 'patch' | 'synthetic';
  section: string;
  header: string;
  text: string;
  summary?: string;
  added: number;
  deleted: number;
};

export type DiffFile = {
  path: string;
  oldPath?: string;
  status: FileStatus;
  generated: boolean;
  added: number;
  deleted: number;
  hunks: DiffHunk[];
};

export type Review = {
  root: string;
  branch: string | null;
  label: string;
  files: DiffFile[];
  loadedAt: number;
};

export type ReviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; review: Review }
  | { status: 'error'; error: string };

export type Scope = 'all' | 'staged' | 'unstaged' | 'branch' | 'pull-request';
export type Mode = 'files' | 'walkthrough';

export type ViewState = {
  mode: Mode;
  // null shows every file.
  selected: string | null;
  scope: Scope;
  // The pull request `/codiff <number>` opened; reviewed while scope is `pull-request`.
  pullRequest: number | null;
  wrap: boolean;
  showTree: boolean;
  collapsed: string[];
  viewed: string[];
  stop: number;
  // The View or Agent options panel is open.
  menu: boolean;
  // Narrow panes show the walkthrough outline only on request.
  outline: boolean;
};

// Which Codiff agent backend writes walkthroughs; `default` is Codiff's own setting.
export type AgentSettings = {
  agent: 'default' | 'claude' | 'codex' | 'opencode' | 'pi';
};

export type WalkthroughStop = {
  id: string;
  title: string;
  summary: string;
  prose: string;
  importance: string;
  hunkIds: string[];
  notes?: { hunkId: string; body: string }[];
};

export type WalkthroughChapter = {
  id: string;
  title: string;
  icon: string;
  blurb: string;
  stops: WalkthroughStop[];
};

export type WalkthroughSupport = {
  id: string;
  reason: string;
  summary?: string;
  hunkIds: string[];
};

export type Walkthrough = {
  title: string;
  focus: string;
  agent: string;
  chapters: WalkthroughChapter[];
  support: WalkthroughSupport[];
  commit?: { title?: string; body?: string };
};

export type WalkthroughState =
  | { status: 'idle' }
  | { status: 'loading'; startedAt: number }
  // `files` is the diff the walkthrough was anchored against, so its hunk ids always resolve.
  | { status: 'ready'; walkthrough: Walkthrough; files: DiffFile[]; generatedAt: number }
  | { status: 'error'; error: string };

declare module 'claude-code' {
  interface PluginState {
    'codiff-pane': {
      review: ReviewState;
      view: ViewState;
      agent: AgentSettings;
      walkthrough: WalkthroughState;
    };
  }
}
