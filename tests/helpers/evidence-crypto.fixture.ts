import { createRequire } from 'node:module';
import type forge from 'node-forge';
import type { Document } from '@xmldom/xmldom';
import type { SyntheticCdrStatus, SyntheticXmlRootKind } from '../../packages/evidence-core/src/crypto';

interface CertificateOptions {
  ruc?: string;
  commonName?: string;
  organization?: string;
  identityFields?: forge.pki.CertificateField[];
  notBefore?: string;
  notAfter?: string;
  extensions?: Record<string, unknown>[];
  sha1?: boolean;
  keyBits?: number;
}
interface SigningOptions {
  references?: number;
  uri?: string;
  xpath?: string;
  transforms?: string[];
  signatureAlgorithm?: string;
  digestAlgorithm?: string;
  keyInfo?: 'none' | 'root';
}
interface CdrOptions {
  senderRuc?: string;
  issuerRuc?: string;
  reference?: string;
  responseReference?: string;
  responseCode?: string;
  documentTypeCode?: string;
  notes?: string[];
}
export interface EvidenceCryptoFixture {
  checkedAt: string;
  senderRuc: string;
  issuerRuc: string;
  certificatePem: string;
  rootCertificatePem: string;
  pinnedRootSha256: string;
  sign(xml: string, kindOrConfig?: SyntheticXmlRootKind | SigningOptions): string;
  issueLeaf(config: CertificateOptions): string;
  issueLeafDer(edit: (asn: forge.asn1.Asn1) => void): string;
}
export type SyntheticCdrFixtureStatus = SyntheticCdrStatus | 'ACCEPTED' | 'ACCEPTED_WITH_OBSERVATIONS' | 'REJECTED';
export interface RunnerEvidenceCryptoFixture extends EvidenceCryptoFixture {
  generateSyntheticCdr(issuerRuc: string, reference: string, status: SyntheticCdrFixtureStatus, documentTypeCode?: string): string;
}

// The CLI and tests use exactly the same CJS generator, with no TS/test imports
// in the generator. This wrapper adds types only; no key implementation exists here.
const fixture = createRequire(import.meta.url)('../../migration/evidence-crypto-fixture.cjs') as {
  DS: string;
  EXT: string;
  CBC: string;
  CAC: string;
  SYNTHETIC_SCOPE: { readonly environment: 'BETA'; readonly datasetClass: 'SYNTHETIC' };
  createEvidenceCryptoFixture(options?: { root?: CertificateOptions; leaf?: CertificateOptions }): EvidenceCryptoFixture;
  buildCryptoEvidenceFixture(issuerRuc?: string): RunnerEvidenceCryptoFixture;
  generateSyntheticCdr(issuerRuc: string, reference: string, status: SyntheticCdrFixtureStatus, senderRuc?: string, documentTypeCode?: string): string;
  unsignedSyntheticCdr(options?: CdrOptions): string;
  unsignedSyntheticXml(rootKind?: SyntheticXmlRootKind, content?: string): string;
  editSyntheticXml(xml: string, edit: (document: Document) => void): string;
  corruptSyntheticCertificate(pem: string): string;
};
export const { DS, EXT, CBC, CAC, SYNTHETIC_SCOPE, createEvidenceCryptoFixture, buildCryptoEvidenceFixture,
  generateSyntheticCdr, unsignedSyntheticCdr, unsignedSyntheticXml, editSyntheticXml, corruptSyntheticCertificate } = fixture;
