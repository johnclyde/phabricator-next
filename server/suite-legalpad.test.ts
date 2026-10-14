import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { SuiteRecord, SuiteEvent } from '../shared/suite.ts';
import { legalpadActiveSignature, legalpadCurrent, type LegalpadData } from '../shared/legalpad.ts';
import type { SuiteContext } from './suite-contract.ts';
import { legalpadModule as module } from './suite-legalpad.ts';
import { HttpError } from './validation.ts';
function setup(extra: Record<string, unknown> = {}) {
  const context: SuiteContext = {
    actor: { principalId: 'alice', displayName: 'Alice', workspaceId: 'test', kind: 'session', credentialId: 'auth', sessionContext: 'session', scopes: ['read', 'write'] }, now: '2026-10-14T00:00:00.000Z',
    get() { throw new HttpError(404, 'Not found.'); }, list() { return []; }, exists() { return false; },
    canEdit(record) { return record.ownerId === context.actor.principalId; }, requireEdit(record) { if (!context.canEdit(record)) throw new HttpError(403, 'Forbidden.'); },
    requirePerson(id) { if (!['alice', 'bob', 'carol'].includes(id)) throw new HttpError(400, 'Unknown person.'); return { id, displayName: id }; },
  };
  const value = module.create({ kind: 'document', title: 'Contributor Agreement', text: 'I agree to contribute under the stated terms.', signatureType: 'individual', requiredSignerIds: ['bob'], ...extra }, context);
  const record: SuiteRecord = { ...value, app: 'legalpad', id: 'LP1', ownerId: 'alice', version: 1, createdAt: context.now, updatedAt: context.now, access: { spaceId: 'S1', visibility: 'workspace', memberIds: [], editorIds: [] } };
  const command = (action: string, input: unknown = {}) => { const result = module.command(record, action, input, context); record.data = result.data; if (result.title) record.title = result.title; record.version++; return record.data as LegalpadData; };
  const sign = (extra: Record<string, unknown> = {}) => { const current = legalpadCurrent(record.data as LegalpadData); return command('sign', { documentVersion: current.version, contentHash: current.contentHash, signerName: context.actor.displayName, agree: true, ...extra }); };
  return { context, record, command, sign };
}

