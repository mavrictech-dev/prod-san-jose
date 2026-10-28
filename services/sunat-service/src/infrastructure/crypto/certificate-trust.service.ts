import { Injectable } from '@nestjs/common';
import { constants } from 'node:fs';
import { open, realpath, lstat, mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { createHash, timingSafeEqual, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { inspectCertificate } from './certificate-inspector';

export type InspectedSigningCertificate = ReturnType<typeof inspectCertificate>;
export type CertificateTrustResult = {
  profile: 'OFFLINE-PINNED-ROOTS-CRL-v1'; chainValid: boolean; identityMatched: boolean;
  revocation: 'VERIFIED_OFFLINE_CRL' | 'PENDING' | 'INVALID';
  trustStoreSha256: string | null; certificateFingerprint: string; checkedAt: string; blockers: string[];
};
const MAX_PUBLIC_FILE = 1024 * 1024;
const pemCertificates = (text: string) => text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];

/** Deployment-controlled files only. No URLs, OS roots, AIA/OCSP fetch or application upload. */
export async function loadPinnedPublicFile(path: string | undefined, expectedHash: string | undefined): Promise<{ text: string; hash: string }> {
  if (!path || !isAbsolute(path) || !expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash)) throw new Error('PINNED_FILE_NOT_CONFIGURED');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_PUBLIC_FILE || await realpath(path) !== resolve(path)) throw new Error('PINNED_FILE_INVALID');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== info.size || stat.size > MAX_PUBLIC_FILE) throw new Error('PINNED_FILE_INVALID');
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw new Error('PINNED_FILE_INVALID');
    const content = bytes.subarray(0, bytesRead);
    const hash = createHash('sha256').update(content).digest('hex');
    if (!timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'))) throw new Error('PINNED_FILE_HASH_MISMATCH');
    const text = content.toString('utf8');
    if (!Buffer.from(text).equals(content) || text.includes('\0') || /PRIVATE KEY/.test(text)) throw new Error('PINNED_FILE_INVALID');
    return { text, hash };
  } finally { await handle.close(); }
}

export type OfflineVerifyPort = (arguments_: string[]) => Promise<void>;
/** Fixed executable/options/environment, bounded process. Never forwards raw OpenSSL diagnostics. */
export async function verifyWithOpenSsl(arguments_: string[]): Promise<void> {
  const configured = process.env.SUNAT_OPENSSL_PATH;
  const executable = configured || (process.platform === 'win32' ? '' : '/usr/bin/openssl');
  if (!executable || !isAbsolute(executable)) throw new Error('OPENSSL_NOT_AVAILABLE');
  await new Promise<void>((accept, reject) => {
    execFile(executable, arguments_, { timeout: 4000, maxBuffer: 65536, killSignal: 'SIGKILL', windowsHide: true,
      shell: false, env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, PATH: process.env.SystemRoot ? `${process.env.SystemRoot}\\System32` : '', LC_ALL: 'C' } : { PATH: '/usr/bin:/bin', LC_ALL: 'C' } },
    error => error ? reject(new Error('OFFLINE_CERTIFICATE_VERIFY_FAILED')) : accept());
  });
}

@Injectable()
export class CertificateTrustService {
  private active = 0;
  /** Test port is a method, not an injectable Boolean "trusted". */
  protected verify: OfflineVerifyPort = verifyWithOpenSsl;

