import { useCallback, useSyncExternalStore } from 'react';
import { engineerRequest, EngineerRequestError, streamEngineerEvents, type EngineerEvent, type EngineerStatus } from '@/agent/engineClient';

type Snapshot = { state: EngineerStatus | null; events: EngineerEvent[]; error: string };
const empty: Snapshot = { state: null, events: [], error: '' };
type Session = { snapshot: Snapshot; listeners: Set<() => void>; abort: AbortController; refresh: () => Promise<void> };
const sessions = new Map<string, Session>();

function open(projectId: string): Session {
  const abort = new AbortController();
  const listeners = new Set<() => void>();
  const session: Session = { abort, listeners, snapshot: empty, refresh };
  let pending: Promise<void> | undefined;
  let refreshAgain = false;
  function update(patch: Partial<Snapshot>) {
    if (abort.signal.aborted) return;
    session.snapshot = { ...session.snapshot, ...patch };
    listeners.forEach(notify => notify());
  }
  function refresh() {
    if (pending) {
      refreshAgain = true;
      return pending;
    }
    pending = engineerRequest<EngineerStatus>(projectId, 'state', undefined, abort.signal)
      .then(state => update({ state, error: '' }))
      .catch(error => {
        if (error instanceof EngineerRequestError && error.status === 404) update({ state: null, error: '' });
        else update({ error: error instanceof Error ? error.message : 'Engine unavailable.' });
      }).finally(() => {
        pending = undefined;
        if (refreshAgain && !abort.signal.aborted) {
          refreshAgain = false;
          void refresh();
        }
      });
    return pending;
  }
  async function listen() {
    let cursor = 0;
    let delay = 1000;
    while (!abort.signal.aborted) {
      try {
        await streamEngineerEvents(projectId, cursor, event => {
          if (event.seq <= cursor) return;
          cursor = event.seq; delay = 1000;
          if (event.type === 'token') return;
          update({ events: [...session.snapshot.events, event].slice(-100) });
          if (['status', 'verification', 'approval_required', 'completed', 'failed', 'cancelled', 'progress'].includes(event.type)) void refresh();
        }, abort.signal);
      } catch { /* Reconnect using the last persisted event cursor. */ }
      if (!abort.signal.aborted) await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 15000);
    }
  }
  const timer = setInterval(refresh, 15000);
  abort.signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  void refresh(); void listen();
  return session;
}

export function useEngineerSession(projectId?: string) {
  const subscribe = useCallback((notify: () => void) => {
    if (!projectId) return () => {};
    const session = sessions.get(projectId) ?? open(projectId);
    sessions.set(projectId, session); session.listeners.add(notify);
    return () => {
      session.listeners.delete(notify);
      if (!session.listeners.size) { session.abort.abort(); sessions.delete(projectId); }
    };
  }, [projectId]);
  const snapshot = useSyncExternalStore(subscribe, () => projectId ? sessions.get(projectId)?.snapshot ?? empty : empty);
  return { ...snapshot, refresh: () => projectId && sessions.get(projectId)?.refresh() };
}
