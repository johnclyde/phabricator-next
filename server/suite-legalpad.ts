import { createHash, randomUUID } from 'node:crypto';
import { legalpadActiveSignature, legalpadCurrent, type LegalpadData, type LegalpadSignature, type LegalpadVersion } from '../shared/legalpad.ts';
import type { SuiteContext, SuiteModule } from './suite-contract.ts';
import { choice, HttpError, integer, object, optionalString, string } from './validation.ts';

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function version(input: Record<string, unknown>, context: SuiteContext, number: number): LegalpadVersion {
  const content = { version: number, title: string(input.title, 'Title', 240).trim(), text: string(input.text, 'Agreement text', 300_000), preamble: optionalString(input.preamble, 'Preamble', 50_000), signatureType: choice(input.signatureType ?? 'individual', 'signature type', ['individual', 'corporation', 'none'] as const) };
  return { ...content, contentHash: digest(content), createdAt: context.now, authorId: context.actor.principalId };
}
function people(value: unknown, context: SuiteContext): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'Required signers must be a list of people.');
  return [...new Set(value.map(id => context.requirePerson(string(id, 'Signer ID', 100)).id))];
}
function active(data: LegalpadData): void { if (data.status !== 'active') throw new HttpError(409, 'This document is archived.'); }
function exact(data: LegalpadData, input: Record<string, unknown>): LegalpadVersion {
  const current = legalpadCurrent(data);
  if (integer(input.documentVersion, 'Document version') !== current.version || string(input.contentHash, 'Content hash', 64) !== current.contentHash) throw new HttpError(409, 'The agreement changed. Read the current text before signing.');
  return current;
}
function personal(context: SuiteContext): void {
  if (context.actor.kind === 'token') throw new HttpError(403, 'Sign in with an interactive account to record your signature.');
  context.requirePerson(context.actor.principalId);
}
function append(data: LegalpadData, signature: Omit<LegalpadSignature, 'receiptHash'>): LegalpadSignature {
  const result = { ...signature, receiptHash: digest(signature) }; data.signatures.push(result); return result;
}