  async evaluate(metadata: InspectedSigningCertificate, expectedRuc: string, now = new Date()): Promise<CertificateTrustResult> {
    const result: CertificateTrustResult = { profile: 'OFFLINE-PINNED-ROOTS-CRL-v1', chainValid: false, identityMatched: false,
      revocation: 'PENDING', trustStoreSha256: null, certificateFingerprint: metadata.fingerprint, checkedAt: now.toISOString(), blockers: [] };
    const block = (code: string) => { if (!result.blockers.includes(code)) result.blockers.push(code); };
    if (this.active >= 2) { block('CERTIFICATE_VERIFIER_BUSY'); return result; }
    if (!/^\d{11}$/.test(expectedRuc) || metadata.subjectRucCandidates.length !== 1 || metadata.subjectRucCandidates[0] !== expectedRuc) block('CERTIFICATE_RUC_NOT_MATCHED');
    else result.identityMatched = true;
    if (metadata.selfSigned) block('SELF_SIGNED_LEAF_NOT_ALLOWED');
    if (!metadata.digitalSignature) block('DIGITAL_SIGNATURE_USAGE_REQUIRED');
    if (metadata.expiresAt <= now) block('CERTIFICATE_EXPIRED');
    if (result.blockers.length) return result;
    this.active++;
    let directory: string | undefined;
    try {
      const trust = await loadPinnedPublicFile(process.env.SUNAT_TRUST_STORE_FILE, process.env.SUNAT_TRUST_STORE_SHA256);
      const roots = pemCertificates(trust.text);
      if (!roots.length || roots.length > 16 || trust.text.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()) throw new Error('TRUST_ROOTS_INVALID');
      for (const pem of roots) {
        const root = new X509Certificate(pem);
        // Trust anchors must be explicit self-signed CA certificates, not an imported leaf.
        if (!root.ca || root.subject !== root.issuer || !root.verify(root.publicKey) || now < new Date(root.validFrom) || now >= new Date(root.validTo)) throw new Error('TRUST_ROOTS_INVALID');
      }
      result.trustStoreSha256 = trust.hash;
      if (metadata.certificatePem.length > MAX_PUBLIC_FILE || metadata.chainPems.length > 16 || metadata.chainPems.some(pem => pem.length > 65536 || pemCertificates(pem).length !== 1)) throw new Error('CERTIFICATE_CHAIN_INVALID');
      // Temporary files contain public certificates/CRLs only, never PFX, password or private key.
      directory = await mkdtemp(join(tmpdir(), 'factuez-trust-'));
      await chmod(directory, 0o700);
      const leafPath = join(directory, 'leaf.pem'), rootPath = join(directory, 'roots.pem'), chainPath = join(directory, 'intermediates.pem');
      await writeFile(leafPath, metadata.certificatePem, { flag: 'wx', mode: 0o600 });
      await writeFile(rootPath, roots.join('\n'), { flag: 'wx', mode: 0o600 });
      const arguments_ = ['verify', '-no-CApath', '-no-CAstore', '-CAfile', rootPath, '-x509_strict', '-auth_level', '2',
        '-verify_depth', '6', '-purpose', 'any', '-attime', String(Math.floor(now.getTime() / 1000))];
      if (metadata.chainPems.length) { await writeFile(chainPath, metadata.chainPems.join('\n'), { flag: 'wx', mode: 0o600 }); arguments_.push('-untrusted', chainPath); }
      await this.verify([...arguments_, leafPath]);
      result.chainValid = true;
      const crlFile = process.env.SUNAT_CRL_BUNDLE_FILE, crlHash = process.env.SUNAT_CRL_BUNDLE_SHA256;
      if (!crlFile && !crlHash) { block('REVOCATION_EVIDENCE_PENDING'); return result; }
      try {
        const crls = await loadPinnedPublicFile(crlFile, crlHash);
        const entries = crls.text.match(/-----BEGIN X509 CRL-----[\s\S]*?-----END X509 CRL-----/g) ?? [];
        if (!entries.length || entries.length > 16 || crls.text.replace(/-----BEGIN X509 CRL-----[\s\S]*?-----END X509 CRL-----/g, '').trim()) throw new Error('CRL_BUNDLE_INVALID');
        const crlPath = join(directory, 'revocation.pem');
        await writeFile(crlPath, crls.text, { flag: 'wx', mode: 0o600 });
        // OpenSSL verifies CRL signatures, issuer, thisUpdate/nextUpdate and revocation for every chain link.
        await this.verify([...arguments_, '-CRLfile', crlPath, '-crl_check_all', leafPath]);
        result.revocation = 'VERIFIED_OFFLINE_CRL';
      } catch { result.revocation = 'INVALID'; block('REVOCATION_EVIDENCE_INVALID'); }
      return result;
    } catch {
      block('TRUST_STORE_OR_CHAIN_NOT_VERIFIED'); return result;
    } finally {
      this.active--;
      if (directory && resolve(directory).startsWith(`${resolve(tmpdir())}${process.platform === 'win32' ? '\\' : '/'}factuez-trust-`))
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
