import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Finding, RevisionDetail, RevisionVersion } from '../shared/types';
import { findingNarration, findingSource, moveFindingCursor, FINDING_NAVIGATION_LIMITS } from '../shared/finding-navigation';
import { defaultFindingSelection, findingEvidenceIdentity, findingSelectionIdentity, findingSelectionMetadata, isFindingSelection, onDeviceFindingSelection, recordedReviewSelection, resolveFindingSelection, type FindingSelection, type OnDeviceReview } from './finding-navigation-model';
import type { FindingVoiceAction } from './voice';
import { useWorkspace } from './SessionGate';
import { onSessionLocked } from './session';

export interface FindingController {
  readonly identity: string;
  revisionId: string;
  sourceChanged: (sourceContext: string) => string;
  execute: (action: FindingVoiceAction) => { text: string; identity: string; comparisonIdentity?: string };
}
export type RegisterFindings = (controller: FindingController | null) => void;
export interface FindingSourceAnswer { text: string; comparisonIdentity?: string }
const PAGE_SIZE = 25;
const manualNavigation = () => window.dispatchEvent(new Event('finding-navigation'));

export default function ReviewFindings({ detail, inspected, sourceContext, onDevice, online, canView, register, openSource, reload }: {
  detail: RevisionDetail; inspected: RevisionVersion; sourceContext: string; onDevice: OnDeviceReview | null;
  online: boolean; canView: boolean; register: RegisterFindings;
  openSource: (version: RevisionVersion, finding: Finding, isCurrent: () => boolean) => FindingSourceAnswer;
  reload: () => Promise<RevisionDetail | undefined>;
}) {
  const client = useWorkspace(), id = detail.revision.id, storageKey = `review-findings:${id}`;
  const [stored, setStored] = useState<unknown>(() => client.readStored(storageKey, null));
  const selected = isFindingSelection(stored, id) ? stored : null;
  const inventoryError = !Array.isArray(detail.versions) || !Array.isArray(detail.reviews) || detail.versions.length > FINDING_NAVIGATION_LIMITS.maxSnapshotItems || detail.reviews.length > FINDING_NAVIGATION_LIMITS.maxSnapshotItems ? 'The loaded review inventory exceeds the finding navigation limit or is unavailable. No partial review list is shown.' : '';
  const [warning, setWarning] = useState(''), [boundary, setBoundary] = useState('');
  const [, refreshAuthority] = useState(0);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const alive = useRef(true), frame = useRef<number | null>(null), sequence = useRef(0);
  const context = useRef(sourceContext); context.current = sourceContext;
  const elements = useRef(new Map<string, HTMLElement>());
  const epoch = client.session?.accessEpoch ?? -1;
  const dependencyIds = [detail.revision.repositoryId, ...(client.session?.revisionFiles.get(id) || [])].filter((value): value is string => Boolean(value));
  const dependencies = dependencyIds.map(dependency => [dependency, client.session?.objectGenerations.get(dependency) || 0] as const);
  const dependencyIdentity = JSON.stringify(dependencies);
  const allowed = canView && !client.unavailableObject(id) && (detail.accessEpoch ?? -1) >= epoch && dependencies.every(([dependency]) => !client.unavailableObject(dependency));
  const active = () => alive.current && allowed && client.isActive() && !client.unavailableObject(id) && epoch === (client.session?.accessEpoch ?? -1) && dependencies.every(([dependency, generation]) => !client.unavailableObject(dependency) && generation === (client.session?.objectGenerations.get(dependency) || 0));
  const resolved = useMemo(() => selected ? resolveFindingSelection(detail, selected, onDevice || undefined) : null, [detail, stored, onDevice]);
  const current = resolved && !('error' in resolved) ? resolved : null;
  // Evidence text never enters persisted metadata or App's speech context. A
  // generation changes if the same immutable run unexpectedly changes payload.
  const evidence = useMemo(() => current ? findingEvidenceIdentity(current) : '', [current?.analysis, current?.review, current?.version]);
  const evidenceRef = useRef({ value: evidence, generation: 0 });
  if (evidenceRef.current.value !== evidence) evidenceRef.current = { value: evidence, generation: evidenceRef.current.generation + 1 };
  const evidenceGeneration = evidenceRef.current.generation;
  const identity = (source = context.current) => JSON.stringify([id, source, selectedRef.current ? findingSelectionIdentity(selectedRef.current) : null, evidenceGeneration, epoch, dependencies]);
  const latestIdentity = useRef(identity); latestIdentity.current = identity;
  const focusFinding = (findingId: string | null) => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (!findingId) return;
    const expected = latestIdentity.current(), ticket = sequence.current;
    frame.current = requestAnimationFrame(() => { frame.current = null; if (!active() || ticket !== sequence.current || expected !== latestIdentity.current()) return; const element = elements.current.get(findingId); element?.focus({ preventScroll: true }); element?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); });
  };
  const choose = (next: FindingSelection, manual: boolean, focus = false) => {
    if (!active()) return;
    sequence.current++; if (manual) manualNavigation();
    const metadata = findingSelectionMetadata(next); selectedRef.current = metadata; setStored(metadata); setBoundary('');
    setWarning(client.writeStored(storageKey, metadata) ? '' : 'This finding selection could not be saved. It may not be restored after leaving or reloading.');
    if (focus) focusFinding(next.findingId);
  };
  useEffect(() => { if (stored !== null || !active()) return; const initial = defaultFindingSelection(detail, { id: inspected.id, contentHash: inspected.contentHash }); if (initial) choose(initial, false); }, [detail, inspected.id, inspected.contentHash, stored, allowed]);
  const choices = useMemo(() => {
    if (inventoryError) return [];
    const versions = new Map(detail.versions.map(version => [version.id, version]));
    const seen = new Set<string>();
    const runs = (Array.isArray(detail.reviews) && detail.reviews.length <= FINDING_NAVIGATION_LIMITS.maxSnapshotItems ? detail.reviews : []).flatMap(run => {
      const choice = recordedReviewSelection(run);
      if (!choice || !isFindingSelection(choice, id) || seen.has(run.id)) return [];
      seen.add(run.id); const version = versions.get(run.versionId);
      const model = typeof run.model === 'string' ? run.model.slice(0, 100) : 'Unavailable model';
      return [{ value: `recorded:${run.id}`, choice, label: `Version ${version?.contentHash === run.contentHash ? version.number : 'unavailable'} · ${run.provider === 'local' ? 'Local deterministic checks' : run.provider === 'ollama' ? 'Local AI review' : run.provider === 'openai' ? 'Hosted AI review' : 'Unavailable provider'} · ${model} · ${new Date(run.createdAt).toLocaleString()} · ${run.id.slice(0, 8)}` }];
    });
    const local = onDevice ? onDeviceFindingSelection(onDevice) : null;
    return [...runs, ...(local ? [{ value: `on-device:${local.review.kind === 'on-device' ? local.review.analysisId : ''}`, choice: local, label: `Version ${versions.get(local.review.versionId)?.number ?? 'unavailable'} · On-device deterministic checks · not recorded on server` }] : [])];
  }, [detail, onDevice, id, inventoryError]);
  const choiceValue = selected ? selected.review.kind === 'recorded' ? `recorded:${selected.review.reviewId}` : `on-device:${selected.review.analysisId}` : '';
  const cursor = current && selected ? current.analysis.findings.findIndex(finding => finding.id === selected.findingId) : -1;
  const page = Math.floor(Math.max(0, cursor) / PAGE_SIZE);
  const findings = current?.analysis.findings || [];
  const source = current?.finding ? findingSource(current.version, current.finding) : null;
  const execute = (action: FindingVoiceAction): { text: string; identity: string; comparisonIdentity?: string } => {
    if (!active()) return { text: 'This review evidence is unavailable.', identity: identity() };
    const pin = selectedRef.current;
    const proof = pin ? resolveFindingSelection(detail, pin, onDevice || undefined) : null;
    if (!proof || 'error' in proof) return { text: proof && 'error' in proof ? proof.error : 'Choose a recorded review or on-device analysis first.', identity: identity() };
    if (action === 'findings') return { text: findingNarration(proof, 'all'), identity: identity() };
    if (action === 'currentFinding') return { text: findingNarration(proof, 'current'), identity: identity() };
    if (action === 'findingSource') {
      if (!proof.finding) return { text: 'Select a finding first. Say next finding to begin.', identity: identity() };
      const location = findingSource(proof.version, proof.finding);
      if (location.status !== 'ready') return { text: location.message, identity: identity() };
      const origin = findingSelectionIdentity(pin!), ticket = sequence.current, expectedEvidence = evidenceRef.current.generation;
      const answer = openSource(proof.version, proof.finding, () => active() && ticket === sequence.current && expectedEvidence === evidenceRef.current.generation && Boolean(selectedRef.current && origin === findingSelectionIdentity(selectedRef.current)));
      if (answer.comparisonIdentity) context.current = answer.comparisonIdentity;
      setBoundary(answer.text);
      return { ...answer, identity: identity() };
    }
    const next = moveFindingCursor(proof.analysis.findings, pin!.findingId, action === 'nextFinding' ? 1 : -1);
    const hint = next.boundary === 'unavailable' ? 'The selected finding is unavailable. Choose a review explicitly.' : next.boundary === 'empty' ? 'No findings were recorded in this review.' : next.boundary === 'first' ? 'At the beginning of this review.' : next.boundary === 'last' ? 'At the end of this review.' : '';
    choose({ ...pin!, findingId: next.findingId }, false, true); setBoundary(hint);
    const nextProof = resolveFindingSelection(detail, selectedRef.current!, onDevice || undefined);
    return { text: hint || ('error' in nextProof ? nextProof.error : findingNarration(nextProof, 'current')), identity: identity() };
  };
  const executeRef = useRef(execute); executeRef.current = execute;
  const manual = (action: FindingVoiceAction) => { if (!active()) return; manualNavigation(); return executeRef.current(action); };
  const speechContext = identity();
  useLayoutEffect(() => { register(active() && !inventoryError ? { revisionId: id, sourceChanged: source => { context.current = source; return latestIdentity.current(); }, get identity() { return latestIdentity.current(); }, execute: action => executeRef.current(action) } : null); }, [speechContext, allowed, inventoryError, register]);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; if (frame.current !== null) cancelAnimationFrame(frame.current); register(null); }; }, [register]);
  useEffect(() => {
    const retire = () => { sequence.current++; register(null); manualNavigation(); if (frame.current !== null) cancelAnimationFrame(frame.current); refreshAuthority(value => value + 1); };
    const offAccess = client.onAccessChange(ids => { if (ids.includes(id) || dependencies.some(([dependency]) => ids.includes(dependency))) retire(); });
    const offSnapshot = client.onTaskSnapshotChange(() => { if ((client.session?.accessEpoch ?? -1) !== epoch) retire(); });
    const offSession = onSessionLocked(retire);
    return () => { offAccess(); offSnapshot(); offSession(); };
  }, [id, epoch, dependencyIdentity, register]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (!active() || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || window.getSelection()?.toString()) return;
      const element = event.target instanceof Element ? event.target : null;
      if (element?.closest('input, textarea, select, button, a, form, object, embed, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="slider"]')) return;
      if ([...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"], [aria-modal="true"]')].some(dialog => !dialog.hidden && dialog.getAttribute('aria-hidden') !== 'true' && dialog.getClientRects().length > 0)) return;
      if (event.key !== 'n' && event.key !== 'p') return;
      event.preventDefault(); manual(event.key === 'n' ? 'nextFinding' : 'previousFinding');
    };
    document.addEventListener('keydown', keyboard); return () => document.removeEventListener('keydown', keyboard);
  });
  return <section className="review-findings" aria-label="Review findings">
    {!active() ? <p className="banner warning" role="status">Review evidence authority changed. Reload the revision before reading findings.</p> : inventoryError ? <p className="banner warning" role="status">{inventoryError}</p> : <>
      <div className="finding-toolbar"><label className="field"><span>Review run</span><select aria-label="Review run" value={choiceValue} onChange={event => { const choice = choices.find(item => item.value === event.target.value); if (choice) choose(choice.choice, true); }}><option value="" disabled>Choose a review</option>{choiceValue && !choices.some(item => item.value === choiceValue) && <option value={choiceValue}>Unavailable selected review</option>}{choices.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><button className="button" onClick={() => { const choice = defaultFindingSelection(detail, { id: inspected.id, contentHash: inspected.contentHash }); if (choice) choose(choice, true); else setBoundary(`No recorded review evidence for inspected version ${inspected.number}. Choose a historical run explicitly.`); }}>Choose review for inspected version</button></div>
      {onDevice && !(selected?.review.kind === 'on-device' && selected.review.analysisId === onDevice.id) && <div className="info-strip"><p>New on-device checks are available. They are not recorded on the server and have not replaced this review selection.</p><button className="button" onClick={() => { const choice = onDeviceFindingSelection(onDevice); if (choice) choose(choice, true); }}>View new on-device checks</button></div>}
      <p className="info-strip">Review selection stays fixed when new reviews or source versions arrive. Findings keep their original source; reading them does not change acceptance or request another review.</p>
      {!online && <p className="info-strip">Reading saved, authorized review evidence offline.</p>}
      {warning && <p className="banner warning" role="status">{warning}</p>}
      {boundary && <p role="status" className="info-strip">{boundary}</p>}
      {!current ? <p className="info-strip" role="status">{resolved && 'error' in resolved ? resolved.error : stored !== null ? 'Saved finding selection is invalid. Choose a review explicitly to replace it.' : `No recorded review evidence for version ${inspected.number}. Run local checks or explicitly request an AI review.`}</p> : <>
        <div className="finding-review-summary"><h3>{current.provenance} · Version {current.version.number}</h3>{current.review && <p className="small muted">Recorded {new Date(current.review.createdAt).toLocaleString()} · Review {current.review.id}</p>}<p className="finding-literal">{current.analysis.summary}</p><details><summary>Exact review source identity</summary><p>Version {current.version.number} · <code>{current.version.id}</code></p><p>Snapshot <code>{current.version.contentHash}</code></p></details>{current.version.id !== inspected.id && <p className="info-strip">This review belongs to Version {current.version.number}; the source reader is on Version {inspected.number}. Open an original finding source explicitly to switch.</p>}</div>
        <div className="finding-navigation" aria-label="Finding navigation"><button className="button" onClick={() => manual('previousFinding')}>Previous finding</button><span role="status">{cursor >= 0 ? `Finding ${cursor + 1} of ${findings.length}` : `No finding selected · ${findings.length} findings`}</span><button className="button" onClick={() => manual('nextFinding')}>Next finding</button><button className="button" disabled={!source || source.status !== 'ready'} onClick={() => manual('findingSource')}>Open original finding source</button><small>Keyboard: n/p for findings; j/k for source changes. Voice: read findings, read current finding, next finding, previous finding, open original finding source.</small></div>
        {source?.status === 'unavailable' && <p className="info-strip" role="status">{source.message}</p>}
        {!findings.length && <p className="info-strip">No findings were recorded in this review. This does not verify factual or legal correctness.</p>}
        {findings.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((finding, index) => <article key={finding.id} className={`finding finding-${finding.severity}`} tabIndex={-1} data-finding-id={finding.id} aria-current={selected?.findingId === finding.id ? 'true' : undefined} ref={element => { if (element) elements.current.set(finding.id, element); else elements.current.delete(finding.id); }}><div><span className={`badge badge-${finding.severity}`}>{finding.severity}</span><h4>{finding.title}</h4><button className="text-button" onClick={() => choose({ ...selected!, findingId: finding.id }, true, true)}>Select finding {page * PAGE_SIZE + index + 1}</button></div><p className="small"><code>{finding.filePath}:{finding.line}</code> · {finding.source === 'local' ? 'Deterministic check' : 'AI finding'}</p><p className="finding-literal">{finding.body}</p></article>)}
        {findings.length > PAGE_SIZE && <div className="finding-pages"><button className="button" disabled={page === 0} onClick={() => choose({ ...selected!, findingId: findings[(page - 1) * PAGE_SIZE]!.id }, true, true)}>Previous findings page</button><span>Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, findings.length)} of {findings.length}</span><button className="button" disabled={(page + 1) * PAGE_SIZE >= findings.length} onClick={() => choose({ ...selected!, findingId: findings[(page + 1) * PAGE_SIZE]!.id }, true, true)}>Next findings page</button></div>}
      </>}
    </>}
    <button className="button finding-reload" disabled={!online} onClick={() => { sequence.current++; manualNavigation(); void reload(); }}>Reload review evidence</button>
  </section>;
}
