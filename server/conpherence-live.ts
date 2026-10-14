import type { ConpherenceUpdate } from '../shared/conpherence-live.ts';
import { HttpError } from './validation.ts';

export const CONPHERENCE_LIVE_LIMITS = { waitMs: 20_000, checkMs: 1_000, pending: 256 } as const;
let pending = 0;

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Never hold a database transaction while waiting. authorizeEpoch must revalidate
 * the original credential on every call, then return the current policy epoch. */
export async function waitForConpherenceUpdate(after: string | null, authorizeEpoch: () => number, signal: AbortSignal): Promise<ConpherenceUpdate> {
  if (after !== null && (!/^(0|[1-9]\d*)$/.test(after) || !Number.isSafeInteger(Number(after)))) throw new HttpError(400, 'The conversation update cursor must be a nonnegative safe integer.');
  signal.throwIfAborted();
  let accessEpoch = authorizeEpoch();
  if (after === null || accessEpoch !== Number(after)) return { accessEpoch, changed: true };
  if (pending >= CONPHERENCE_LIVE_LIMITS.pending) throw new HttpError(429, 'Conversation updates are busy. Reconnect shortly.');
  pending++;
  const deadline = Date.now() + CONPHERENCE_LIVE_LIMITS.waitMs;
  try {
    // The iteration bound also limits wait time if the system clock moves back.
    for (let check = 0; check < CONPHERENCE_LIVE_LIMITS.waitMs / CONPHERENCE_LIVE_LIMITS.checkMs; check++) {
      await pause(Math.max(0, Math.min(CONPHERENCE_LIVE_LIMITS.checkMs, deadline - Date.now())), signal);
      signal.throwIfAborted();
      accessEpoch = authorizeEpoch();
      if (accessEpoch !== Number(after)) return { accessEpoch, changed: true };
      if (Date.now() >= deadline) break;
    }
    return { accessEpoch, changed: false };
  } finally { pending--; }
}
