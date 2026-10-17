import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { parsePaperPreview, type PaperPreview, type PaperPreviewInline } from '../shared/paper-preview';
import type { PaperPreviewHighlights } from '../shared/paper-preview-comparison';
import type { PaperMathRendering, PaperMathRequest } from './paper-math-render';

/** KaTeX output is generated locally with untrusted-input restrictions, never authored HTML. */
export default function PaperMathPreview({ source, className = '', parsedPreview, highlights, changeKind }: {
  source: string; className?: string; parsedPreview?: PaperPreview;
  highlights?: PaperPreviewHighlights; changeKind?: 'removed' | 'added';
}) {
  const document = useMemo(() => {
    const parsed = parsedPreview ?? parsePaperPreview(source);
    const requests: PaperMathRequest[] = [];
    const collect = (nodes: PaperPreviewInline[]) => {
      for (const node of nodes) {
        if (node.kind === 'math') requests.push({ expression: node.expression, displayMode: false });
        else if (node.kind === 'strong' || node.kind === 'emphasis') collect(node.children);
      }
    };
    for (const block of parsed.blocks) {
      if (block.kind === 'math') requests.push({ expression: block.expression, displayMode: true });
      else if (block.kind === 'paragraph' || block.kind === 'heading') collect(block.children);
    }
    return { parsed, requests };
  }, [source, parsedPreview]);
  const generation = useRef(0);
  const [result, setResult] = useState<{ requests: PaperMathRequest[]; rendering?: PaperMathRendering; error?: string } | null>(null);
  useEffect(() => {
    if (!document.requests.length) return;
    const id = ++generation.current;
    let active = true, worker: Worker | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: string) => {
      if (!active) return;
      clearTimeout(deadline); worker?.terminate();
      setResult({ requests: document.requests, error });
    };
    const delay = setTimeout(() => {
      try {
        worker = new Worker(new URL('./paper-math.worker.ts', import.meta.url), { type: 'module' });
        deadline = setTimeout(() => fail('This preview took too long. Equations remain as source so you can keep writing.'), 2_000);
        worker.onmessage = (event: MessageEvent<{ id: number; rendering: PaperMathRendering }>) => {
          if (!active || event.data.id !== id) return;
          clearTimeout(deadline); worker?.terminate();
          setResult({ requests: document.requests, rendering: event.data.rendering });
        };
        worker.onerror = () => fail('Math preview is unavailable on this device. Your source is still available.');
        worker.postMessage({ id, requests: document.requests });
      } catch { fail('Math preview is unavailable on this device. Your source is still available.'); }
    }, 120);
    return () => { active = false; clearTimeout(delay); clearTimeout(deadline); worker?.terminate(); };
  }, [document.requests]);
  const current = result?.requests === document.requests ? result : null;

  const preview = useMemo(() => {
    let mathIndex = 0;
    const mark = (content: ReactNode, key: string, displayMode?: boolean): ReactNode => {
      const Change = changeKind === 'removed' ? 'del' : 'ins';
      return <Change key={key} className={`paper-preview-change${displayMode === undefined ? '' : displayMode ? ' paper-preview-change-display' : ' paper-preview-change-math'}`} data-change-kind={changeKind} title={changeKind === 'removed' ? 'Removed from base' : 'Added in target'}>{content}</Change>;
    };
    const text = (value: string, key: string): ReactNode => {
      const ranges = changeKind ? highlights?.[key] : undefined;
      if (!ranges?.length) return value;
      const fragments: ReactNode[] = [];
      let offset = 0;
      for (const range of ranges) {
        fragments.push(value.slice(offset, range.start), mark(value.slice(range.start, range.end), `${key}-${range.start}`));
        offset = range.end;
      }
      fragments.push(value.slice(offset));
      return fragments;
    };
    const math = (_expression: string, original: string, displayMode: boolean, key: string): ReactNode => {
      const html = current?.rendering?.results[mathIndex++]?.html;
      const equation = typeof html === 'string'
        ? <span key={key} className={displayMode ? 'paper-math-display' : 'paper-math-inline'} dangerouslySetInnerHTML={{ __html: html }} />
        : <code key={key} className="paper-math-fallback" title="Original equation source">{original}</code>;
      return changeKind && highlights?.[key]?.length ? mark(equation, key, displayMode) : equation;
    };
    const inline = (nodes: PaperPreviewInline[], prefix: string): ReactNode[] => nodes.map((node, index) => {
      const key = `${prefix}-${index}`;
      switch (node.kind) {
        case 'text': return <Fragment key={key}>{text(node.text, key)}</Fragment>;
        case 'literal': return <code key={key} className="paper-math-command">{text(node.text, key)}</code>;
        case 'code': return <code key={key}>{text(node.text, key)}</code>;
        case 'strong': return <strong key={key}>{inline(node.children, key)}</strong>;
        case 'emphasis': return <em key={key}>{inline(node.children, key)}</em>;
        case 'math': return math(node.expression, node.source, false, key);
      }
    });
    const content = document.parsed.blocks.map((block, index) => {
      const key = `block-${index}`;
      switch (block.kind) {
        case 'paragraph': return <p key={key}>{inline(block.children, key)}</p>;
        case 'source': return <pre key={key} className="paper-math-source">{text(block.source, key)}</pre>;
        case 'math': return <div key={key} className="paper-math-equation">{math(block.expression, block.source, true, key)}</div>;
        case 'heading': {
          const Heading = `h${block.level + 1}` as 'h2' | 'h3' | 'h4' | 'h5';
          return <Heading key={key}>{inline(block.children, key)}</Heading>;
        }
      }
    });
    return { ...document.parsed, content };
  }, [document.parsed, current, highlights, changeKind]);

  return <section className={`paper-math-preview ${className}`.trim()} aria-label="Paper reading preview">
    <p className="paper-math-note">Paper preview · rendered on this device. Unsupported body commands remain as source.</p>
    {(preview.limited || current?.rendering?.limited) && <p className="paper-math-note">Some content is shown as source to keep editing responsive. Your complete source is retained.</p>}
    {(current?.rendering?.failed ?? 0) > 0 && <p className="paper-math-note">Unfinished or unsupported equations are shown as source.</p>}
    {current?.error && <p className="paper-math-note" role="status">{current.error}</p>}
    {!current && document.requests.length > 0 && <p className="paper-math-note" role="status">Preparing math on this device…</p>}
    <div className="paper-math-content">{preview.content.length ? preview.content : <p className="paper-math-note">Start writing to see your paper here.</p>}</div>
  </section>;
}
