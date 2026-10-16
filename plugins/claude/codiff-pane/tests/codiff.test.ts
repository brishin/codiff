import type { On } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';

const SURFACES = ['terminal', 'desktop'] as const;

const hunk = (id: string, section: string, patch: string, added: number, deleted: number) => ({
  added,
  deleted,
  id,
  kind: 'patch',
  patch,
  section,
});

// What `codiff --json` prints for this checkout.
const FILES = [
  {
    added: 2,
    deleted: 1,
    generated: false,
    path: 'src/app.ts',
    status: 'modified',
    hunks: [
      hunk(
        'src/app.ts:staged:h1',
        'staged',
        "@@ -1,2 +1,3 @@\n import { start } from './start'\n+import { log } from './log'\n start()",
        1,
        0,
      ),
      hunk(
        'src/app.ts:unstaged:h1',
        'unstaged',
        '@@ -10 +11 @@ export function stop() {\n-  return false\n+  return true',
        1,
        1,
      ),
    ],
  },
  {
    added: 1,
    deleted: 0,
    generated: false,
    path: 'src/log.ts',
    status: 'untracked',
    hunks: [
      hunk(
        'src/log.ts:unstaged:h1',
        'unstaged',
        '@@ -0,0 +1 @@\n+export const log = console.log',
        1,
        0,
      ),
    ],
  },
  {
    added: 3,
    deleted: 1,
    generated: true,
    path: 'pnpm-lock.yaml',
    status: 'modified',
    hunks: [
      {
        added: 3,
        deleted: 1,
        id: 'pnpm-lock.yaml:unstaged:h1',
        kind: 'synthetic',
        section: 'unstaged',
        summary: 'Lockfile collapsed into one generated-file review unit.',
      },
    ],
  },
];

const WALKTHROUGH = {
  agent: 'claude',
  title: 'Logging start-up',
  focus: 'Adds a logger and flips stop().',
  chapters: [
    {
      id: 'runtime',
      title: 'Runtime',
      icon: 'wrench',
      blurb: 'Behavior changes.',
      stops: [
        {
          id: 's1',
          title: 'Introduce the logger',
          summary: 'A new `log` helper is imported at start-up.',
          prose: 'The helper lives in `src/log.ts`.',
          importance: 'critical',
          hunkIds: ['src/log.ts:unstaged:h1', 'src/app.ts:staged:h1'],
        },
        {
          id: 's2',
          title: 'Report a clean stop',
          summary: '`stop()` now returns true.',
          prose: '',
          importance: 'normal',
          hunkIds: ['src/app.ts:unstaged:h1'],
        },
      ],
    },
  ],
  support: [{ id: 'g1', reason: 'Lockfile', hunkIds: ['pnpm-lock.yaml:unstaged:h1'] }],
};

