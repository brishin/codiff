import type {
  DiffFile,
  DiffHunk,
  FileStatus,
  Scope,
  Walkthrough,
  WalkthroughChapter,
  WalkthroughStop,
} from '../types';

// What `codiff --json` prints (electron/headless-review-export.cjs).
type CodiffHunk = {
  added: number;
  deleted: number;
  id: string;
  kind: 'patch' | 'synthetic';
  patch?: string;
  section: string;
  summary?: string;
};
type CodiffFile = {
  added: number;
  deleted: number;
  generated: boolean;
  hunks: CodiffHunk[];
  oldPath?: string;
  path: string;
  status: FileStatus;
};
type CodiffGroup = {
  hunkIds?: string[];
  id?: string;
  notes?: { body: string; hunkId: string }[];
  summary?: string;
  title?: string;
};
export type CodiffReview = {
  branch: string | null;
  files: CodiffFile[];
  kind: 'codiff-review';
  root: string;
  source?: { type: string; number?: number; title?: string };
  walkthrough: null | {
    agent: string;
    chapters: (CodiffGroup & {
      blurb?: string;
      icon?: string;
      stops: (CodiffGroup & { importance?: string; prose?: string })[];
    })[];
    commit?: { body?: string; title?: string };
    focus?: string;
    support: (CodiffGroup & { reason?: string })[];
    title?: string;
  };
};

// Reads the CLI's output, the last stdout line, so a login shell's chatter cannot break it.
export function parseCodiffReview(stdout: string): CodiffReview {
  const line = stdout.trim().split('\n').pop() ?? '';
  let review: CodiffReview;
  try {
    review = JSON.parse(line) as CodiffReview;
  } catch {
    throw new Error(
      'Codiff did not print a review. Is the installed Codiff new enough for --json?',
    );
  }
  if (review?.kind !== 'codiff-review')
    throw new Error('Codiff printed something other than a review.');
  return review;
}

// Keeps the hunks of one section when the pane compares staged or unstaged changes alone.
export function toDiffFiles(files: readonly CodiffFile[], scope: Scope = 'all'): DiffFile[] {
  const section = scope === 'staged' ? 'staged' : scope === 'unstaged' ? 'unstaged' : null;
  return files
    .map((file) => {
      const hunks: DiffHunk[] = file.hunks
        .filter((hunk) => !section || hunk.section === section)
        .map((hunk) => ({
          id: hunk.id,
          kind: hunk.kind,
          section: hunk.section,
          header: hunk.patch?.split('\n', 1)[0] ?? '',
          text: hunk.patch ?? '',
          ...(hunk.summary ? { summary: hunk.summary } : {}),
          added: hunk.added,
          deleted: hunk.deleted,
        }));
      return {
        path: file.path,
        ...(file.oldPath ? { oldPath: file.oldPath } : {}),
        status: file.status,
        generated: file.generated,
        added: section ? hunks.reduce((sum, hunk) => sum + hunk.added, 0) : file.added,
        deleted: section ? hunks.reduce((sum, hunk) => sum + hunk.deleted, 0) : file.deleted,
        hunks,
      };
    })
    .filter((file) => !section || file.hunks.length > 0);
}

export function toWalkthrough(input: NonNullable<CodiffReview['walkthrough']>): Walkthrough {
  const chapters: WalkthroughChapter[] = input.chapters.map((chapter, c) => ({
    id: chapter.id ?? `c${c + 1}`,
    title: chapter.title ?? `Part ${c + 1}`,
    icon: chapter.icon ?? 'path',
    blurb: chapter.blurb ?? '',
    stops: chapter.stops.map((stop, s): WalkthroughStop => ({
      id: stop.id ?? `c${c + 1}s${s + 1}`,
      title: stop.title ?? `Step ${s + 1}`,
      summary: stop.summary ?? '',
      prose: stop.prose ?? '',
      importance: stop.importance ?? 'normal',
      hunkIds: stop.hunkIds ?? [],
      ...(stop.notes?.length ? { notes: stop.notes } : {}),
    })),
  }));
  return {
    title: input.title ?? 'Walkthrough',
    focus: input.focus ?? '',
    agent: input.agent,
    chapters,
    support: input.support.map((group, g) => ({
      id: group.id ?? `support${g + 1}`,
      reason: group.reason ?? 'Supporting',
      ...(group.summary ? { summary: group.summary } : {}),
      hunkIds: group.hunkIds ?? [],
    })),
    ...(input.commit ? { commit: input.commit } : {}),
  };
}

export type TreeRow =
  | { kind: 'dir'; path: string; name: string; depth: number }
  | { kind: 'file'; path: string; name: string; depth: number; file: DiffFile };

type Node = { name: string; path: string; dirs: Map<string, Node>; files: DiffFile[] };

// Builds Codiff-style tree rows, folding single-child directory chains into one row.
export function buildTree(files: readonly DiffFile[]): TreeRow[] {
  const root: Node = { name: '', path: '', dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const path = node.path ? `${node.path}/${part}` : part;
      let next = node.dirs.get(part);
      if (!next) {
        next = { name: part, path, dirs: new Map(), files: [] };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.push(file);
  }

  const rows: TreeRow[] = [];
  const walk = (node: Node, depth: number) => {
    for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      let folded = dir;
      let name = dir.name;
      while (folded.files.length === 0 && folded.dirs.size === 1) {
        folded = [...folded.dirs.values()][0]!;
        name = `${name}/${folded.name}`;
      }
      rows.push({ kind: 'dir', path: folded.path, name, depth });
      walk(folded, depth + 1);
    }
    for (const file of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({ kind: 'file', path: file.path, name: file.path.split('/').pop()!, depth, file });
    }
  };
  walk(root, 0);
  return rows;
}

export function fileSource(file: DiffFile) {
  return file.hunks
    .map((hunk) => hunk.text)
    .filter(Boolean)
    .join('\n');
}

export function hunkIndex(files: readonly DiffFile[]) {
  const index = new Map<string, { file: DiffFile; hunk: DiffHunk }>();
  for (const file of files) for (const hunk of file.hunks) index.set(hunk.id, { file, hunk });
  return index;
}

export function flattenStops(walkthrough: Walkthrough) {
  return walkthrough.chapters.flatMap((chapter, c) =>
    chapter.stops.map((stop, s) => ({ chapter, chapterIndex: c, stop, stopIndex: s })),
  );
}
