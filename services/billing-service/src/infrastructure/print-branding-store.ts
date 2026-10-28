import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, parse, resolve } from 'node:path';
import {
  DEFAULT_PRINT_BRANDING, PRINT_PRESENTATION_VERSION, PRINT_SETTINGS_VERSION,
  type FrozenPrintPresentationV1, type PrintBrandingDraft, type PrintBrandingSettings,
  type PrintLogoSnapshot, type PrintSettingsResponseV1,
} from '@factuez/contracts';
import { MAX_FROZEN_LOGO_BYTES, normalizePrintLogo, validatePrintDraft, validatePrintSettings } from '../application/print-branding-validation';

type Target = { companyId: number; issuerRuc: string; branchId: string | null; branchName?: string; branchAddress?: string };
type LogoReference = Omit<PrintLogoSnapshot, 'base64'>;
type Profile = {
  version: typeof PRINT_SETTINGS_VERSION; issuerRuc: string; branchId: string | null; revision: number;
  updatedAt: string; settings: PrintBrandingSettings | null; logo: LogoReference | null;
  actorId: string; action: 'SAVED' | 'INHERITED';
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = () => new ServiceUnavailableException('Almacenamiento de logos no disponible o inconsistente. Revise el volumen privado de impresión.');

/** Volumen de Billing, aislado de SUNAT/historial. Nunca emite ni escribe Outbox/BD. */
export class PrintBrandingStore {
  constructor(private readonly configuredRoot?: string) {}
  private root(): string | undefined {
    const configured = this.configuredRoot ?? process.env.PRINT_BRANDING_ROOT;
    if (!configured) return undefined;
    if (!isAbsolute(configured) || resolve(configured) === parse(resolve(configured)).root) throw unavailable();
    return resolve(configured);
  }
  async initialize() {
    const root = this.root(); if (!root) throw unavailable();
    for (const directory of [root, join(root, 'profiles'), join(root, 'logos'), join(root, 'locks'), join(root, 'versions')]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(await realpath(directory)).toLowerCase() !== resolve(directory).toLowerCase())
        throw unavailable();
      await access(directory, constants.R_OK | constants.W_OK);
    }
  }
  private async directory(name: 'profiles' | 'logos' | 'locks' | 'versions') {
    const root = this.root(); if (!root) throw unavailable();
    const target = join(root, name);
    try {
      const rootStat = await lstat(root), stat = await lstat(target);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || stat.isSymbolicLink() || !stat.isDirectory() ||
          resolve(await realpath(target)).toLowerCase() !== resolve(target).toLowerCase()) throw unavailable();
    } catch { throw unavailable(); }
    return target;
  }
  private key(target: Target) {
    if (!/^\d{11}$/.test(target.issuerRuc) || !Number.isSafeInteger(target.companyId) || target.companyId < 1 ||
        (target.branchId !== null && !UUID.test(target.branchId))) throw unavailable();
    return `${target.issuerRuc}-${target.branchId?.toLowerCase() ?? 'issuer'}`;
  }
  private async bytes(path: string, maximum: number) {
    let handle;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw unavailable();
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const current = await handle.stat();
      if (!current.isFile() || current.size < 1 || current.size > maximum) throw unavailable();
      const bytes = await handle.readFile();
      if (bytes.length !== current.size || bytes.length > maximum) throw unavailable();
      return bytes;
    } finally { await handle?.close(); }
  }
  private async profile(target: Target): Promise<Profile | null> {
    const path = join(await this.directory('profiles'), `${this.key(target)}.json`);
    let bytes: Buffer;
    try { bytes = await this.bytes(path, 8192); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw unavailable(); }
    try {
      const value = JSON.parse(bytes.toString('utf8')) as Profile;
      if (value.version !== PRINT_SETTINGS_VERSION || value.issuerRuc !== target.issuerRuc || value.branchId !== target.branchId ||
          !Number.isSafeInteger(value.revision) || value.revision < 1 || !UUID.test(value.actorId) ||
          !['SAVED', 'INHERITED'].includes(value.action) || !Number.isFinite(Date.parse(value.updatedAt))) throw unavailable();
      if (value.settings !== null) validatePrintSettings(value.settings);
      if (value.settings?.logoMode === 'CUSTOM') {
        if (!value.logo || value.logo.mediaType !== 'image/png' || !/^[a-f0-9]{64}$/.test(value.logo.sha256) ||
            !Number.isInteger(value.logo.width) || !Number.isInteger(value.logo.height) || value.logo.width < 1 || value.logo.width > 1024 || value.logo.height < 1 || value.logo.height > 512)
          throw unavailable();
      } else if (value.logo !== null) throw unavailable();
      return value;
    } catch { throw unavailable(); }
  }
  private async logo(reference: LogoReference): Promise<PrintLogoSnapshot> {
    const bytes = await this.bytes(join(await this.directory('logos'), `${reference.sha256}.png`), MAX_FROZEN_LOGO_BYTES).catch(() => { throw unavailable(); });
    if (createHash('sha256').update(bytes).digest('hex') !== reference.sha256 || bytes.length < 24 ||
        !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
        bytes.readUInt32BE(16) !== reference.width || bytes.readUInt32BE(20) !== reference.height) throw unavailable();
    return { ...reference, base64: bytes.toString('base64') };
  }
  private async context(target: Target) {
    const targetProfile = await this.profile(target);
    const issuerProfile = target.branchId ? await this.profile({ ...target, branchId: null }) : targetProfile;
    const selected = targetProfile?.settings ? targetProfile : issuerProfile?.settings ? issuerProfile : null;
    const settings = selected?.settings ?? { ...DEFAULT_PRINT_BRANDING };
    const logo = selected?.logo ? await this.logo(selected.logo) : null;
    return { targetProfile, issuerProfile, selected, settings, logo };
  }
  async response(target: Target): Promise<PrintSettingsResponseV1> {
    const context = await this.context(target);
    return {
      version: PRINT_SETTINGS_VERSION, companyId: target.companyId, ruc: target.issuerRuc, branchId: target.branchId,
      revision: context.targetProfile?.revision ?? 0, updatedAt: context.targetProfile?.updatedAt ?? null,
      override: context.targetProfile?.settings ?? null, effective: { ...context.settings },
      source: context.selected ? context.selected.branchId ? 'BRANCH' : 'ISSUER' : 'DEFAULT',
      logoPreviewDataUrl: context.logo ? `data:image/png;base64,${context.logo.base64}` : null,
      storageReady: true, fiscalTransmission: false,
    };
  }
  async freeze(target: Target, draft?: PrintBrandingDraft): Promise<FrozenPrintPresentationV1> {
    const context = await this.context(target);
    let settings = context.settings, logo = context.logo, revision = context.selected?.revision ?? 0;
    if (draft !== undefined) {
      const valid = validatePrintDraft(draft);
      if (valid.settings === null) {
        const ancestor = target.branchId && context.issuerProfile?.settings ? context.issuerProfile : null;
        settings = ancestor?.settings ?? { ...DEFAULT_PRINT_BRANDING };
        logo = ancestor?.logo ? await this.logo(ancestor.logo) : null;
        revision = ancestor?.revision ?? 0;
      } else {
        settings = valid.settings;
        logo = valid.logoUpload ? await normalizePrintLogo(valid.logoUpload) : settings.logoMode === 'CUSTOM' ? context.logo : null;
        if (settings.logoMode === 'CUSTOM' && !logo) throw new ConflictException('Seleccione un logo personalizado antes de guardar o previsualizar.');
      }
    }
    return {
      version: PRINT_PRESENTATION_VERSION, issuerRuc: target.issuerRuc, branchId: target.branchId,
      profileRevision: revision, settings: { ...settings }, logo,
      ...(target.branchName ? { branchName: target.branchName } : {}),
      ...(target.branchAddress ? { branchAddress: target.branchAddress } : {}),
    };
  }
  private async writeNew(path: string, bytes: Buffer) {
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  }
  async save(target: Target, draft: PrintBrandingDraft, expectedRevision: number, actorId: string) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= 1_000_000_000 || !UUID.test(actorId))
      throw new ConflictException('Revisión o responsable de configuración inválidos.');
    const lockPath = join(await this.directory('locks'), `${this.key(target)}.lock`);
    try { await mkdir(lockPath, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ConflictException('Hay otro guardado en curso. Recargue y reintente.'); throw unavailable(); }
    try {
      const previous = await this.profile(target);
      if ((previous?.revision ?? 0) !== expectedRevision) throw new ConflictException('La configuración cambió. Recargue antes de guardar para no sobrescribir otro cambio.');
      const valid = validatePrintDraft(draft), presentation = await this.freeze(target, valid);
      const logo = valid.settings?.logoMode === 'CUSTOM' ? presentation.logo : null;
      if (logo) {
        const logoPath = join(await this.directory('logos'), `${logo.sha256}.png`);
        try { await this.writeNew(logoPath, Buffer.from(logo.base64, 'base64')); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable();
          await this.logo(logo);
        }
      }
      const profile: Profile = {
        version: PRINT_SETTINGS_VERSION, issuerRuc: target.issuerRuc, branchId: target.branchId,
        revision: expectedRevision + 1, updatedAt: new Date().toISOString(), actorId,
        action: valid.settings === null ? 'INHERITED' : 'SAVED', settings: valid.settings,
        logo: logo ? { mediaType: logo.mediaType, sha256: logo.sha256, width: logo.width, height: logo.height } : null,
      };
      const bytes = Buffer.from(JSON.stringify(profile)), unique = randomUUID();
      // Versión inmutable antes de cambiar el puntero. No borra revisiones/logos anteriores.
      await this.writeNew(join(await this.directory('versions'), `${this.key(target)}-r${profile.revision}-${unique}.json`), bytes);
      const profiles = await this.directory('profiles'), temporary = join(profiles, `${this.key(target)}-${unique}.tmp`);
      try { await this.writeNew(temporary, bytes); await rename(temporary, join(profiles, `${this.key(target)}.json`)); }
      finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw unavailable(); }); }
      return await this.response(target);
    } finally { await rmdir(lockPath); }
  }
}
