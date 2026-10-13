import { useState } from 'react';
import { createPassageAnchor } from '../shared/anchors';
import { SUGGESTION_LIMITS } from '../shared/suggestions';
import type { PassageAnchor, RevisionVersion, SuggestedPassageEdit } from '../shared/types';
import { SuggestionPreview } from './ReviewThreads';
import SuggestionPages, { SUGGESTION_PAGE_SIZE, suggestionPage } from './SuggestionPages';

/** A textarea exposes normalized newlines; translate its selection back to exact source offsets. */
function sourceOffset(source: string, normalized: number): number {
  let position = 0;
  for (let displayed = 0; position < source.length && displayed < normalized; displayed++, position++) {
    if (source[position] === '\r' && source[position + 1] === '\n') position++;
  }
  return position;
}

export default function AdditionalSuggestedEdits({ version, primary, edits, disabled, change }: { version: RevisionVersion; primary: PassageAnchor; edits: SuggestedPassageEdit[]; disabled: boolean; change: (edits: SuggestedPassageEdit[]) => void }) {
  const [choosing, setChoosing] = useState(false), [path, setPath] = useState(primary.filePath), [start, setStart] = useState(''), [end, setEnd] = useState('');
  const [page, setPage] = useState(0), pageWindow = suggestionPage(page, edits.length);
  const file = version.files.find(item => item.path === path);
  let selected: PassageAnchor | null = null, selectionError = '';
  if (start !== '' || end !== '') try {
    if (!file || start === '' || end === '') throw new Error('Select a complete passage in this source file.');
    const from = Number(start), to = Number(end);
    selected = createPassageAnchor(version, path, { start: from, end: to, quote: file.content.slice(from, to) });
    if ([primary, ...edits.map(edit => edit.anchor)].some(anchor => anchor.filePath === path && selected!.start < anchor.end && selected!.end > anchor.start)) throw new Error('This passage overlaps another edit. Choose a separate passage.');
  } catch (failure) { selected = null; selectionError = failure instanceof Error ? failure.message : 'Choose an exact source passage.'; }
  const update = (index: number, patch: Partial<Pick<SuggestedPassageEdit, 'replacement' | 'explanation'>>) => { if (!disabled) change(edits.map((edit, position) => position === index ? { ...edit, ...patch } : edit)); };
  return <div className="additional-suggested-edits">
    <SuggestionPages name="Additional suggested passage pages" count={edits.length} page={pageWindow.page} firstPassage={2} onPage={setPage} disabled={disabled}/>
    {edits.slice(pageWindow.start, pageWindow.end).map((edit, localIndex) => { const index = pageWindow.start + localIndex; return <section key={`${edit.anchor.filePath}:${edit.anchor.start}:${edit.anchor.end}`} className="suggestion-passage-editor" aria-label={`Suggested passage ${index + 2}`}>
      <div className="suggestion-passage-heading"><h4>Passage {index + 2} · {edit.anchor.filePath}</h4><button type="button" className="button" disabled={disabled} onClick={() => { if (window.confirm('Remove this passage and its replacement from the proposal? The other edits will be kept.')) change(edits.filter((_, position) => position !== index)); }}>Remove passage {index + 2}</button></div>
      <p className="small muted">Version {version.number} · source characters {edit.anchor.start + 1}–{edit.anchor.end}. This exact original location stays fixed.</p>
      <label className="field"><span>Suggested replacement {index + 2}</span><textarea aria-label={`Suggested replacement ${index + 2}`} className="source-editor" rows={4} maxLength={SUGGESTION_LIMITS.replacement} disabled={disabled} value={edit.replacement} onChange={event => update(index, { replacement: event.target.value })}/></label>
      <label className="field"><span>Explanation for passage {index + 2}</span><textarea aria-label={`Explanation for passage ${index + 2}`} rows={3} maxLength={SUGGESTION_LIMITS.explanation} disabled={disabled} value={edit.explanation} onChange={event => update(index, { explanation: event.target.value })} placeholder="Explain this edit (required)…"/></label>
      <SuggestionPreview original={edit.anchor.quote} replacement={edit.replacement}/>
    </section>; })}
    <p className="small muted">{edits.length + 1} {edits.length ? 'passages' : 'passage'}. All edits will be reviewed and applied together as one new version. Each passage needs its own explanation.</p>
    {!choosing ? <button type="button" className="button" disabled={disabled} onClick={() => { setStart(''); setEnd(''); setChoosing(true); }}>Add another passage</button> : <section className="suggestion-passage-picker" aria-label="Choose another passage">
      <h4>Choose another passage from version {version.number}</h4><p className="small muted">Select text in the original source below. You can choose another file from this same version. Up to 20,000 source characters per passage.</p>
      <label className="field"><span>Additional passage file</span><select aria-label="Additional passage file" disabled={disabled} value={path} onChange={event => { setPath(event.target.value); setStart(''); setEnd(''); }}>{version.files.map(item => <option key={item.path} value={item.path}>{item.path}</option>)}</select></label>
      <label className="field"><span>Additional passage source</span><textarea aria-label="Additional passage source" className="source-editor suggestion-selection-source" readOnly disabled={disabled} rows={10} value={file?.content ?? ''} onSelect={event => { if (disabled || !file) return; const input = event.currentTarget; if (input.selectionEnd <= input.selectionStart) return; setStart(String(sourceOffset(file.content, input.selectionStart))); setEnd(String(sourceOffset(file.content, input.selectionEnd))); }}/></label>
      <details className="suggestion-exact-range"><summary>Choose an exact character range</summary><p className="small muted">Offsets use the original source: start at 0, include the start, exclude the end. Unicode characters may occupy two positions.</p><div className="suggestion-range-fields"><label className="field"><span>Passage start offset</span><input aria-label="Passage start offset" type="number" min="0" max={file?.content.length ?? 0} step="1" disabled={disabled} value={start} onChange={event => setStart(event.target.value)}/></label><label className="field"><span>Passage end offset</span><input aria-label="Passage end offset" type="number" min="1" max={file?.content.length ?? 0} step="1" disabled={disabled} value={end} onChange={event => setEnd(event.target.value)}/></label></div></details>
      {selected && <div className="suggestion-selected-passage"><h5>Selected original passage</h5><pre>{selected.quote}</pre></div>}{selectionError && <p className="error-text small" role="status">{selectionError}</p>}
      <div className="thread-actions"><button type="button" className="button" disabled={disabled} onClick={() => setChoosing(false)}>Cancel passage selection</button><button type="button" className="button" disabled={disabled || !selected} onClick={() => { if (disabled || !selected) return; change([...edits, { anchor: selected, replacement: selected.quote, explanation: '' }]); setPage(Math.floor(edits.length / SUGGESTION_PAGE_SIZE)); setChoosing(false); setStart(''); setEnd(''); }}>Use selected passage</button></div>
    </section>}
  </div>;
}
