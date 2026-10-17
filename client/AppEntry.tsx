import { useEffect, useRef, useState } from 'react';
import App from './App';
import SessionGate from './SessionGate';
import DevicePapers from './DevicePapers';
import { allowDevicePaperNavigation } from './device-paper-navigation';
import SharedPaper from './SharedPaper';

/** Device papers contain only deliberately retained copies, never a cached session. */
export default function AppEntry() {
  const [hash, setHash] = useState(location.hash);
  const device = /^#device-papers(?:\/|$)/.test(hash);
  const shared = /^#paper-share(?:\/|$)/.test(hash);
  const isolated = device || shared;
  const workspaceStarted = useRef(!isolated);
  if (!isolated) workspaceStarted.current = true;
  useEffect(() => {
    let previous = location.hash;
    const change = () => {
      if (!allowDevicePaperNavigation()) { history.replaceState(null, '', `${location.pathname}${location.search}${previous}`); return; }
      const deviceTransition = /^#(?:device-papers|paper-share)(?:\/|$)/.test(previous) || /^#(?:device-papers|paper-share)(?:\/|$)/.test(location.hash);
      previous = location.hash;
      if (deviceTransition) setHash(previous);
    };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  const id = /^#device-papers\/([a-zA-Z0-9_-]+)$/.exec(hash)?.[1] || null;
  // A direct device-only visit never starts authentication. Once opened, keep
  // workspace expiry, cross-tab sign-out, and unsaved-draft warnings alive.
  const token = /^#paper-share\/([^/]*)$/.exec(hash)?.[1] || '';
  return <>{device && <DevicePapers id={id}/>} {shared && <SharedPaper key={token} token={token}/>} {workspaceStarted.current && <div hidden={isolated}><SessionGate>{!isolated && <App/>}</SessionGate></div>}</>;
}
