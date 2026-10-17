import React from 'react';
import { createRoot } from 'react-dom/client';
import AppEntry from './AppEntry';
import './styles.css';
import 'katex/dist/katex.min.css';
import './paper-math.css';
import './device-papers.css';
import { applicationBase, applicationPath } from './mount';

createRoot(document.getElementById('root')!).render(<React.StrictMode><AppEntry/></React.StrictMode>);
if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register(applicationPath('/sw.js'), { scope: applicationBase() }).catch(() => { /* Offline shell is optional when the browser denies registration. */ });
