import { useEffect, useState, type ReactNode } from 'react';
import { useWorkspace } from './SessionGate';

/** Unmount a held editor so explicit discard cannot resurrect its React state. */
export default function DraftAvailability({ draftKey, children }: { draftKey: string; children: ReactNode }) {
  const { draftIsHeld, onAccessChange } = useWorkspace(); const [, changed] = useState(0);
  useEffect(() => onAccessChange(() => changed(value => value + 1)), []);
  return draftIsHeld(draftKey) ? <p className="info-strip">This draft is set aside for export or discard below. It will not submit automatically.</p> : children;
}
