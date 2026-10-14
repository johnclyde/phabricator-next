import type { SuiteRecord } from './suite.ts';
export type LegalpadSignatureType = 'individual' | 'corporation' | 'none';
export interface LegalpadVersion { version: number; title: string; text: string; preamble: string; signatureType: LegalpadSignatureType; contentHash: string; createdAt: string; authorId: string }
export interface LegalpadSignature {
  id: string; documentId: string; documentVersion: number; contentHash: string;
  signerId: string; signerName: string; signatureType: LegalpadSignatureType;
  kind: 'signature' | 'exemption'; actorId: string; signedAt: string;
  companyName: string; companyAddress: string; contactEmail: string;
  notes: string; receiptHash: string;
}
export interface LegalpadRevocation { signatureId: string; kind: 'withdrawn' | 'voided'; actorId: string; createdAt: string; reason: string }
export interface LegalpadData extends Record<string, unknown> {
  status: 'active' | 'archived'; versions: LegalpadVersion[];
  signatures: LegalpadSignature[]; revocations: LegalpadRevocation[];
  requiredSignerIds: string[];
  comments: { id: string; authorId: string; authorName: string; text: string; createdAt: string }[];
  requirements?: { principalId: string; status: 'required' | 'signed' | 'exempt' }[];
  signatureCount?: number;
}
export type LegalpadRecord = SuiteRecord<LegalpadData>;
export function legalpadCurrent(data: LegalpadData): LegalpadVersion { return data.versions[data.versions.length - 1]!; }
export function legalpadActiveSignature(data: LegalpadData, principalId: string): LegalpadSignature | undefined {
  const current = legalpadCurrent(data);
  return data.signatures.find(signature => signature.signerId === principalId && signature.documentVersion === current.version && signature.contentHash === current.contentHash && !data.revocations.some(revocation => revocation.signatureId === signature.id));
}
