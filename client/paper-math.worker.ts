import { renderPaperMath, type PaperMathRequest } from './paper-math-render';

self.onmessage = (event: MessageEvent<{ id: number; requests: PaperMathRequest[] }>) => {
  const { id, requests } = event.data;
  if (!Number.isSafeInteger(id) || !Array.isArray(requests) || requests.length > 300
    || requests.some(request => typeof request?.expression !== 'string' || typeof request.displayMode !== 'boolean')) return;
  self.postMessage({ id, rendering: renderPaperMath(requests) });
};

// Signal after the math module has loaded, before starting any requested work.
self.postMessage({ ready: true });
