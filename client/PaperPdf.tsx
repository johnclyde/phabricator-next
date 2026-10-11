import { useEffect, useMemo, useRef, useState } from 'react';
import { AnnotationMode, GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PaperSyncTeX, PaperSyncTeXPoint } from '../shared/paper-builds';
import { pdfPoint, sourcePoint } from './paper-build-client';

GlobalWorkerOptions.workerSrc = workerUrl;
export default function PaperPdf({ bytes, mapping, versionId, versionNumber, sourcePath, sourceLine, openSource, fileName }: {
  fileName?: string; bytes: Uint8Array<ArrayBuffer>; mapping: PaperSyncTeX | null; versionId: string; versionNumber: number; sourcePath: string | null; sourceLine: number | null;
  openSource: (versionId: string, path: string | null, line: number | null) => void;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null), [page, setPage] = useState(1), [zoom, setZoom] = useState(1), [width, setWidth] = useState(300);
  const [error, setError] = useState(''), [status, setStatus] = useState('Loading PDF…'), [text, setText] = useState(''), [point, setPoint] = useState<PaperSyncTeXPoint | null>(null);
  const [lookupPath, setLookupPath] = useState(sourcePath || mapping?.points[0]?.path || ''), [lookupLine, setLookupLine] = useState(sourceLine || 1);
  const renderKey = `${page}:${width}:${zoom}`; const [renderedKey, setRenderedKey] = useState(''); const ready = renderedKey === renderKey;
  const container = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), heading = useRef<HTMLHeadingElement>(null), render = useRef<RenderTask | null>(null), [dimensions, setDimensions] = useState({ width: 1, height: 1 });
  useEffect(() => {
    let active = true;
    // Only authenticated bytes enter the viewer. No scripting manager, annotations,
    // remote fonts, external URLs, or document JavaScript actions are installed.
    const task = getDocument({ data: bytes.slice(), useWorkerFetch: false, useSystemFonts: true, useWasm: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false, maxImageSize: 16_000_000, stopAtErrors: true });
    void task.promise.then(document => { if (!active) return; setPdf(document); setError(''); setStatus(''); }).catch(failure => { if (active) { setError(failure instanceof Error ? failure.message : 'This PDF could not be displayed.'); setStatus(''); } });
    return () => { active = false; render.current?.cancel(); void task.destroy(); if (canvas.current) { canvas.current.width = 0; canvas.current.height = 0; } };
  }, [bytes]);
  useEffect(() => { if (!container.current) return; const element = container.current; const observer = new ResizeObserver(entries => setWidth(Math.max(100, entries[0]!.contentRect.width))); observer.observe(element); return () => observer.disconnect(); }, []);
  useEffect(() => {
    if (!pdf || !canvas.current) return; let active = true; let task: RenderTask | null = null; setStatus(`Rendering page ${page}…`); setText('');
    void (async () => {
      const sheet = await pdf.getPage(page); if (!active || !canvas.current) return;
      const natural = sheet.getViewport({ scale: 1 });
      const displayScale = Math.min(width / natural.width, 2) * zoom, resolution = Math.min(window.devicePixelRatio || 1, 2), viewport = sheet.getViewport({ scale: displayScale * resolution });
      // A single bounded canvas keeps long manuscripts usable on mobile.
      if (viewport.width * viewport.height > 24_000_000) throw new Error('This page is too large at this zoom. Reduce the zoom to display it.');
      const element = canvas.current; element.width = Math.ceil(viewport.width); element.height = Math.ceil(viewport.height); element.style.width = `${viewport.width / resolution}px`; element.style.height = `${viewport.height / resolution}px`; setDimensions({ width: viewport.width / resolution, height: viewport.height / resolution });
      task = sheet.render({ canvas: element, viewport, annotationMode: AnnotationMode.DISABLE }); render.current = task; await task.promise;
      const content = await sheet.getTextContent(); if (!active) return;
      setText(content.items.flatMap(item => 'str' in item ? [item.str] : []).join(' ')); setRenderedKey(renderKey); setStatus(''); setError('');
    })().catch(failure => { if (active && !(failure instanceof Error && failure.name === 'RenderingCancelledException')) { setError(failure instanceof Error ? failure.message : 'The page could not be displayed.'); setStatus(''); } });
    return () => { active = false; task?.cancel(); };
  }, [pdf, page, width, zoom]);
  const choose = (next: number) => { setPage(next); setPoint(null); };
  useEffect(() => { if (sourcePath) setLookupPath(sourcePath); if (sourceLine) setLookupLine(sourceLine); }, [sourcePath, sourceLine]);
  const paths = useMemo(() => [...new Set(mapping?.points.map(item => item.path) || [])], [mapping]);
  const locations = useMemo(() => { const seen = new Set<string>(); return (mapping?.points || []).flatMap((location, index) => { const key = `${location.path}:${location.line}`; if (location.page !== page || seen.has(key)) return []; seen.add(key); return [{ location, index }]; }); }, [mapping, page]);
  const source = lookupPath && lookupLine && mapping ? sourcePoint(mapping, lookupPath, lookupLine) : null;
  const mapPage = mapping?.pages.find(item => item.page === page);
  return <section className="paper-pdf" aria-label={fileName ? `PDF preview for ${fileName}` : `PDF preview for version ${versionNumber}`}><h3 ref={heading} tabIndex={-1}>PDF · {fileName || `Version ${versionNumber}`}</h3>{!fileName && <p className="small muted">This PDF and its source links belong to version {versionNumber}. Select a location on the page, then open its original source.</p>}<div className="paper-pdf-controls"><button className="button" disabled={!pdf || page <= 1} onClick={() => choose(page - 1)}>Previous Page</button><label>Page <input aria-label="PDF page" type="number" min={1} max={pdf?.numPages || 1} value={page} onChange={event => { const number = Number(event.target.value); if (Number.isInteger(number) && number >= 1 && number <= (pdf?.numPages || 1)) choose(number); }}/></label><span>of {pdf?.numPages || '…'}</span><button className="button" disabled={!pdf || page >= pdf.numPages} onClick={() => choose(page + 1)}>Next Page</button><button className="button" disabled={zoom <= 0.75} onClick={() => setZoom(value => Math.max(0.75, value - 0.25))}>Zoom Out</button><button className="button" disabled={zoom >= 2} onClick={() => setZoom(value => Math.min(2, value + 0.25))}>Zoom In</button><button className="button" disabled={zoom === 1} onClick={() => setZoom(1)}>Fit Width</button></div>
    {mapping && <div className="paper-pdf-controls"><label className="field"><span>Source file in compiled version</span><select aria-label="PDF source file" value={lookupPath} onChange={event => setLookupPath(event.target.value)}>{paths.map(path => <option key={path}>{path}</option>)}</select></label><label>Line <input aria-label="PDF source line" type="number" min={1} value={lookupLine} onChange={event => { const number = Number(event.target.value); if (Number.isSafeInteger(number) && number > 0) setLookupLine(number); }}/></label><button className="button" disabled={!source} onClick={() => { if (!source) return; setPage(source.page); setPoint(source); heading.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }}>Find Source in PDF</button></div>}
    {source && source.line !== lookupLine && <p className="small muted">No mapped output for line {lookupLine}. The nearest mapped source is {source.path}:{source.line}.</p>}
    {!mapping && !fileName && <p className="info-strip">This build has no verified source map. Its PDF remains available.</p>}{status && <p role="status">{status}</p>}{error && <p role="alert" className="error-text">{error}</p>}
    <div className="paper-pdf-viewport" ref={container}><div className="paper-pdf-sheet" style={{ width: dimensions.width, height: dimensions.height }}><canvas ref={canvas} style={{ visibility: ready ? 'visible' : 'hidden' }} role="img" aria-label={fileName ? `Page ${page} of ${fileName}` : `Page ${page} of paper version ${versionNumber}`} onClick={event => { if (!ready || !mapping || !mapPage || !canvas.current) return; const bounds = canvas.current.getBoundingClientRect(); setPoint(pdfPoint(mapping, page, (event.clientX - bounds.left) * mapPage.width / bounds.width, (event.clientY - bounds.top) * mapPage.height / bounds.height)); }}/>{ready && point?.page === page && mapPage && <span className="paper-pdf-highlight" aria-hidden="true" style={{ left: `${point.x / mapPage.width * 100}%`, top: `${point.y / mapPage.height * 100}%`, width: `${point.width / mapPage.width * 100}%`, height: `${Math.max(point.height, 3) / mapPage.height * 100}%` }}/>}</div></div>
    {point && <div className="paper-pdf-source"><p>Nearest source: <code>{point.path}:{point.line}</code> · Version {versionNumber}</p><button className="button" onClick={() => openSource(versionId, point.path, point.line)}>Open PDF Location in Original Source</button></div>}
    {mapping && <label className="field"><span>Source locations on this PDF page{locations.length > 1000 ? ' (first 1,000)' : ''}</span><select aria-label="PDF source location" value={point?.page === page ? mapping.points.indexOf(point) : ''} onChange={event => { const location = mapping.points[Number(event.target.value)]; if (event.target.value !== '' && location?.page === page) setPoint(location); }}><option value="">Choose a source line</option>{locations.slice(0, 1000).map(({ location, index }) => <option key={index} value={index}>{location.path}:{location.line}</option>)}</select></label>}
    {ready && text && <details className="paper-pdf-text"><summary>Accessible page text</summary><p>{text}</p></details>}
  </section>;
}
