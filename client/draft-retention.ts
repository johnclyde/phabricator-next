import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { WorkspaceClient } from './offline';

/** Keep an editor's raw baseline and private recovery copy through navigation. */
export function useDraftRetention(client: WorkspaceClient, key: string, setPersisted: (saved: boolean) => void): (value: unknown) => void {
  const report = useRef(setPersisted); report.current = setPersisted;
  const owner = useMemo(() => ({ latest: client.readStored<unknown>(key, null), generation: 0, mounted: false }), [client, key]);
  const current = useRef(owner); current.current = owner;
  const retain = useCallback((value: unknown) => {
    let captured: unknown;
    try { captured = JSON.parse(JSON.stringify(value)) as unknown; }
    catch { if (owner.mounted && current.current === owner) report.current(false); return; }
    const previous = owner.latest, generation = ++owner.generation;
    owner.latest = captured;
    // A previous save is not evidence that this new value has reached storage.
    // Report the pending write before its asynchronous writer lock can yield.
    if (owner.mounted && current.current === owner) report.current(false);
    void client.retainDraft(key, captured, previous).then(status => {
      if (owner.mounted && current.current === owner && owner.generation === generation) report.current(status === 'saved' && !client.draftHasUnsavedMemory(key));
    }).catch(() => { if (owner.mounted && current.current === owner && owner.generation === generation) report.current(false); });
  }, [client, key, owner]);
  useLayoutEffect(() => {
    owner.mounted = true;
    // Even unchanged saved drafts need a shadow: another tab may subsequently
    // replace their physical slot while this editor is open or navigates away.
    if (owner.latest !== null) retain(owner.latest);
    else report.current(!client.draftHasUnsavedMemory(key));
    const storageChanged = (event: StorageEvent) => {
      if (owner.mounted && current.current === owner && (event.key === null || event.key === client.storageKey(key))) report.current(!client.draftHasUnsavedMemory(key));
    };
    window.addEventListener('storage', storageChanged);
    return () => { owner.mounted = false; window.removeEventListener('storage', storageChanged); };
  }, [client, key, owner, retain]);
  return retain;
}
