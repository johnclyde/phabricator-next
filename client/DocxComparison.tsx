import { useEffect, useMemo, useRef, useState } from 'react';
import type { RevisionDetail, RevisionVersion } from '../shared/types';
import { compareDocxScope, DOCX_COMPARISON_SCOPE_LABELS, DOCX_COMPARISON_SCOPES, type DocxComparisonScopeId } from '../shared/docx-comparison';
import Comparison, { type RegisterComparison, type WordComparisonPresentation } from './Comparison';
import type { ComparisonSelection } from './comparison-model';
import { defaultDocxComparison, docxComparisonIdentity, docxComparisonMetadata, docxVersionIdentity, isDocxComparisonSelection, resolveDocxComparison, type DocxComparisonSelection } from './docx-comparison-model';
import { useWorkspace } from './SessionGate';
import { onSessionLocked } from './session';

const retireSpeech = () => window.dispatchEvent(new Event('comparison-navigation'));
export default function DocxComparison({ detail, readerVersion, online, canView, register, close, readVersion }: {
  detail: RevisionDetail; readerVersion: RevisionVersion | undefined; online: boolean; canView: boolean;
  register: RegisterComparison; close: () => void; readVersion: (id: string) => void;
}) {
  const client = useWorkspace(), id = detail.revision.id, key = `docx-comparison:${id}`;
  const [stored, setStored] = useState<unknown>(() => client.readStored(key, null));
  const [warning, setWarning] = useState(''), [retired, setRetired] = useState(false);
  const selectionGeneration = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); heading.current?.closest('section')?.scrollIntoView({ block: 'start' }); }, []);
  const selection = isDocxComparisonSelection(stored, id) ? stored : null;
  const initial = () => defaultDocxComparison(detail, readerVersion ? docxVersionIdentity(readerVersion) : null);
  const change = (next: DocxComparisonSelection, cancelSpeech = true) => {
    if (retired || !canView || !client.isActive() || client.unavailableObject(id)) return;
    selectionGeneration.current++; if (cancelSpeech) retireSpeech(); const metadata = docxComparisonMetadata(next); setStored(metadata);
    setWarning(client.writeStored(key, metadata) ? '' : 'This comparison selection could not be saved. It may not be restored after leaving or reloading.');
  };
  useEffect(() => { if (stored === null) { const next = initial(); if (next) change(next); } }, []);
  useEffect(() => {
    const retire = () => { selectionGeneration.current++; register(null); retireSpeech(); setRetired(true); };
    const access = client.onAccessChange(ids => { if (ids.includes(id) || detail.versions.some(version => version.docx && ids.includes(version.docx.sourceFile.fileId))) retire(); });
    const source = client.onTaskSnapshotChange(retire), session = onSessionLocked(retire);
    return () => { access(); source(); session(); register(null); retireSpeech(); };
  }, [id, register]);
  const resolved = useMemo(() => selection ? resolveDocxComparison(detail, selection) : null, [detail, stored]);
  const valid = resolved && !('error' in resolved) ? resolved : null;
  const versions = detail.versions.filter(version => docxVersionIdentity(version));
  const base = detail.versions.find(version => version.id === selection?.base?.id), target = detail.versions.find(version => version.id === selection?.target.id);
  const scopes = valid?.scopes || [...DOCX_COMPARISON_SCOPES];
  const choose = (side: 'base' | 'target', versionId: string) => {
    if (!selection) return;
    const version = versions.find(item => item.id === versionId), pin = version ? docxVersionIdentity(version) : null;
    if (side === 'target' && !pin) return;
    // A new pair explicitly starts in the main document. Scope navigation never changes the pair.
    change({ ...selection, [side]: pin, filePath: 'document' } as DocxComparisonSelection);
  };
  const unavailable = retired || !canView || !client.isActive() || client.unavailableObject(id) || (detail.accessEpoch ?? -1) < (client.session?.accessEpoch ?? -1) || Boolean(valid && [valid.base, valid.target].some(version => version?.docx && client.unavailableObject(version.docx.sourceFile.fileId)));
  const epoch = client.session?.accessEpoch, snapshotGeneration = client.taskSnapshotGeneration(), selectedGeneration = selectionGeneration.current;
  const sourcePins = valid ? [valid.base, valid.target].flatMap(version => version?.docx ? [{ id: version.docx.sourceFile.fileId, generation: client.session?.objectGenerations.get(version.docx.sourceFile.fileId) || 0 }] : []) : [];
  const available = () => !unavailable && selectedGeneration === selectionGeneration.current && client.isActive() && !client.unavailableObject(id) && epoch === client.session?.accessEpoch && snapshotGeneration === client.taskSnapshotGeneration() && sourcePins.every(pin => !client.unavailableObject(pin.id) && pin.generation === (client.session?.objectGenerations.get(pin.id) || 0));
  const word: WordComparisonPresentation | null = valid && selection ? {
    before: valid.before?.scopes[selection.filePath]?.file || null,
    after: valid.after.scopes[selection.filePath]?.file || null,
    scopes: valid.scopes,
    scopeLabel: scope => DOCX_COMPARISON_SCOPE_LABELS[scope as DocxComparisonScopeId],
    compare: scope => compareDocxScope(valid.before, valid.after, scope as DocxComparisonScopeId, selection.mode),
    identity: next => JSON.stringify([docxComparisonIdentity(next as DocxComparisonSelection), epoch, snapshotGeneration]),
    available,
    basePackageSha256: valid.base?.docx?.sha256 || null,
    targetPackageSha256: valid.target.docx!.sha256,
  } : null;
  const changeFromRenderer = (next: ComparisonSelection) => { if (isDocxComparisonSelection(next, id) && available()) change(next, false); };
  return <section className="panel docx-comparison" aria-label="Word text comparison">
    <div className="panel-heading"><h2 ref={heading} tabIndex={-1}>Compare Word Versions</h2><button className="button" onClick={() => { retireSpeech(); close(); }}>Close Word comparison</button></div>
    {!online && <p className="info-strip">Offline comparison of saved, authorized versions. This pair remains fixed until you choose different versions.</p>}
    {warning && <p className="banner warning" role="status">{warning}</p>}
    {unavailable ? <p className="banner warning" role="status">Word comparison access or source context changed. Close this comparison and reload the document before choosing versions again.</p> : <>
      {selection && <div className="comparison-toolbar docx-comparison-picker docx-comparison-controls">
          <label>Base Word version<select aria-label="Base Word version" value={selection.base?.id || ''} onChange={event => choose('base', event.target.value)}><option value="">Empty base</option>{selection.base && !versions.some(item => item.id === selection.base?.id) && <option value={selection.base.id}>Unavailable selected version</option>}{versions.map(item => <option key={item.id} value={item.id}>Version {item.number}</option>)}</select></label>
          <label>Word version to compare<select aria-label="Word version to compare" value={selection.target.id} onChange={event => choose('target', event.target.value)}>{!versions.some(item => item.id === selection.target.id) && <option value={selection.target.id}>Unavailable selected version</option>}{versions.map(item => <option key={item.id} value={item.id}>Version {item.number}</option>)}</select></label>

          <label>Scope<select aria-label="Word comparison scope" value={selection.filePath} onChange={event => change({ ...selection, filePath: event.target.value as DocxComparisonScopeId })}>{!scopes.includes(selection.filePath) && <option value={selection.filePath}>Unavailable selected scope</option>}{scopes.map(scope => <option key={scope} value={scope}>{DOCX_COMPARISON_SCOPE_LABELS[scope]}</option>)}</select></label>
          <label>Compare text<select aria-label="Word comparison mode" value={selection.mode} onChange={event => change({ ...selection, mode: event.target.value as 'words' | 'lines' })}><option value="words">Words</option><option value="lines">Lines</option></select></label>
      </div>}
      {(!selection || !valid) && <p className="banner warning" role="status">{resolved && 'error' in resolved ? resolved.error : stored === null ? 'The selected immutable Word reader version is unavailable for comparison. Choose a Word reader version explicitly.' : 'Saved Word comparison selection is invalid. Compare the selected reader version explicitly to replace it.'} Open Word comparison options to reset the pair.</p>}
      <details className="docx-comparison-options"><summary>Word comparison options</summary>
        <p className="info-strip">The document reader and its passage discussions remain on {readerVersion ? `Version ${readerVersion.number}` : 'the selected reader version'}. Projected comparison lines cannot receive comments.</p>
        {selection && <>
          {valid && <div className="comparison-file-navigation"><button className="button" disabled={valid.scopes.indexOf(selection.filePath) <= 0} onClick={() => change({ ...selection, filePath: valid.scopes[valid.scopes.indexOf(selection.filePath) - 1]! })}>Previous Word scope</button><span role="status">Scope {valid.scopes.indexOf(selection.filePath) + 1} of {valid.scopes.length}</span><button className="button" disabled={valid.scopes.indexOf(selection.filePath) >= valid.scopes.length - 1} onClick={() => change({ ...selection, filePath: valid.scopes[valid.scopes.indexOf(selection.filePath) + 1]! })}>Next Word scope</button></div>}
          <div className="comparison-navigation-options"><label className="checkbox"><input type="checkbox" checked={Boolean(selection.skipSpaceTabOnly)} onChange={event => change({ ...selection, skipSpaceTabOnly: event.target.checked })}/>Skip space/tab-only changes</label><small>All literal projected text stays visible. Keyboard: j/k for changes; Shift+J/K for Word scopes. Voice: read changes, next change, next file (next Word scope).</small></div>
        </>}
        <div className="docx-comparison-actions">{selection && <button className="button docx-comparison-swap" disabled={!selection.base || !base || !target} onClick={() => change({ ...selection, base: selection.target, target: selection.base! })}>Swap Word versions</button>}<button className="button" disabled={!readerVersion?.docx} onClick={() => { const next = initial(); if (next) change(next); }}>Compare selected reader version</button>{valid && <button className="button" onClick={() => { if (available()) { retireSpeech(); readVersion(valid.target.id); } }}>Read compared Word version</button>}</div>
        {valid && <div className="docx-comparison-coverage">
          <p>Deleted and move-from runs represented in the saved reading copy are excluded. This view does not cover all Word tracked changes or formatting. Synthetic note markers keep references visible.</p>
          {[...(valid.base && valid.before ? [{ version: valid.base, projection: valid.before }] : []), { version: valid.target, projection: valid.after }].map(({ version, projection }, index) => <details key={`${index}:${version.id}`}><summary>Projection limits · {index === 0 && valid.base ? 'Base' : 'Target'} Version {version.number}</summary><ul>{projection.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>)}
          <p>{!valid.base ? 'Empty base; the target Word package is pinned below.' : valid.samePackage ? 'Same Word package SHA-256 digest.' : 'Different Word package SHA-256 digests.'} Equal projected text does not establish package equality, formatting equality, or fully accepted Word text.</p>
          <details><summary>Exact Word version identities</summary>{[...(valid.base ? [{ label: 'Base', version: valid.base }] : []), { label: 'Target', version: valid.target }].map(({ label, version }) => <p key={label}>{label} Version {version.number}<br/>Snapshot <code>{version.contentHash}</code><br/>Word package SHA-256 <code>{version.docx!.sha256}</code></p>)}</details>
        </div>}
      </details>
      {selection && valid && <>
        <p className="docx-comparison-limitation">Text redline only; formatting and some tracked changes are omitted. {valid.base && (valid.samePackage ? 'Same Word file.' : 'Word files differ, even if their displayed text matches.')}</p>
        <Comparison key={word!.identity(selection)} revisionId={id} base={valid.base} target={valid.target} selection={selection} register={register} change={changeFromRenderer} word={word!} canComment={false} onLine={() => {}} selectedLine={null}/>
      </>}
    </>}
  </section>;
}