export const legalpadModule: SuiteModule = {
  app: 'legalpad', prefix: 'LP',
  create(input, context) {
    const value = object(input, ['kind', 'title', 'text', 'preamble', 'signatureType', 'requiredSignerIds']);
    if (value.kind !== undefined && value.kind !== 'document') throw new HttpError(400, 'Choose a Legalpad document.');
    const body = version(value, context, 1), requiredSignerIds = people(value.requiredSignerIds, context);
    if (body.signatureType === 'none' && requiredSignerIds.length) throw new HttpError(400, 'An unsigned document cannot require signatures.');
    const data: LegalpadData = { status: 'active', versions: [body], signatures: [], revocations: [], requiredSignerIds, comments: [] };
    return { kind: 'document', title: body.title, data, summary: 'Created agreement version 1.' };
  },
  command(record, action, input, context) {
    const data = structuredClone(record.data) as LegalpadData;
    if (action === 'comment') {
      const value = object(input, ['text']); active(data);
      data.comments.push({ id: randomUUID(), authorId: context.actor.principalId, authorName: context.actor.displayName, text: string(value.text, 'Comment', 50_000), createdAt: context.now });
      return { data, summary: 'Commented on the agreement.' };
    }
    if (action === 'sign') {
      const value = object(input, ['documentVersion', 'contentHash', 'signerName', 'agree', 'companyName', 'companyAddress', 'contactEmail', 'authority']);
      active(data); personal(context); const current = exact(data, value);
      if (current.signatureType === 'none') throw new HttpError(409, 'This document does not accept signatures.');
      if (value.agree !== true) throw new HttpError(400, 'Explicitly agree to this exact document before signing.');
      if (legalpadActiveSignature(data, context.actor.principalId)) throw new HttpError(409, 'Your signature or exemption already covers this version.');
      const signerName = string(value.signerName, 'Signer name', 240).trim();
      let companyName = '', companyAddress = '', contactEmail = '';
      if (current.signatureType === 'corporation') {
        if (value.authority !== true) throw new HttpError(400, 'Confirm your authority to sign for the company.');
        companyName = string(value.companyName, 'Company name', 240).trim(); companyAddress = string(value.companyAddress, 'Company address', 5000).trim();
        contactEmail = string(value.contactEmail, 'Contact email', 254).trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) throw new HttpError(400, 'Provide a contact email address.');
      } else if (value.companyName || value.companyAddress || value.contactEmail || value.authority) throw new HttpError(400, 'Company fields apply only to corporate signatures.');
      append(data, { id: randomUUID(), documentId: record.id, documentVersion: current.version, contentHash: current.contentHash, signerId: context.actor.principalId, signerName, signatureType: current.signatureType, kind: 'signature', actorId: context.actor.principalId, signedAt: context.now, companyName, companyAddress, contactEmail, notes: '' });
      return { data, summary: `Recorded a personal signature decision for agreement version ${current.version}.` };
    }
    if (action === 'withdraw') {
      const value = object(input, ['signatureId', 'reason']); personal(context);
      const id = string(value.signatureId, 'Signature ID', 100), signature = data.signatures.find(item => item.id === id && item.signerId === context.actor.principalId && item.kind === 'signature');
      if (!signature) throw new HttpError(404, 'Signature was not found.');
      if (data.revocations.some(item => item.signatureId === id)) throw new HttpError(409, 'This signature has already been withdrawn or voided.');
      data.revocations.push({ signatureId: id, kind: 'withdrawn', actorId: context.actor.principalId, createdAt: context.now, reason: string(value.reason, 'Reason', 5000) });
      return { data, summary: 'Recorded a signature withdrawal; the original receipt is preserved.' };
    }
    context.requireEdit(record);
    if (action === 'revise') {
      active(data); const value = object(input, ['title', 'text', 'preamble', 'signatureType']);
      const body = version(value, context, legalpadCurrent(data).version + 1);
      if (body.signatureType === 'none' && data.requiredSignerIds.length) throw new HttpError(409, 'Remove signature requirements before changing to an unsigned document.');
      data.versions.push(body);
      return { title: body.title, data, summary: `Published agreement version ${body.version}; earlier signatures remain attached to their original text.` };
    }
    if (action === 'requirements') {
      active(data); const value = object(input, ['requiredSignerIds']); data.requiredSignerIds = people(value.requiredSignerIds, context);
      if (legalpadCurrent(data).signatureType === 'none' && data.requiredSignerIds.length) throw new HttpError(400, 'An unsigned document cannot require signatures.');
      return { data, summary: 'Updated the requested signers for this agreement.' };
    }
    if (action === 'exempt') {
      active(data); const value = object(input, ['signerId', 'reason', 'documentVersion', 'contentHash']), current = exact(data, value), person = context.requirePerson(string(value.signerId, 'Signer ID', 100));
      if (current.signatureType !== 'individual') throw new HttpError(409, 'Individual signature exemptions require an individual agreement.');
      if (legalpadActiveSignature(data, person.id)) throw new HttpError(409, 'This person already has a signature or exemption for this version.');
      append(data, { id: randomUUID(), documentId: record.id, documentVersion: current.version, contentHash: current.contentHash, signerId: person.id, signerName: person.displayName, signatureType: current.signatureType, kind: 'exemption', actorId: context.actor.principalId, signedAt: context.now, companyName: '', companyAddress: '', contactEmail: '', notes: string(value.reason, 'Exemption reason', 5000) });
      return { data, summary: `Recorded an individual signature exemption for agreement version ${current.version}.` };
    }
    if (action === 'void') {
      const value = object(input, ['signatureId', 'reason']), id = string(value.signatureId, 'Signature ID', 100);
      if (!data.signatures.some(item => item.id === id)) throw new HttpError(404, 'Signature was not found.');
      if (data.revocations.some(item => item.signatureId === id)) throw new HttpError(409, 'This signature has already been withdrawn or voided.');
      data.revocations.push({ signatureId: id, kind: 'voided', actorId: context.actor.principalId, createdAt: context.now, reason: string(value.reason, 'Reason', 5000) });
      return { data, summary: 'Voided a signature receipt; the original receipt is preserved.' };
    }
    if (action === 'archive' || action === 'restore') {
      object(input, []); const status = action === 'archive' ? 'archived' : 'active';
      if (data.status === status) throw new HttpError(409, 'This document already has that status.');
      data.status = status; return { data, summary: `${action === 'archive' ? 'Archived' : 'Restored'} agreement.` };
    }
    throw new HttpError(400, 'Unknown Legalpad action.');
  },
  presentEvents(events, record, context) {
    if (context.canEdit(record)) return events;
    return events.filter(event => !['sign', 'withdraw', 'exempt', 'void'].includes(event.action) || (['sign', 'withdraw'].includes(event.action) && event.actorId === context.actor.principalId));
  },
  present(record, context) {
    const data = structuredClone(record.data) as LegalpadData, editor = context.canEdit(record);
    data.signatureCount = data.signatures.length;
    data.requirements = data.requiredSignerIds.filter(id => editor || id === context.actor.principalId).map(principalId => { const signature = legalpadActiveSignature(data, principalId); return { principalId, status: !signature ? 'required' : signature.kind === 'exemption' ? 'exempt' : 'signed' }; });
    data.requiredSignerIds = data.requiredSignerIds.filter(id => editor || id === context.actor.principalId);
    data.signatures = data.signatures.filter(item => editor || item.signerId === context.actor.principalId);
    const visible = new Set(data.signatures.map(item => item.id)); data.revocations = data.revocations.filter(item => visible.has(item.signatureId));
    return { ...record, data };
  },
};
