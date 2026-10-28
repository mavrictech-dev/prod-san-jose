import { Inject, Injectable, Optional } from '@nestjs/common';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { randomUUID, X509Certificate } from 'node:crypto';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import forge from 'node-forge';
import { SUNAT_ARTIFACTS_ROOT } from '../artifact-store';
import type { BetaIssuerPublicCertificates } from './beta-owner-xml-trust';
import type { InspectedSigningCertificate } from './certificate-trust.service';
import { certificateRucCandidates } from './certificate-identity';

const MAX_PEM = 65536, MAX_CHAIN = 17 * MAX_PEM;
const fingerprintOf = (cert: X509Certificate) => cert.fingerprint256.replaceAll(':', '').toLowerCase();
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameFile = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) => a.dev === b.dev && a.ino === b.ino;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
function fail(code: string): never { throw new Error(code); }
function identity(ruc: string, fingerprint: string) {
  if (typeof ruc !== 'string' || !/^\d{11}$/.test(ruc) || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint))
    fail('PUBLIC_SIGNER_IDENTITY_INVALID');
}
function certificate(value: string): X509Certificate {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_PEM || value.includes('\0') ||
      !/^\s*-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(value))
    fail('PUBLIC_SIGNER_PUBLIC_PEM_REQUIRED');
  return new X509Certificate(value);
}
function publicChain(ruc: string, fingerprint: string, leafPem: string, chainPems: string[]) {
  identity(ruc, fingerprint);
  if (!Array.isArray(chainPems) || chainPems.length > 16) fail('PUBLIC_SIGNER_CHAIN_INVALID');
  const leaf = certificate(leafPem), chain = chainPems.map(certificate);
  const publicLeaf = forge.pki.certificateFromPem(leaf.toString());
  const candidates = certificateRucCandidates(publicLeaf.subject.attributes);
  if (leaf.ca || fingerprintOf(leaf) !== fingerprint || candidates.length !== 1 || candidates[0] !== ruc)
    fail('PUBLIC_SIGNER_IDENTITY_MISMATCH');
  const fingerprints = [fingerprint, ...chain.map(fingerprintOf)];
  if (new Set(fingerprints).size !== fingerprints.length || chain.some(c => !c.ca)) fail('PUBLIC_SIGNER_CHAIN_INVALID');
  // P12 certificate-bag order is immaterial. Different public certificates ARE a conflict.
  chain.sort((a, b) => fingerprintOf(a).localeCompare(fingerprintOf(b), 'en'));
  const result = { certificatePem: leaf.toString(), chainPems: chain.map(c => c.toString()) };
  const bytes = Buffer.from([result.certificatePem, ...result.chainPems].join(''));
  if (!bytes.length || bytes.length > MAX_CHAIN) fail('PUBLIC_SIGNER_CHAIN_INVALID');
  return { ...result, bytes };
}

/** Private owner-side PUBLIC archive, never an HTTP upload or a trust store.
 * Only Production prepare writes after inspection, current PKI/CRL and exact XML verification.
 * load preserves expired public material but grants NO historical validity or acceptance.
 * A different chain for an existing leaf is a hard conflict: never overwrite or update history.
 * Supporting such a rotation requires a versioned, integrity-bound historical chain model first.
 * ARTIFACTS_ROOT must be service-owned (Windows ACLs / private POSIX directories); no untrusted
 * writers may rename its ancestors. Node has no portable dirfd/openat; checks bracket every IO.
 */
@Injectable()
export class PublicSignerArchive implements BetaIssuerPublicCertificates {
  private readonly root: string;
  constructor(@Optional() @Inject(SUNAT_ARTIFACTS_ROOT) artifactsRoot?: string) {
    const configured = artifactsRoot ?? process.env.ARTIFACTS_ROOT ?? '/data/artifacts';
    if (typeof configured !== 'string' || !isAbsolute(configured) || configured.includes('\0') || configured.length > 4096 ||
        resolve(configured) === dirname(resolve(configured))) fail('PUBLIC_SIGNER_ROOT_REQUIRED');
    this.root = join(resolve(configured), 'public-signers-v1');
  }

