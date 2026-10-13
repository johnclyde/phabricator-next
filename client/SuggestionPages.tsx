import { useEffect, useState } from 'react';

/** This is a display window only; proposals retain and apply every passage. */
export const SUGGESTION_PAGE_SIZE = 10;

export function suggestionPage(requested: number, count: number) {
  const pages = Math.max(1, Math.ceil(count / SUGGESTION_PAGE_SIZE));
  const page = Math.max(0, Math.min(requested, pages - 1));
  return { page, pages, start: page * SUGGESTION_PAGE_SIZE, end: Math.min(count, (page + 1) * SUGGESTION_PAGE_SIZE) };
}

export default function SuggestionPages({ name, count, page, onPage, firstPassage = 1, disabled = false }: { name: string; count: number; page: number; onPage: (page: number) => void; firstPassage?: number; disabled?: boolean }) {
  const window = suggestionPage(page, count);
  const [destination, setDestination] = useState(String(window.page + 1));
  useEffect(() => { setDestination(String(window.page + 1)); }, [window.page, window.pages]);
  if (window.pages === 1) return null;
  const requested = Number(destination);
  const valid = Number.isSafeInteger(requested) && requested >= 1 && requested <= window.pages;
  const go = () => { if (!disabled && valid) onPage(requested - 1); };
  return <nav className="suggestion-pages" aria-label={name}>
    <p className="small muted" role="status">Showing passages {window.start + firstPassage}–{window.end + firstPassage - 1} of {count + firstPassage - 1}. Every passage stays in this proposal.</p>
    <div className="suggestion-page-controls">
      <button type="button" className="button" disabled={disabled || window.page === 0} onClick={() => onPage(0)}>First passages</button>
      <button type="button" className="button" disabled={disabled || window.page === 0} onClick={() => onPage(window.page - 1)}>Previous passages</button>
      <span className="small">Page {window.page + 1} of {window.pages}</span>
      <button type="button" className="button" disabled={disabled || window.page === window.pages - 1} onClick={() => onPage(window.page + 1)}>Next passages</button>
      <button type="button" className="button" disabled={disabled || window.page === window.pages - 1} onClick={() => onPage(window.pages - 1)}>Last passages</button>
      <label className="suggestion-page-jump">Page<input aria-label="Passage page" type="text" inputMode="numeric" disabled={disabled} value={destination} onChange={event => setDestination(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); go(); } }}/></label>
      <button type="button" className="button" disabled={disabled || !valid} onClick={go}>Go to page</button>
    </div>
  </nav>;
}
