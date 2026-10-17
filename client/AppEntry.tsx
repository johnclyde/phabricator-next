import { useEffect, useRef, useState } from 'react';
import App from './App';
import SessionGate from './SessionGate';
import DevicePapers from './DevicePapers';
import { allowDevicePaperNavigation } from './device-paper-navigation';

/** Device papers contain only deliberately retained copies, never a cached session. */
export default function AppEntry() {
  const [hash, setHash] = useState(location.hash);
  const device = /^#device-papers(?:\/|$)/.test(hash);
  const workspaceStarted = useRef(!device);
  if (!device) workspaceStarted.current = true;
  useEffect(() => {
    let previous = location.hash;
    const change = () => {
      if (!allowDevicePaperNavigation()) { history.replaceState(null, '', `${location.pathname}${location.search}${previous}`); return; }
      const deviceTransition = /^#device-papers(?:\/|$)/.test(previous) || /^#device-papers(?:\/|$)/.test(location.hash);
      previous = location.hash;
      if (deviceTransition) setHash(previous);
    };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  const id = /^#device-papers\/([a-zA-Z0-9_-]+)$/.exec(hash)?.[1] || null;
  // A direct device-only visit never starts authentication. Once opened, keep
  // workspace expiry, cross-tab sign-out, and unsaved-draft warnings alive.
  return <>{device && <DevicePapers id={id}/>} {workspaceStarted.current && <div hidden={device}><SessionGate>{!device && <App/>}</SessionGate></div>}</>;
}
