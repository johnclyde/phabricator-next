import { useEffect, useRef, useState } from 'react';
import type { ConpherenceUpdate } from '../shared/conpherence-live';
import { useWorkspace } from './SessionGate';
import { onSessionLocked } from './session';

export type ConversationConnection = 'connecting' | 'live' | 'reconnecting';
interface ConversationTransport {
  request(after: number | null, signal: AbortSignal): Promise<ConpherenceUpdate>;
  refresh(): Promise<void>;
  status(value: ConversationConnection): void;
  active(): boolean;
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Exactly one read poll at a time. This transport has no mutation operation. */
export async function followConversationUpdates(transport: ConversationTransport, signal: AbortSignal): Promise<void> {
  let after: number | null = null, failures = 0;
  const active = () => !signal.aborted && transport.active();
  if (!active()) return;
  transport.status('connecting');
  while (active()) {
    try {
      const update = await transport.request(after, signal);
      if (!active()) return;
      if (!Number.isSafeInteger(update.accessEpoch) || update.accessEpoch < 0 || typeof update.changed !== 'boolean') throw new Error('Invalid conversation update response.');
      // A read hook may have retained its own error after the previous wake-up.
      // Heartbeats recover that read even when no further workspace write occurs.
      await transport.refresh();
      if (!active()) return;
      after = update.accessEpoch; failures = 0; transport.status('live');
    } catch {
      if (!active()) return;
      transport.status('reconnecting');
      // Failed requests never replay a message or other saved command.
      try { await delay(Math.min(30_000, 1_000 * 2 ** Math.min(failures++, 5)), signal); }
      catch { return; }
    }
  }
}

export function useConversationUpdates(enabled: boolean, online: boolean, refresh: () => Promise<void>) {
  const client = useWorkspace(), latest = useRef(refresh); latest.current = refresh;
  const [status, setStatus] = useState<ConversationConnection>('connecting');
  useEffect(() => {
    if (!enabled || !online || !client.isActive()) return;
    const controller = new AbortController(), locked = onSessionLocked(() => controller.abort());
    void followConversationUpdates({
      request: (after, signal) => client.request<ConpherenceUpdate>(`/api/conpherence/updates${after === null ? '' : `?after=${after}`}`, undefined, [], { signal }),
      refresh: () => latest.current(),
      status: setStatus,
      active: () => client.isActive(),
    }, controller.signal);
    return () => { controller.abort(); locked(); };
  }, [client, enabled, online]);
  return !online ? 'offline' : status;
}