test('Legalpad stores immutable versioned agreement content and verifiable exact-version receipts', () => {
  const s = setup(); s.context.actor.principalId = 'bob'; s.context.actor.displayName = 'Bob';
  const data = s.sign(), signature = data.signatures[0]!, { receiptHash, ...receipt } = signature;
  assert.equal(receiptHash, createHash('sha256').update(JSON.stringify(receipt)).digest('hex'));
  assert.equal(signature.documentVersion, 1); assert.equal(signature.contentHash, legalpadCurrent(data).contentHash); assert.equal(signature.signerId, 'bob');
  assert.equal(legalpadActiveSignature(data, 'bob')?.id, signature.id);
  const oldVersion = structuredClone(data.versions[0]), oldReceipt = structuredClone(signature);
  s.context.actor.principalId = 'alice'; s.command('revise', { title: 'Changed agreement', text: 'New terms.', preamble: 'Read carefully.', signatureType: 'individual' });
  const next = s.record.data as LegalpadData;
  assert.deepEqual(next.versions[0], oldVersion); assert.deepEqual(next.signatures[0], oldReceipt); assert.equal(next.versions.length, 2); assert.equal(legalpadActiveSignature(next, 'bob'), undefined);
});
test('Legalpad signing requires explicit consent, current content hash and current version', () => {
  const s = setup();
  for (const patch of [{ agree: false }, { agree: 'true' }, { contentHash: 'f'.repeat(64) }, { documentVersion: 2 }, { signerName: '' }]) assert.throws(() => s.sign(patch), HttpError);
  assert.equal((s.record.data as LegalpadData).signatures.length, 0);
  s.sign(); assert.throws(() => s.sign(), /already covers/);
});
test('Legalpad personal signing does not require document editing but token automation is refused', () => {
  const s = setup(); s.context.actor.principalId = 'bob';
  assert.throws(() => s.command('revise', { title: 'Stolen', text: 'x' }), /Forbidden/);
  assert.throws(() => s.command('requirements', { requiredSignerIds: [] }), /Forbidden/);
  s.context.actor.kind = 'token'; assert.throws(() => s.sign(), /interactive account/);
  s.context.actor.kind = 'session'; s.sign(); assert.equal((s.record.data as LegalpadData).signatures[0]?.signerId, 'bob');
});
test('Legalpad signature identities, contact details and personal history are private to signer and editor', () => {
  const s = setup({ signatureType: 'corporation' }); s.context.actor.principalId = 'bob'; s.sign({ authority: true, companyName: 'Example Company', companyAddress: '123 Example St', contactEmail: 'contact@example.test' });
  s.context.actor.principalId = 'carol'; let shown = module.present!(s.record, s.context).data as LegalpadData;
  assert.equal(shown.signatures.length, 0); assert.deepEqual(shown.requiredSignerIds, []); assert.equal(shown.signatureCount, 1);
  const event = { sequence: 2, recordId: s.record.id, version: 2, actorId: 'bob', actorName: 'Bob', action: 'sign', summary: 'Signed.', createdAt: s.context.now } satisfies SuiteEvent;
  assert.deepEqual(module.presentEvents!([event], s.record, s.context), []);
  s.context.actor.principalId = 'bob'; shown = module.present!(s.record, s.context).data as LegalpadData; assert.equal(shown.signatures[0]?.contactEmail, 'contact@example.test'); assert.equal(module.presentEvents!([event], s.record, s.context).length, 1);
  s.context.actor.principalId = 'alice'; assert.equal((module.present!(s.record, s.context).data as LegalpadData).signatures.length, 1);
});
test('Legalpad corporate signatures require explicit authority and full company/contact information', () => {
  const s = setup({ signatureType: 'corporation' }), fields = { authority: true, companyName: 'Example Company', companyAddress: '123 Example St', contactEmail: 'contact@example.test' };
  for (const patch of [{ authority: false }, { companyName: '' }, { companyAddress: '' }, { contactEmail: 'missing-at' }]) assert.throws(() => s.sign({ ...fields, ...patch }), HttpError);
  s.sign(fields); assert.equal((s.record.data as LegalpadData).signatures[0]?.signatureType, 'corporation');
  assert.throws(() => setup().sign(fields), /Company fields/);
});
test('Legalpad tracks signature requirements and individual exemptions against current text', () => {
  const s = setup(), current = legalpadCurrent(s.record.data as LegalpadData);
  assert.equal((module.present!(s.record, s.context).data as LegalpadData).requirements?.[0]?.status, 'required');
  s.command('exempt', { signerId: 'bob', reason: 'Equivalent agreement recorded externally.', documentVersion: current.version, contentHash: current.contentHash });
  assert.equal((module.present!(s.record, s.context).data as LegalpadData).requirements?.[0]?.status, 'exempt');
  assert.throws(() => s.command('exempt', { signerId: 'bob', reason: 'Duplicate', documentVersion: 1, contentHash: current.contentHash }), /already has/);
  s.command('revise', { title: 'New terms', text: 'Changed terms.', signatureType: 'individual' });
  assert.equal((module.present!(s.record, s.context).data as LegalpadData).requirements?.[0]?.status, 'required');
  assert.throws(() => s.command('exempt', { signerId: 'bob', reason: 'Old version', documentVersion: 1, contentHash: current.contentHash }), /agreement changed/);
});
test('Legalpad withdrawal and editor voiding preserve original receipts and require reasons', () => {
  const s = setup(); s.context.actor.principalId = 'bob'; const data = s.sign(), receipt = structuredClone(data.signatures[0]!);
  s.context.actor.principalId = 'carol'; assert.throws(() => s.command('withdraw', { signatureId: receipt.id, reason: 'Not mine' }), /not found/); assert.throws(() => s.command('void', { signatureId: receipt.id, reason: 'Not editor' }), /Forbidden/);
  s.context.actor.principalId = 'bob'; assert.throws(() => s.command('withdraw', { signatureId: receipt.id, reason: '' }), HttpError);
  s.command('withdraw', { signatureId: receipt.id, reason: 'Withdrawing this recorded decision.' }); assert.deepEqual((s.record.data as LegalpadData).signatures[0], receipt); assert.equal(legalpadActiveSignature(s.record.data as LegalpadData, 'bob'), undefined);
  s.sign(); const newReceipt = (s.record.data as LegalpadData).signatures[1]!;
  s.context.actor.principalId = 'alice'; s.command('void', { signatureId: newReceipt.id, reason: 'Recorded in error.' }); assert.equal((s.record.data as LegalpadData).revocations.length, 2); assert.equal(legalpadActiveSignature(s.record.data as LegalpadData, 'bob'), undefined);
  assert.throws(() => s.command('void', { signatureId: newReceipt.id, reason: 'Again' }), /already been/);
});
test('Legalpad archived documents reject new signatures and revisions but preserve receipts', () => {
  const s = setup(); s.sign(); s.command('archive'); assert.throws(() => s.sign(), /archived/); assert.throws(() => s.command('revise', { title: 'no', text: 'no' }), /archived/);
  assert.equal((s.record.data as LegalpadData).signatures.length, 1); s.command('restore'); assert.equal((s.record.data as LegalpadData).status, 'active');
});
test('Legalpad unsigned documents and invalid recipients cannot acquire signature requirements', () => {
  assert.throws(() => setup({ signatureType: 'none' }), /unsigned document/);
  const s = setup({ signatureType: 'none', requiredSignerIds: [] }); assert.throws(() => s.sign(), /does not accept/);
  assert.throws(() => s.command('requirements', { requiredSignerIds: ['bob'] }), /unsigned document/);
  assert.throws(() => setup({ requiredSignerIds: ['unknown'] }), /Unknown person/);
  assert.throws(() => setup().command('revise', { title: 'x', text: 'x', signatureType: 'none' }), /Remove signature requirements/);
});
test('Legalpad failed mutations leave stored content and signatures untouched', () => {
  const s = setup(), before = structuredClone(s.record);
  assert.throws(() => s.sign({ agree: false }), /Explicitly agree/); assert.deepEqual(s.record, before);
  assert.throws(() => s.command('requirements', { requiredSignerIds: ['bob', 'not-a-person'] }), /Unknown person/); assert.deepEqual(s.record, before);
});

test('Legalpad readers can discuss the agreement without altering its terms', () => { const s = setup(); s.context.actor.principalId = 'bob'; const before = structuredClone((s.record.data as LegalpadData).versions); s.command('comment', { text: 'Please clarify this paragraph.' }); assert.equal((s.record.data as LegalpadData).comments[0]?.authorId, 'bob'); assert.deepEqual((s.record.data as LegalpadData).versions, before); assert.throws(() => s.command('comment', { text: '' }), HttpError); });
