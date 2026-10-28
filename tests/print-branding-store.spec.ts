import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PRINT_BRANDING } from '../packages/contracts/src/print-presentation';
import { normalizePrintLogo, validatePrintDraft, validatePrintSettings, MAX_FROZEN_LOGO_BYTES } from '../services/billing-service/src/application/print-branding-validation';
import { PrintBrandingStore } from '../services/billing-service/src/infrastructure/print-branding-store';

const billingRequire = createRequire(new URL('../services/billing-service/package.json', import.meta.url));
const sharp = billingRequire('sharp') as typeof import('../apps/web-pwa/node_modules/sharp');
const actor = '10000000-0000-4000-8000-000000000001';
const siteId = '20000000-0000-4000-8000-000000000001';
const otherSiteId = '20000000-0000-4000-8000-000000000002';
const issuer = { companyId: 1, issuerRuc: '00000000001', branchId: null };
const site = { ...issuer, branchId: siteId, branchName: 'SEDE FICTICIA QA', branchAddress: 'DIRECCIÓN FICTICIA QA' };
const custom = { ...DEFAULT_PRINT_BRANDING, logoMode: 'CUSTOM' as const, logoWidthMm: 45 };
async function image(format = 'png', width = 40, height = 20) {
  const bytes = await sharp({ create: { width, height, channels: 4, background: { r: 201, g: 30, b: 45, alpha: 1 } } })
    .toFormat(format as 'png' | 'jpeg' | 'webp').toBuffer();
  return { mediaType: `image/${format}` as 'image/png' | 'image/jpeg' | 'image/webp', base64: bytes.toString('base64') };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'factuez-print-branding-synthetic-'));
  const store = new PrintBrandingStore(root); await store.initialize();
  return { root, store };
}
afterEach(() => { vi.unstubAllEnvs(); });

describe('validación y normalización segura de logos', () => {
  it.each(['png', 'jpeg', 'webp'])('normaliza %s a PNG sin metadata y con SHA verificado', async format => {
    const upload = await image(format), normalized = await normalizePrintLogo(upload);
    const bytes = Buffer.from(normalized.base64, 'base64'), metadata = await sharp(bytes).metadata();
    expect(normalized.mediaType).toBe('image/png'); expect(normalized.width).toBe(40); expect(normalized.height).toBe(20);
    expect(bytes.length).toBeLessThanOrEqual(MAX_FROZEN_LOGO_BYTES);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(normalized.sha256);
    expect(metadata.exif).toBeUndefined(); expect(metadata.xmp).toBeUndefined(); expect(metadata.icc).toBeUndefined();
  });
  it('reduce dimensiones sin deformar el logo', async () => {
    const output = await normalizePrintLogo(await image('png', 2000, 1000));
    expect(output.width).toBe(1024); expect(output.height).toBe(512);
  });
  it('rechaza dimensiones y contenido excesivos', async () => {
    await expect(normalizePrintLogo(await image('png', 4097, 8))).rejects.toMatchObject({ status: 400 });
    await expect(normalizePrintLogo({ mediaType: 'image/png', base64: Buffer.alloc(256 * 1024 + 1).toString('base64') })).rejects.toMatchObject({ status: 400 });
  });
  it.each([
    { mediaType: 'image/svg+xml', base64: Buffer.from('<svg/>').toString('base64') },
    { mediaType: 'image/png', base64: 'https://attacker.invalid/logo.png' },
    { mediaType: 'image/png', base64: Buffer.from('<svg/>').toString('base64') },
    { mediaType: 'image/png', base64: 'AAAA\n' },
    { mediaType: 'image/png', base64: '' },
    { mediaType: 'image/png', base64: 'AAAA', fileName: '../../key.pem' },
    { mediaType: 'image/png', base64: 'data:image/png;base64,AAAA' },
  ])('no admite SVG, enlaces, rutas ni base64 ambiguo: %j', async value => {
    await expect(normalizePrintLogo(value)).rejects.toMatchObject({ status: 400 });
  });
  it('no confía sólo en el MIME ni en la cabecera', async () => {
    const png = await image();
    await expect(normalizePrintLogo({ ...png, mediaType: 'image/jpeg' })).rejects.toMatchObject({ status: 400 });
    await expect(normalizePrintLogo({ mediaType: 'image/png', base64: Buffer.from([137,80,78,71,13,10,26,10]).toString('base64') })).rejects.toMatchObject({ status: 400 });
  });
  it.each([
    { ...DEFAULT_PRINT_BRANDING, logoWidthMm: 19 }, { ...DEFAULT_PRINT_BRANDING, logoWidthMm: 61 },
    { ...DEFAULT_PRINT_BRANDING, logoWidthMm: 40.5 }, { ...DEFAULT_PRINT_BRANDING, logoMode: ['DEFAULT'] },
    { ...DEFAULT_PRINT_BRANDING, footerNote: '<script>alert(1)</script>' },
    { ...DEFAULT_PRINT_BRANDING, footerNote: 'hola\nBCC' }, { ...DEFAULT_PRINT_BRANDING, footerNote: 'x'.repeat(161) },
    { ...DEFAULT_PRINT_BRANDING, fiscalTransmission: true }, { ...DEFAULT_PRINT_BRANDING, showBranchAddress: 'true' },
    { ...DEFAULT_PRINT_BRANDING, template: 'https://attacker.invalid' },
  ])('rechaza opciones que ocultan información o inyectan contenido: %j', value => {
    expect(() => validatePrintSettings(value)).toThrow();
  });
  it('el restablecimiento no acepta un archivo ni parámetros fiscales', () => {
    expect(validatePrintDraft({ settings: null })).toEqual({ settings: null });
    expect(() => validatePrintDraft({ settings: null, logoUpload: { mediaType: 'image/png', base64: 'AAAA' } })).toThrow();
    expect(() => validatePrintDraft({ settings: DEFAULT_PRINT_BRANDING, issuerRuc: '99999999999' })).toThrow();
  });
});