  /** Check every existing ancestor, including a symlink/junction at ARTIFACTS_ROOT itself. */
  private async directory(path: string, create: boolean) {
    const base = parse(path).root;
    let current = base;
    const entries: Array<{ path: string; dev: number; ino: number }> = [];
    for (const part of relative(base, path).split(sep).filter(Boolean)) {
      current = join(current, part);
      try { await lstat(current); }
      catch (error) {
        if (!create || !missing(error)) throw error;
        try { await mkdir(current, { mode: 0o700 }); }
        catch (race) { if ((race as NodeJS.ErrnoException).code !== 'EEXIST') throw race; }
      }
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(current), current)) fail('PUBLIC_SIGNER_UNSAFE_DIRECTORY');
      const insideArchive = samePath(current, this.root) || relative(this.root, current).split(sep)[0] !== '..' &&
        !isAbsolute(relative(this.root, current)) && !!relative(this.root, current);
      if (insideArchive && process.platform !== 'win32' && (info.mode & 0o077) !== 0) fail('PUBLIC_SIGNER_DIRECTORY_NOT_PRIVATE');
      entries.push({ path: current, dev: info.dev, ino: info.ino });
    }
    return entries;
  }
  private async unchanged(entries: Array<{ path: string; dev: number; ino: number }>) {
    for (const entry of entries) {
      const info = await lstat(entry.path);
      if (!info.isDirectory() || info.isSymbolicLink() || !sameFile(entry, info) || !samePath(await realpath(entry.path), entry.path))
        fail('PUBLIC_SIGNER_DIRECTORY_CHANGED');
    }
  }
  private path(ruc: string, fingerprint: string) {
    identity(ruc, fingerprint);
    return join(this.root, ruc, `${fingerprint}.pem`);
  }
  private async read(ruc: string, fingerprint: string) {
    const path = this.path(ruc, fingerprint), directories = await this.directory(dirname(path), false);
    const before = await lstat(path);
    if (before.isFile() && before.nlink !== 1) fail('PUBLIC_SIGNER_FILE_NOT_SINGLE_LINK');
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > MAX_CHAIN ||
        !samePath(await realpath(path), path)) fail('PUBLIC_SIGNER_UNSAFE_FILE');
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || !sameFile(before, stat) || stat.size !== before.size) fail('PUBLIC_SIGNER_FILE_CHANGED');
      const bytes = Buffer.alloc(stat.size + 1), result = await handle.read(bytes, 0, bytes.length, 0);
      const after = await handle.stat(), named = await lstat(path);
      await this.unchanged(directories);
      if (result.bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.nlink !== 1 ||
          !sameFile(after, named) || named.isSymbolicLink() || !samePath(await realpath(path), path)) fail('PUBLIC_SIGNER_FILE_CHANGED');
      const content = bytes.subarray(0, result.bytesRead), text = new TextDecoder('utf-8', { fatal: true }).decode(content);
      const pems = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
      const leafPem = pems[0];
      if (!leafPem || pems.length > 17 || text.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim())
        fail('PUBLIC_SIGNER_PUBLIC_PEM_REQUIRED');
      const parsed = publicChain(ruc, fingerprint, leafPem, pems.slice(1));
      if (!parsed.bytes.equals(content)) fail('PUBLIC_SIGNER_ARCHIVE_CONTENT_CHANGED');
      return parsed;
    } finally { await handle.close(); }
  }

  /** Whitelist public fields only. Never serialize metadata wholesale: no P12/password/private key. */
  async archive(ruc: string, metadata: Pick<InspectedSigningCertificate, 'fingerprint' | 'certificatePem' | 'chainPems'>): Promise<void> {
    const material = publicChain(ruc, metadata.fingerprint, metadata.certificatePem, metadata.chainPems);
    const path = this.path(ruc, metadata.fingerprint);
    const directories = await this.directory(dirname(path), true);
    const identical = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const previous = await this.read(ruc, metadata.fingerprint);
          if (!previous.bytes.equals(material.bytes)) fail('PUBLIC_SIGNER_CHAIN_CONFLICT_REQUIRES_VERSIONED_HISTORY');
          return;
        } catch (error) {
          // A concurrent atomic publisher briefly owns the temp and final hard links. Never weaken load().
          if (!(error instanceof Error) || error.message !== 'PUBLIC_SIGNER_FILE_NOT_SINGLE_LINK' || attempt >= 8) throw error;
          await new Promise(accept => setTimeout(accept, 5));
        }
      }
    };
    try { await identical(); return; }
    catch (error) { if (!missing(error)) throw error; }
    const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    let temporaryIdentity: { dev: number; ino: number } | undefined;
    try {
      try {
        temporaryIdentity = await handle.stat();
        await this.unchanged(directories);
        await handle.writeFile(material.bytes); await handle.sync();
      } finally { await handle.close(); }
      await this.unchanged(directories);
      const temp = await lstat(temporary);
      if (temp.isSymbolicLink() || !temp.isFile() || temp.nlink !== 1 || !sameFile(temporaryIdentity!, temp)) fail('PUBLIC_SIGNER_FILE_CHANGED');
      try {
        // Atomic NO-REPLACE publication. rename() could replace a historical record on POSIX.
        await link(temporary, path);
        await unlink(temporary); temporaryIdentity = undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await identical();
      }
    } finally {
      await this.unchanged(directories);
      if (temporaryIdentity) {
        const temp = await lstat(temporary).catch(error => { if (!missing(error)) throw error; return undefined; });
        if (temp && !temp.isSymbolicLink() && sameFile(temporaryIdentity, temp)) await unlink(temporary);
      }
    }
    await identical();
  }

  async load(ruc: string, fingerprint: string): Promise<{ certificatePem: string; chainPems: string[] }> {
    const value = await this.read(ruc, fingerprint);
    return { certificatePem: value.certificatePem, chainPems: [...value.chainPems] };
  }
}
