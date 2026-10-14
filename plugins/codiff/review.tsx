import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReviewSurface } from '../../core/react.ts';
import type { SharedWalkthroughSnapshot } from '../../core/types.ts';
import { useOnlineCodiffPreferences } from '../../web/src/ReviewSettings.tsx';
import { CodiffMenu } from './CodiffMenu.tsx';
import { ViewMenu } from './ViewMenu.tsx';
import '../../core/App.css';

type Review = {
  comparison: string;
  snapshot: SharedWalkthroughSnapshot;
  threadId: string;
  threadTitle: string;
};
type RpcResponse = {
  error?: { message: string };
  id?: number;
  jsonrpc?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
};
let nextId = 0;
const pending = new Map<
  number,
  {
    reject: (error: Error) => void;
    resolve: (value: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const listeners = new Set<(value: unknown) => void>();
window.addEventListener('message', (event: MessageEvent<RpcResponse>) => {
  if (event.source !== window.parent || event.data?.jsonrpc !== '2.0') {
    return;
  }
  const message = event.data;
  const request = message.id == null ? null : pending.get(message.id);
  if (request && message.id != null) {
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) {
      request.reject(new Error(message.error.message));
    } else {
      request.resolve(message.result);
    }
  }
  if (message.method === 'ui/notifications/tool-result') {
    listeners.forEach((listener) => listener(message.params));
  }
});
const rpc = (method: string, params: unknown, timeoutMs = 45_000) =>
  new Promise<unknown>((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('The desktop request timed out. Try Refresh.'));
    }, timeoutMs);
    pending.set(id, { reject, resolve, timer });
    window.parent.postMessage({ id, jsonrpc: '2.0', method, params }, '*');
  });
const getReview = (result: unknown): Review | null => {
  const value = (result as { structuredContent?: Review })?.structuredContent;
  return value?.snapshot?.kind === 'codiff-walkthrough-share' ? value : null;
};

function ThreadReview() {
  const [isMcpView, setIsMcpView] = useState(false);
  const [preferences, setPreferences] = useOnlineCodiffPreferences({});
  const [expandUnchanged, setExpandUnchanged] = useState(() => {
    try {
      return localStorage.getItem('codiff:thread-expand-unchanged') === 'true';
    } catch {
      return false;
    }
  });
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [walkthroughStatus, setWalkthroughStatus] = useState<
    'idle' | 'generating' | 'ready' | 'failed'
  >('idle');
  const [walkthroughError, setWalkthroughError] = useState('');
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const requestRevision = ++revision.current;
    setLoading(true);
    setError('');
    try {
      const result = await rpc('tools/call', { arguments: {}, name: 'review_refresh' });
      const value = getReview(result);
      if (!value) {
        throw new Error(
          (result as { content?: Array<{ text: string }> })?.content?.[0]?.text ||
            'No review was returned.',
        );
      }
      if (revision.current !== requestRevision) {
        return;
      }
      setReview(value);
      setWalkthroughStatus('idle');
      setWalkthroughError('');
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);
  const generateWalkthrough = useCallback(async () => {
    const requestRevision = revision.current;
    setWalkthroughStatus('generating');
    setWalkthroughError('');
    try {
      const result = await rpc(
        'tools/call',
        { arguments: {}, name: 'review_walkthrough' },
        20 * 60_000,
      );
      if (revision.current !== requestRevision) {
        return;
      }
      const value = getReview(result);
      if (!value) {
        throw new Error(
          (result as { content?: Array<{ text: string }> })?.content?.[0]?.text ||
            'No walkthrough was returned.',
        );
      }
      setReview(value);
      setWalkthroughStatus('ready');
    } catch (error) {
      if (revision.current === requestRevision) {
        setWalkthroughError(error instanceof Error ? error.message : String(error));
        setWalkthroughStatus('failed');
      }
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('codiff:thread-expand-unchanged', String(expandUnchanged));
    } catch {
      /* Keep the preference in memory when storage is unavailable. */
    }
  }, [expandUnchanged]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        if (!loading) {
          void refresh();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [loading, refresh]);
  useEffect(() => {
    let active = true;
    let acceptInitialResult = true;
    const update = (result: unknown) => {
      const value = getReview(result);
      if (active && acceptInitialResult && value) {
        acceptInitialResult = false;
        setReview(value);
        setLoading(false);
      }
    };
    listeners.add(update);
    void rpc('ui/initialize', {
      appCapabilities: {},
      appInfo: { name: 'Codiff', version: '0.7.3' },
      protocolVersion: '2026-01-26',
    })
      .then((result) => {
        if (!active) {
          return;
        }
        const host = result as { hostInfo?: { name?: string }; protocolVersion?: string };
        if (typeof host?.hostInfo?.name !== 'string' || typeof host?.protocolVersion !== 'string') {
          throw new Error('This view requires an MCP Apps host.');
        }
        setIsMcpView(true);
        acceptInitialResult = false;
        window.parent.postMessage(
          { jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} },
          '*',
        );
        // Host-delivered initial results render first. Refresh also covers remounts.
        return refresh();
      })
      .catch((error: unknown) => {
        if (active) {
          setError(error instanceof Error ? error.message : String(error));
          setLoading(false);
        }
      });
    return () => {
      active = false;
      listeners.delete(update);
    };
  }, [refresh]);
  return (
    <div className="thread-review">
      <header className="thread-review-header">
        <div>
          <strong>Codiff</strong>
        </div>
        {isMcpView ? (
          <div className="thread-review-menus">
            <CodiffMenu call={rpc} />
            <ViewMenu
              expandUnchanged={expandUnchanged}
              loading={loading}
              preferences={preferences}
              refresh={refresh}
              setExpandUnchanged={setExpandUnchanged}
              setPreferences={setPreferences}
            />
          </div>
        ) : null}
      </header>
      {error ? (
        <div className="thread-review-error" role="alert">
          {error}
        </div>
      ) : null}
      {review ? (
        <div className="thread-review-surface">
          <ReviewSurface
            expandUnchanged={expandUnchanged}
            initialMode="tree"
            snapshot={{ ...review.snapshot, preferences }}
            title={review.threadTitle}
            walkthroughGeneration={{
              onGenerateWalkthrough: generateWalkthrough,
              walkthroughError,
              walkthroughStatus,
            }}
          />
        </div>
      ) : (
        <div className="thread-review-empty" role="status">
          {error ? 'Refresh to try again.' : 'Loading checkout changes…'}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<ThreadReview />);