describe('perfiles persistentes aislados por RUC y sede', () => {
  it('usa predeterminados sin crear un perfil ni consumir una serie', async () => {
    const { root, store } = await fixture();
    expect(await store.response(site)).toMatchObject({ revision: 0, source: 'DEFAULT', override: null, fiscalTransmission: false });
    expect(await readdir(join(root, 'profiles'))).toEqual([]); expect(await readdir(join(root, 'versions'))).toEqual([]);
  });
  it('hereda el logo del RUC y conserva un snapshot completo', async () => {
    const { root, store } = await fixture(), upload = await image();
    await store.save(issuer, { settings: custom, logoUpload: upload }, 0, actor);
    const frozen = await store.freeze(site), response = await store.response(site);
    expect(response).toMatchObject({ revision: 0, source: 'ISSUER', override: null });
    expect(response.logoPreviewDataUrl).toBe(`data:image/png;base64,${frozen.logo!.base64}`);
    expect(frozen).toMatchObject({ issuerRuc: issuer.issuerRuc, branchId: siteId, profileRevision: 1, branchName: site.branchName });
    expect(await new PrintBrandingStore(root).freeze(site)).toEqual(frozen);
  });
  it('el logo por sede no afecta otras sedes ni otro RUC', async () => {
    const { store } = await fixture(); await store.save(issuer, { settings: custom, logoUpload: await image() }, 0, actor);
    await store.save(site, { settings: { ...DEFAULT_PRINT_BRANDING, logoMode: 'NONE' } }, 0, actor);
    expect(await store.response(site)).toMatchObject({ source: 'BRANCH', effective: { logoMode: 'NONE' } });
    expect(await store.response({ ...issuer, branchId: otherSiteId })).toMatchObject({ source: 'ISSUER', effective: { logoMode: 'CUSTOM' } });
    expect(await store.response({ companyId: 2, issuerRuc: '00000000002', branchId: null })).toMatchObject({ source: 'DEFAULT', logoPreviewDataUrl: null });
  });
  it('volver a heredar conserva el logo y las revisiones anteriores', async () => {
    const { root, store } = await fixture(); await store.save(issuer, { settings: custom, logoUpload: await image() }, 0, actor);
    await store.save(site, { settings: { ...DEFAULT_PRINT_BRANDING, logoMode: 'NONE' } }, 0, actor);
    const reset = await store.save(site, { settings: null }, 1, actor);
    expect(reset).toMatchObject({ revision: 2, source: 'ISSUER', override: null });
    expect(await readdir(join(root, 'logos'))).toHaveLength(1); expect(await readdir(join(root, 'versions'))).toHaveLength(3);
  });
  it('rechaza una revisión obsoleta sin modificar el guardado actual', async () => {
    const { root, store } = await fixture(); await store.save(issuer, { settings: DEFAULT_PRINT_BRANDING }, 0, actor);
    await expect(store.save(issuer, { settings: custom, logoUpload: await image() }, 0, actor)).rejects.toMatchObject({ status: 409 });
    expect((await store.response(issuer)).revision).toBe(1); expect(await readdir(join(root, 'versions'))).toHaveLength(1);
    expect(await readdir(join(root, 'logos'))).toHaveLength(0); expect(await readdir(join(root, 'locks'))).toHaveLength(0);
  });
  it('serializa guardados concurrentes sin sobrescribir otro administrador', async () => {
    const { store } = await fixture();
    const results = await Promise.allSettled([
      store.save(issuer, { settings: { ...DEFAULT_PRINT_BRANDING, footerNote: 'QA UNO' } }, 0, actor),
      store.save(issuer, { settings: { ...DEFAULT_PRINT_BRANDING, footerNote: 'QA DOS' } }, 0, actor),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await store.response(issuer)).revision).toBe(1);
  });
  it('la vista previa de un borrador no guarda perfiles ni logos', async () => {
    const { root, store } = await fixture(); const preview = await store.freeze(site, { settings: custom, logoUpload: await image() });
    expect(preview.logo).not.toBeNull(); expect(await readdir(join(root, 'profiles'))).toEqual([]);
    expect(await readdir(join(root, 'logos'))).toEqual([]); expect(await readdir(join(root, 'versions'))).toEqual([]);
  });
  it('el logo de un snapshot no cambia al modificar el perfil', async () => {
    const { store } = await fixture(); await store.save(issuer, { settings: custom, logoUpload: await image() }, 0, actor);
    const frozen = await store.freeze(site), prior = JSON.stringify(frozen);
    await store.save(issuer, { settings: { ...DEFAULT_PRINT_BRANDING, logoMode: 'NONE' } }, 1, actor);
    expect(JSON.stringify(frozen)).toBe(prior); expect((await store.freeze(site)).logo).toBeNull();
  });
  it('conserva un logo al editar su tamaño sin volver a subirlo', async () => {
    const { store } = await fixture(); await store.save(issuer, { settings: custom, logoUpload: await image() }, 0, actor);
    const old = await store.freeze(issuer); await store.save(issuer, { settings: { ...custom, logoWidthMm: 30 } }, 1, actor);
    const next = await store.freeze(issuer); expect(next.logo!.sha256).toBe(old.logo!.sha256); expect(next.settings.logoWidthMm).toBe(30);
  });
  it('requiere un archivo para el primer logo personalizado', async () => {
    const { store } = await fixture(); await expect(store.save(issuer, { settings: custom }, 0, actor)).rejects.toMatchObject({ status: 409 });
  });
  it('no lee un perfil alterado que pertenezca a otro RUC', async () => {
    const { root, store } = await fixture(); await store.save(issuer, { settings: DEFAULT_PRINT_BRANDING }, 0, actor);
    const path = join(root, 'profiles', `${issuer.issuerRuc}-issuer.json`), profile = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...profile, issuerRuc: '99999999999' }));
    await expect(store.freeze(issuer)).rejects.toMatchObject({ status: 503 });
  });
  it('no sustituye silenciosamente un logo con hash inconsistente', async () => {
    const { root, store } = await fixture(); await store.save(issuer, { settings: custom, logoUpload: await image() }, 0, actor);
    const snapshot = await store.freeze(issuer); await writeFile(join(root, 'logos', `${snapshot.logo!.sha256}.png`), 'FICTICIO-TAMPER');
    await expect(store.freeze(issuer)).rejects.toMatchObject({ status: 503 });
  });
  it('rechaza traversal y raíces relativas o demasiado amplias', async () => {
    expect(new PrintBrandingStore('relative')).toBeDefined();
    await expect(new PrintBrandingStore('relative').initialize()).rejects.toMatchObject({ status: 503 });
    const { store } = await fixture(); await expect(store.freeze({ ...issuer, branchId: '../../secrets' })).rejects.toMatchObject({ status: 503 });
    await expect(store.freeze({ ...issuer, issuerRuc: '../../.env' })).rejects.toMatchObject({ status: 503 });
  });
  it('rechaza un volumen raíz que sea un enlace', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'factuez-print-link-synthetic-'));
    const outside = await fixture(); const link = join(parent, 'linked'); await symlink(outside.root, link, 'junction');
    await expect(new PrintBrandingStore(link).initialize()).rejects.toMatchObject({ status: 503 });
  });
});
