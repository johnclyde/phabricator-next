import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import SessionGate from './SessionGate';
import './styles.css';
import { applicationBase, applicationPath } from './mount';

createRoot(document.getElementById('root')!).render(<React.StrictMode><SessionGate><App /></SessionGate></React.StrictMode>);
if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register(applicationPath('/sw.js'), { scope: applicationBase() }).catch(() => { /* Offline shell is optional when the browser denies registration. */ });
