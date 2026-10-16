import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';
import { readCachedNarrativeWalkthrough } from '../../electron/cached-narrative-walkthrough.cjs';
import { createTemporaryEnvironment } from './helpers/resources.ts';

let home = '';
let environment: Disposable;

beforeEach(async () => {
  // The store lives under ~/.codiff/walkthroughs.
  home = await mkdtemp(join(tmpdir(), 'codiff-walkthrough-cache-'));
  environment = createTemporaryEnvironment({ HOME: home });
});

afterEach(async () => {
  environment[Symbol.dispose]();
  await rm(home, { force: true, recursive: true });
});

const createState = (patch: string) => ({
  branch: 'main',
  files: [
    {
      fingerprint: patch,
      path: 'app.ts',
      sections: [{ binary: false, id: 'app.ts:unstaged', kind: 'unstaged', patch }],
      status: 'modified',
    },
  ],
  generatedAt: '2026-10-15T00:00:00.000Z',
  root: '/repo',
  source: { type: 'working-tree' },
});

const createAgent = (title: string) => ({
  defaultTimeoutMs: 1000,
  fallbackModel: 'fallback',
  id: 'claude',
  label: 'Claude',
  normalizeModel: (model: unknown) => String(model ?? 'default'),
  run: vi.fn(async () =>
    JSON.stringify({
      chapters: [
        {
          blurb: 'Behavior.',
          icon: 'path',
          id: 'c1',
          stops: [
            {
              hunkIds: ['app.ts:unstaged:h1'],
              id: 's1',
              prose: 'Swaps the value.',
              summary: 'Swaps a for b.',
              title: 'Swap the value',
            },
          ],
          title: 'Runtime',
        },
      ],
      focus: 'One swap.',
      kind: 'narrative',
      support: [],
      title,
      version: 4,
    }),
  ),
});

const generate = (
  state: ReturnType<typeof createState>,
  agent: ReturnType<typeof createAgent>,
  options?: { force?: boolean },
) =>
  readCachedNarrativeWalkthrough(
    state as never,
    agent as never,
    { model: 'sonnet' },
    null,
    undefined,
    options,
  );

test('an unchanged diff reuses the stored walkthrough without running the agent', async () => {
  const state = createState('@@ -1 +1 @@\n-a\n+b');
  const first = createAgent('First');
  expect(await generate(state, first)).toMatchObject({
    status: 'ready',
    walkthrough: { title: 'First' },
  });

  const second = createAgent('Second');
  expect(await generate(state, second)).toMatchObject({
    status: 'ready',
    walkthrough: { title: 'First' },
  });
  expect(second.run).not.toHaveBeenCalled();
});

test('force and a changed diff both run the agent again', async () => {
  await generate(createState('@@ -1 +1 @@\n-a\n+b'), createAgent('First'));

  const forced = createAgent('Forced');
  expect(await generate(createState('@@ -1 +1 @@\n-a\n+b'), forced, { force: true })).toMatchObject(
    {
      walkthrough: { title: 'Forced' },
    },
  );
  expect(forced.run).toHaveBeenCalledOnce();

  const changed = createAgent('Changed');
  expect(await generate(createState('@@ -1 +1 @@\n-a\n+c'), changed)).toMatchObject({
    walkthrough: { title: 'Changed' },
  });
  expect(changed.run).toHaveBeenCalledOnce();
});
