import { useState } from 'react';
import type { SourceFile } from '../shared/types';
import { useWorkspace } from './SessionGate';
import { newDevicePaper, requestPersistentPaperStorage, saveDevicePaper } from './device-papers';
import { devicePaperHref } from './device-paper-navigation';
import { DEVICE_PAPER_NOTICE } from './DevicePapers';

export default function DevicePaperCopy({ title, files, objectId, hasAssets = false }: { title: string; files: SourceFile[]; objectId?: string; hasAssets?: boolean }) {
  const client = useWorkspace();
  const [open, setOpen] = useState(false), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState<{ id: string; title: string; files: SourceFile[] } | null>(null);
  const copy = async () => {
    if (!consent || busy || !client.isActive() || objectId && client.unavailableObject(objectId)) return;
    setBusy(true); setError('');
    try { const result = await saveDevicePaper(newDevicePaper(title.slice(0, 200).replace(/[\uD800-\uDBFF]$/, ''), files), null); setSaved({ id: result.id, title, files }); void requestPersistentPaperStorage().catch(() => {}); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save this device copy.'); }
    finally { setBusy(false); }
  };
  return <div className="device-paper-copy"><button type="button" className="button" onClick={() => setOpen(!open)} aria-expanded={open}>Save a device copy</button>{open && <><p>{DEVICE_PAPER_NOTICE}</p><p>This saves the selected text source files for independent offline editing. {hasAssets ? 'Linked figures and attachments are not copied. ' : ''}Workspace review history and permissions remain on the server. Edits to this copy do not update the workspace paper.</p><label className="checkbox"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)}/>Keep this paper accessible on this device after sign-out</label>{error && <p role="alert" className="banner error">{error}</p>}{saved && <p role="status">{saved.title === title && saved.files === files ? 'Device copy saved.' : 'An earlier device copy is saved. Save another copy to retain the latest edits.'} <a href={devicePaperHref(saved.id)}>Open device paper</a></p>}{(!saved || saved.title !== title || saved.files !== files) && <button type="button" className="button primary" disabled={!consent || busy} onClick={() => void copy()}>{busy ? 'Saving device copy…' : 'Save source files on this device'}</button>}</>}</div>;
}
