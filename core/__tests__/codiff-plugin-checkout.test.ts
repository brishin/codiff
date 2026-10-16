import { expect, test, vi } from 'vite-plus/test';
import { resolveCheckout } from '../../plugins/codiff/thread-review.mjs';

test('an explicit cwd skips the thread lookup', async () => {
  const read = vi.fn();
  await expect(resolveCheckout({}, '/work/codiff', read)).resolves.toEqual({
    cwd: '/work/codiff',
    name: 'codiff',
    threadId: null,
  });
  expect(read).not.toHaveBeenCalled();
});

test('a relative cwd is rejected before any lookup', async () => {
  const read = vi.fn();
  await expect(resolveCheckout({ threadId: 't1' }, 'codiff', read)).rejects.toThrow(
    'absolute path',
  );
  expect(read).not.toHaveBeenCalled();
});

test('without cwd the host thread resolves the checkout', async () => {
  const read = vi.fn(async () => ({ cwd: '/work/app', id: 't1', name: 'Fix login' }));
  await expect(resolveCheckout({ threadId: 't1' }, undefined, read)).resolves.toEqual({
    cwd: '/work/app',
    name: 'Fix login',
    threadId: 't1',
  });
  expect(read).toHaveBeenCalledWith('t1');
});
