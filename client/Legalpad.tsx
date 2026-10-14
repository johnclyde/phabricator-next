import type { AppState } from '../shared/types';
import type { SuiteDetail, SuiteRecord } from '../shared/suite';
import { legalpadActiveSignature, legalpadCurrent, type LegalpadData } from '../shared/legalpad';
import { exportAutomation } from './AutomationSupport';
import { SuiteScreen, type SuiteField, type SuiteForm } from './SuiteScreen';

const bodyFields: SuiteField[] = [
  { name: 'title', label: 'Agreement title', type: 'text', required: true },
  { name: 'preamble', label: 'Preamble', type: 'textarea' },
  { name: 'text', label: 'Agreement text', type: 'textarea', required: true },
  { name: 'signatureType', label: 'Signature type', type: 'select', required: true, options: [{ value: 'individual', label: 'Individual' }, { value: 'corporation', label: 'Company representative' }, { value: 'none', label: 'No signature' }] },
];
function LegalpadDetails({ record, state }: { record: SuiteRecord; state: AppState }) {
  const data = record.data as LegalpadData, current = legalpadCurrent(data), mine = legalpadActiveSignature(data, state.currentPrincipalId);
  const person = (id: string) => state.principals.find(item => item.id === id)?.displayName || id;
  return <div><p><span className="badge">{data.status === 'active' ? 'Active agreement' : 'Archived agreement'}</span> · Version {current.version} · {current.signatureType === 'none' ? 'No signature required' : current.signatureType === 'individual' ? 'Individual signatures' : 'Company signatures'}</p>
    {current.preamble && <p className="info-strip audit-comment">{current.preamble}</p>}
    <article aria-label="Agreement text"><h3>{current.title}</h3><div className="audit-comment">{current.text}</div></article>
    <p className="small muted">Published {new Date(current.createdAt).toLocaleString()} · Content fingerprint <code style={{ overflowWrap: 'anywhere' }}>{current.contentHash}</code></p>
    {mine && <p className="info-strip">{mine.kind === 'exemption' ? 'You have a recorded exemption for this version.' : 'You signed this exact version.'}</p>}
    {Boolean(data.requirements?.length) && <section><h3>Signature requests</h3><ul>{data.requirements!.map(item => <li key={item.principalId}>{person(item.principalId)} · {item.status === 'required' ? 'Awaiting this version' : item.status === 'exempt' ? 'Exempt for this version' : 'Signed this version'}</li>)}</ul></section>}
    <section><h3>Signature receipts</h3><p className="small muted">Receipts are visible to their signer and agreement editors.</p>{data.signatures.length ? data.signatures.map(signature => {
      const revocation = data.revocations.find(item => item.signatureId === signature.id), body = data.versions.find(item => item.version === signature.documentVersion);
      return <article key={signature.id} className="automation-transcript"><h4>{signature.signerName} · {signature.kind === 'exemption' ? 'Exemption' : 'Signature'}</h4><p>Version {signature.documentVersion} · {new Date(signature.signedAt).toLocaleString()} · {revocation ? revocation.kind : signature.documentVersion === current.version ? 'Current version' : 'Earlier version'}</p>{signature.companyName && <p className="audit-comment">{signature.companyName}{'\n'}{signature.companyAddress}{'\n'}{signature.contactEmail} (provided contact address)</p>}{signature.notes && <p>{signature.notes}</p>}{revocation && <p>{revocation.reason}</p>}<button type="button" className="button" onClick={() => exportAutomation({ agreement: body, signature, revocation: revocation || null }, `${record.id}-receipt-${signature.id}`)}>Download Receipt</button></article>;
    }) : <p className="muted">No receipts are visible to you yet.</p>}</section>
    {data.comments.length > 0 && <section><h3>Discussion</h3>{data.comments.map(comment => <article key={comment.id}><strong>{comment.authorName}</strong><p className="small muted">{new Date(comment.createdAt).toLocaleString()}</p><div className="audit-comment">{comment.text}</div></article>)}</section>}
    {data.versions.length > 1 && <section><h3>Earlier versions</h3>{data.versions.slice(0, -1).reverse().map(body => <details key={body.version}><summary>Version {body.version} · {body.title}</summary>{body.preamble && <p className="audit-comment">{body.preamble}</p>}<div className="audit-comment">{body.text}</div><p className="small muted" style={{ overflowWrap: 'anywhere' }}>{body.contentHash}</p></details>)}</section>}
  </div>;
}
export function Legalpad({ state, online }: { state: AppState; online: boolean }) {
  const people = state.principals.filter(person => !person.disabled).map(person => ({ value: person.id, label: person.displayName }));
  const requirements: SuiteField = { name: 'requiredSignerIds', label: 'Request signatures from', type: 'multi', options: people };
  function forms(record: SuiteRecord | null, detail?: SuiteDetail): SuiteForm[] {
    if (!record) return [{ key: 'document', label: 'Create Agreement', fields: [...bodyFields, requirements], values: { signatureType: 'individual', requiredSignerIds: [] } }];
    const data = record.data as LegalpadData, current = legalpadCurrent(data), result: SuiteForm[] = [], mine = legalpadActiveSignature(data, state.currentPrincipalId);
    if (data.status === 'active') result.push({ key: 'comment', label: 'Comment', fields: [{ name: 'text', label: 'Comment', type: 'textarea', required: true }] });
    if (data.status === 'active' && current.signatureType !== 'none' && !mine) result.push({ key: 'sign', label: `Sign Version ${current.version}`, fields: [
      { name: 'signerName', label: 'Your full name', type: 'text', required: true },
      ...(current.signatureType === 'corporation' ? [
        { name: 'companyName', label: 'Company name', type: 'text', required: true }, { name: 'companyAddress', label: 'Company address', type: 'textarea', required: true }, { name: 'contactEmail', label: 'Contact email', type: 'text', required: true }, { name: 'authority', label: 'I am authorized to sign for this company', type: 'checkbox', required: true },
      ] satisfies SuiteField[] : []),
      { name: 'agree', label: `I have read and agree to version ${current.version} of this agreement`, type: 'checkbox', required: true },
    ], values: { documentVersion: current.version, contentHash: current.contentHash, signerName: state.principals.find(person => person.id === state.currentPrincipalId)?.displayName || '', agree: false, ...(current.signatureType === 'corporation' ? { authority: false } : {}) }, confirm: `Record your signature on version ${current.version} of “${current.title}”?` });
    const mineReceipts = data.signatures.filter(item => item.signerId === state.currentPrincipalId && item.kind === 'signature' && !data.revocations.some(revocation => revocation.signatureId === item.id));
    if (mineReceipts.length) result.push({ key: 'withdraw', label: 'Withdraw My Signature', fields: [{ name: 'signatureId', label: 'Receipt', type: 'select', required: true, options: mineReceipts.map(item => ({ value: item.id, label: `Version ${item.documentVersion} · ${new Date(item.signedAt).toLocaleString()}` })) }, { name: 'reason', label: 'Withdrawal reason', type: 'textarea', required: true }], values: { signatureId: mineReceipts.at(-1)!.id }, confirm: 'Record a withdrawal? The original receipt remains in the agreement history.' });
    if (detail?.canEdit) {
      if (data.status === 'active') {
        result.push({ key: 'revise', label: 'Publish New Version', fields: bodyFields, values: { title: current.title, text: current.text, preamble: current.preamble, signatureType: current.signatureType }, confirm: 'Publish a new agreement version? Existing signatures remain attached to earlier text.' });
        result.push({ key: 'requirements', label: 'Request Signatures', fields: [requirements], values: { requiredSignerIds: data.requiredSignerIds } });
        if (current.signatureType === 'individual') result.push({ key: 'exempt', label: 'Record Exemption', fields: [{ name: 'signerId', label: 'Person to exempt', type: 'select', options: people, required: true }, { name: 'reason', label: 'Exemption reason', type: 'textarea', required: true }], values: { documentVersion: current.version, contentHash: current.contentHash } });
      }
      const active = data.signatures.filter(item => !data.revocations.some(revocation => revocation.signatureId === item.id));
      if (active.length) result.push({ key: 'void', label: 'Void Receipt', fields: [{ name: 'signatureId', label: 'Receipt to void', type: 'select', required: true, options: active.map(item => ({ value: item.id, label: `${item.signerName} · version ${item.documentVersion} · ${item.kind}` })) }, { name: 'reason', label: 'Reason for voiding receipt', type: 'textarea', required: true }], confirm: 'Void this receipt? Its original contents will be preserved.' });
      result.push({ key: data.status === 'active' ? 'archive' : 'restore', label: data.status === 'active' ? 'Archive Agreement' : 'Restore Agreement', fields: [], confirm: data.status === 'active' ? 'Archive this agreement and stop accepting new signatures?' : undefined });
    }
    return result;
  }
  return <SuiteScreen app="legalpad" title="Legalpad" online={online} state={state} forms={forms} render={record => <LegalpadDetails record={record} state={state}/>}/>;
}
export default Legalpad;