function fakeCheckout(on: On) {
  const calls: string[][] = [];
  const clock = mock.clock(on);
  mock.store(on);
  on('session.cwd', () => ({ value: '/repo' }));
  on('session.id', () => ({ value: 'session-1' }));
  on('ui.open', () => ({ value: { isPlaced: true } }));
  on('fs.read', () => ({ deny: 'not a Codiff checkout' }));
  on('process.run', (_$, e) => {
    const out = (stdout: string) => ({
      value: {
        exitCode: 0,
        stdout,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    });
    if (e.argv[0] === 'git') return out(e.argv.includes('--show-toplevel') ? '/repo\n' : '');
    calls.push([...e.argv, `CODIFF_PATH=${e.init?.env?.CODIFF_PATH ?? ''}`]);
    const walkthrough = e.argv.includes('--walkthrough') ? WALKTHROUGH : null;
    const pullRequest = e.argv.find((arg) => arg.startsWith('#'));
    const source = pullRequest
      ? { type: 'pull-request', number: Number(pullRequest.slice(1)), title: 'Add logging' }
      : { type: 'working-tree' };
    return out(
      `${JSON.stringify({ kind: 'codiff-review', branch: 'feature', root: '/repo', source, files: FILES, walkthrough })}\n`,
    );
  });
  return { calls, clock };
}

const PANE = { plugin: 'codiff-pane', component: 'Pane', requestId: 'codiff' } as const;
const PANE_PROPS = { title: 'Codiff', isFocused: true, bodyColumns: 140 } as never;

for (const surface of SURFACES) {
  test(`files view reads Codiff's hunks and drills into one file (${surface})`, async ($, on) => {
    const { calls } = fakeCheckout(on);
    await $.command.run({ command: 'codiff', args: '' } as never);
    const ui = await $.ui.mount({ ...PANE, surface, props: PANE_PROPS });

    expect(calls[0]?.slice(-3, -1)).toEqual(['--json', '/repo']);
    expect(await ui.find({ text: 'feature' })).toBeDefined();
    expect(await ui.find({ key: 'tree:src/log.ts' })).toBeDefined();
    // The lockfile is one synthetic hunk with no patch: its summary stands in.
    expect(await ui.find({ text: /Lockfile collapsed/ })).toBeDefined();
    expect(await ui.findAll({ type: 'Code' })).toHaveLength(2);

    await ui.press({ key: 'tree:src/app.ts' });
    const codes = await ui.findAll({ type: 'Code' });
    expect(codes).toHaveLength(1);
    // Staged and unstaged hunks of one file draw as one diff.
    expect(String(codes[0]?.props.source)).toContain('+import { log }');
    expect(String(codes[0]?.props.source)).toContain('+  return true');

    await ui.press({ key: 'next-file' });
    expect((await ui.findAll({ type: 'Code' }))[0]?.props.path).toBe('src/log.ts');
    await ui.press({ key: 'prev-file' });
    expect((await ui.find({ key: 'viewed:src/app.ts' }))?.props.label).toBe('☑ Viewed');
  });

  test(`walkthrough runs Codiff's pipeline and renders its stops (${surface})`, async ($, on) => {
    const { calls, clock } = fakeCheckout(on);
    await $.command.run({ command: 'codiff', args: '' } as never);
    const ui = await $.ui.mount({ ...PANE, surface, props: PANE_PROPS });

    await ui.press({ key: 'mode-walkthrough' });
    await ui.press({ key: 'generate' });
    // The press only queues the run on a timer and shows progress until it fires.
    expect(await ui.find({ text: /Writing your walkthrough/ })).toBeDefined();
    await clock.settle();
    const walkthroughCall = calls.find((argv) => argv.includes('--walkthrough'));
    expect(walkthroughCall).toEqual(
      expect.arrayContaining(['--json', '--claude-session', 'session-1']),
    );
    expect(walkthroughCall).not.toContain('--agent');

    expect(await ui.find({ text: 'Introduce the logger' })).toBeDefined();
    expect((await ui.findAll({ type: 'Code' })).map((c) => c.props.path)).toEqual([
      'src/log.ts',
      'src/app.ts',
    ]);

    await ui.press({ key: 'next-stop' });
    await ui.press({ key: 'next-stop' });
    expect(await ui.find({ text: /Lockfile collapsed/ })).toBeDefined();
  });
}

test('the staged comparison keeps only staged hunks', async ($, on) => {
  fakeCheckout(on);
  await $.command.run({ command: 'codiff', args: '' } as never);
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS });

  await ui.press({ key: 'menu' });
  await ui.select({ key: 'scope', value: 'staged' });

  const codes = await ui.findAll({ type: 'Code' });
  expect(codes.map((c) => c.props.path)).toEqual(['src/app.ts']);
  expect(String(codes[0]?.props.source)).not.toContain('return true');
});

test('/codiff <number> reviews that pull request and leaves it on a bare /codiff', async ($, on) => {
  const { calls, clock } = fakeCheckout(on);
  expect(await $.command.run({ command: 'codiff', args: '#12' } as never)).toMatchObject({
    text: 'Codiff opened PR #12.',
  });
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS });
  expect(calls.at(-1)).toEqual(expect.arrayContaining(['--json', '#12', '/repo']));
  expect(await ui.find({ text: 'PR #12: Add logging' })).toBeDefined();

  // The walkthrough runs against the pull request too.
  await ui.press({ key: 'mode-walkthrough' });
  await ui.press({ key: 'generate' });
  await clock.settle();
  expect(calls.find((argv) => argv.includes('--walkthrough'))).toEqual(
    expect.arrayContaining(['#12']),
  );
  expect(await ui.find({ text: 'Introduce the logger' })).toBeDefined();

  // Leaving the pull request drops its walkthrough rather than showing it over the working tree.

  await $.command.run({ command: 'codiff', args: '' } as never);
  expect(calls.at(-1)).not.toContain('#12');
  expect(await ui.find({ key: 'generate' })).toBeDefined();
  await ui.press({ key: 'mode-files' });
  expect(await ui.find({ text: /^Working tree/ })).toBeDefined();

  expect(await $.command.run({ command: 'codiff', args: 'walkthrough' } as never)).toMatchObject({
    text: 'Usage: /codiff [PR number]',
  });
});

test(
  'the codiffPath setting picks the CLI the pane runs',
  { options: { codiffPath: ' ~/codiff/bin/codiff.js ' } },
  async ($, on) => {
    const { calls } = fakeCheckout(on);
    await $.command.run({ command: 'codiff', args: '' } as never);
    expect(calls[0]).toContain('CODIFF_PATH=~/codiff/bin/codiff.js');
  },
);

test('without codiffPath the pane runs codiff from the PATH', async ($, on) => {
  const { calls } = fakeCheckout(on);
  await $.command.run({ command: 'codiff', args: '' } as never);
  expect(calls[0]).toContain('CODIFF_PATH=');
});
