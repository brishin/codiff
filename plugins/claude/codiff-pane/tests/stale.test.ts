import { expect, mock, test } from 'claude-code/testing';

test('a walkthrough stored by an older version still draws', async ($, on) => {
  mock.store(on);
  on('session.cwd', () => ({ value: '/repo' }));
  on('ui.open', () => ({ value: { isPlaced: true } }));
  on('fs.read', () => ({ deny: 'not a Codiff checkout' }));
  on('process.run', (_$, e) => ({
    value: {
      exitCode: 0,
      stdout:
        e.argv[0] === 'git'
          ? '/repo\n'
          : JSON.stringify({
              kind: 'codiff-review',
              branch: 'main',
              root: '/repo',
              files: [
                {
                  added: 1,
                  deleted: 0,
                  generated: false,
                  path: 'a.ts',
                  status: 'modified',
                  hunks: [
                    {
                      added: 1,
                      deleted: 0,
                      id: 'a.ts:unstaged:h1',
                      kind: 'patch',
                      section: 'unstaged',
                      patch: '@@ -1 +1 @@\n-a\n+b',
                    },
                  ],
                },
              ],
              walkthrough: null,
            }),
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }));
  // The pre-Codiff-CLI shapes, which survive a hot reload in session state.
  const STALE: Record<string, unknown> = {
    walkthrough: {
      status: 'ready',
      generatedAt: 1,
      walkthrough: {
        title: 'Old',
        focus: '',
        chapters: [
          {
            id: 'c',
            title: 'C',
            blurb: '',
            stops: [{ id: 's', title: 'S', summary: '', prose: '', hunkIds: ['a.ts:h1'] }],
          },
        ],
        support: ['b.ts:h1'],
      },
    },
    agent: { model: 'sonnet', effort: 'medium' },
  };
  on('state.get', (_$, e, next) =>
    e.plugin === 'codiff-pane' && e.key in STALE
      ? { value: { value: STALE[e.key], version: 1 } }
      : next(e),
  );
  await $.command.run({ command: 'codiff', args: '' } as never);
  const ui = await $.ui.mount({
    plugin: 'codiff-pane',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'codiff',
    props: { title: 'Codiff', isFocused: true, bodyColumns: 140 } as never,
  });
  await ui.press({ key: 'mode-walkthrough' });
  expect(await ui.find({ key: 'generate' })).toBeDefined();
});
