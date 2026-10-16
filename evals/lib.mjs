import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { getSectionWalkthroughHunks } = require('../core/lib/narrative-walkthrough-diff.cjs');

export const root = dirname(import.meta.dirname);
export const runsRoot = join(root, 'evals', 'runs');

export const nowMs = () => performance.now();
export const roundMs = (value) => Math.round(value * 10) / 10;

export const defaultCasesPath = join(root, 'evals', 'cases.json');

export const readCases = async (casesPath = defaultCasesPath) =>
  JSON.parse(await readFile(casesPath, 'utf8'));

// A run records the cases file it used so judge and report read the same cases.
export const readRunCases = async (runDir) =>
  readCases((await readJson(join(runDir, 'run.json')))?.casesPath || defaultCasesPath);

export const resolveCaseRepo = (evalCase) =>
  evalCase.repo ? resolve(evalCase.repo.replace(/^~(?=\/|$)/, homedir())) : root;

export const resolveRunDir = (label) => resolve(runsRoot, label);

export const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

export const collectHunkIds = (files) =>
  files.flatMap((file) =>
    file.sections.flatMap((section) =>
      getSectionWalkthroughHunks(file, section).map((hunk) => hunk.id),
    ),
  );

const flattenWalkthroughGroups = (walkthrough) => [
  ...walkthrough.chapters.flatMap((chapter) => chapter.stops),
  ...(walkthrough.support || []),
];

export const getWalkthroughMetrics = (state, walkthrough) => {
  const allHunkIds = collectHunkIds(state.files);
  const knownHunkIds = new Set(allHunkIds);
  const mainHunkIds = walkthrough.chapters.flatMap((chapter) =>
    chapter.stops.flatMap((stop) => stop.hunkIds),
  );
  const supportHunkIds = (walkthrough.support || []).flatMap((item) => item.hunkIds);
  const referencedHunkIds = [...mainHunkIds, ...supportHunkIds];
  const uniqueReferencedHunkIds = new Set(referencedHunkIds);
  const unknownHunkIds = [...uniqueReferencedHunkIds].filter((id) => !knownHunkIds.has(id));
  const duplicateReferenceCount = referencedHunkIds.length - uniqueReferencedHunkIds.size;
  const proseChars = walkthrough.chapters.reduce(
    (total, chapter) =>
      total +
      chapter.blurb.length +
      chapter.stops.reduce(
        (stopTotal, stop) =>
          stopTotal +
          stop.prose.length +
          (stop.summary?.length || 0) +
          (stop.notes || []).reduce((noteTotal, note) => noteTotal + note.body.length, 0),
        0,
      ),
    0,
  );

  return {
    chapterCount: walkthrough.chapters.length,
    decisionCount: walkthrough.decisions?.length ?? 0,
    duplicateReferenceCount,
    groupCount: flattenWalkthroughGroups(walkthrough).length,
    hunkCount: allHunkIds.length,
    mainCoverage: allHunkIds.length === 0 ? 0 : mainHunkIds.length / allHunkIds.length,
    mainHunkCount: mainHunkIds.length,
    proseChars,
    stopCount: walkthrough.chapters.reduce((total, chapter) => total + chapter.stops.length, 0),
    supportHunkCount: supportHunkIds.length,
    totalCoverage: allHunkIds.length === 0 ? 0 : uniqueReferencedHunkIds.size / allHunkIds.length,
    unknownHunkIds,
  };
};

export const listAttemptDirs = async (runDir, caseId) => {
  const caseDir = join(runDir, caseId);
  const entries = await readdir(caseDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('attempt-'))
    .map((entry) => join(caseDir, entry.name))
    .sort();
};

export const median = (values) => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

export const average = (values) =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;

export const readJson = async (path, fallback = null) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
};
