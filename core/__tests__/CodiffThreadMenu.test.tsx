/** @vitest-environment jsdom */

import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import { CodiffMenu } from '../../plugins/codiff/CodiffMenu.tsx';
import { renderReact, waitFor } from './helpers/react.tsx';

test('opening the thread Codiff menu renders loading and settings without clearing the viewer', async () => {
  let resolveSettings!: (value: unknown) => void;
  const call = vi.fn(
    () =>
      new Promise<unknown>((resolve) => {
        resolveSettings = resolve;
      }),
  );
  await using view = await renderReact(
    <>
      <p>Thread changes</p>
      <CodiffMenu call={call} />
    </>,
  );
  const button = view.container.querySelector<HTMLButtonElement>('[aria-label="Agent menu"]');
  expect(button).not.toBeNull();
  await act(async () => {
    button!.click();
  });
  await waitFor(() => expect(document.body.textContent).toContain('Loading settings…'));
  await act(async () => {
    resolveSettings({
      structuredContent: {
        agent: 'codex',
        agents: [{ id: 'codex', label: 'Codex' }],
        fastMode: false,
        model: 'example-model',
        models: [{ id: 'example-model', label: 'Example model' }],
        reasoningEffort: 'high',
        reasoningEfforts: ['', 'low', 'high'],
      },
    });
  });
  await waitFor(() => expect(document.body.textContent).toContain('Reasoning Effort'));
  expect(view.container.textContent).toContain('Thread changes');
  expect(call).toHaveBeenCalledWith('tools/call', { arguments: {}, name: 'agent_settings_read' });
  const model = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) => item.textContent === 'Model',
  );
  expect(model).toBeDefined();
  await act(async () => {
    model!.click();
  });
  await waitFor(() => expect(document.body.textContent).toContain('Example model'));
  expect(
    document.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent,
  ).toContain('Example model');
});
