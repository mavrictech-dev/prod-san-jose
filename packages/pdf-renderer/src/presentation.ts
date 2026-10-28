import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import type { FrozenPrintPresentationV1, PrintBrandingSettings, PrintLogoSnapshot } from '@factuez/contracts';
import { clean } from './types';

// Límites de presentación local; el renderer sólo consume el PNG congelado.
const MAX_PNG_BYTES = 128 * 1024;
const DEFAULT_SETTINGS: Readonly<PrintBrandingSettings> = {
  template: 'SAN_JOSE_V1', logoMode: 'DEFAULT', logoWidthMm: 40,
  logoAlignment: 'LEFT', showBranchAddress: true, footerNote: '',
};
export interface ResolvedPresentation {
  settings: Readonly<PrintBrandingSettings>;
  logo?: Buffer;
  logoWidth?: number;
  logoHeight?: number;
  branchName?: string;
  branchAddress?: string;
}

function record(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !keys.includes(key)))
    throw new Error('Presentación de impresión inválida; no se admiten URLs ni rutas externas');
}

function optionalText(value: unknown, limit: number): asserts value is string | undefined {
  if (value !== undefined && (typeof value !== 'string' || value.length > limit))
    throw new Error('Texto de presentación inválido');
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function frozenPng(logo: PrintLogoSnapshot): Buffer {
  record(logo, ['mediaType', 'base64', 'sha256', 'width', 'height']);
  if (logo.mediaType !== 'image/png' || typeof logo.base64 !== 'string' ||
    logo.base64.length > 4 * Math.ceil(MAX_PNG_BYTES / 3) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(logo.base64) ||
    typeof logo.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(logo.sha256) ||
    !Number.isInteger(logo.width) || !Number.isInteger(logo.height) ||
    logo.width < 1 || logo.height < 1 || logo.width > 1024 || logo.height > 512)
    throw new Error('Logo PNG congelado inválido');
  const bytes = Buffer.from(logo.base64, 'base64');
  if (bytes.length < 57 || bytes.length > MAX_PNG_BYTES || bytes.toString('base64') !== logo.base64 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    createHash('sha256').update(bytes).digest('hex') !== logo.sha256)
    throw new Error('Bytes o SHA256 del logo PNG inválidos');
  const imageData: Buffer[] = [];
  let depth = 0, color = -1, palette = false, ended = false;
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error('PNG truncado');
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > bytes.length) throw new Error('PNG truncado');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) ||
      crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4))
      throw new Error('CRC del logo PNG inválido');
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13 || bytes.readUInt32BE(offset + 8) !== logo.width ||
        bytes.readUInt32BE(offset + 12) !== logo.height) throw new Error('Dimensiones del logo PNG inválidas');
      depth = bytes[offset + 16]; color = bytes[offset + 17];
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 || bytes[offset + 20] !== 0)
        throw new Error('PNG normalizado no admitido');
    } else if (type === 'IHDR' || ['acTL', 'fcTL', 'fdAT'].includes(type)) {
      throw new Error('PNG animado o cabecera duplicada no admitidos');
    }
    if (type === 'PLTE') palette = length >= 3 && length <= 768 && length % 3 === 0;
    if (type === 'IDAT') imageData.push(bytes.subarray(offset + 8, end - 4));
    if (type === 'IEND') {
      if (length !== 0 || end !== bytes.length) throw new Error('Final del PNG inválido');
      ended = true;
    }
    offset = end;
  }
  if (!ended || !imageData.length || color === 3 && !palette) throw new Error('PNG incompleto');
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const stride = Math.ceil(logo.width * channels[color] * depth / 8) + 1;
  const expected = stride * logo.height;
  let pixels: Buffer;
  try { pixels = inflateSync(Buffer.concat(imageData), { maxOutputLength: expected }); }
  catch { throw new Error('Datos comprimidos del PNG inválidos'); }
  if (pixels.length !== expected) throw new Error('Datos de imagen PNG inválidos');
  for (let row = 0; row < logo.height; row++)
    if (pixels[row * stride] > 4) throw new Error('Filtro de imagen PNG inválido');
  return bytes;
}

export function resolvePresentation(
  value: FrozenPrintPresentationV1 | undefined,
  issuerRuc: string,
  branchId: string | undefined,
): ResolvedPresentation {
  if (value === undefined) return { settings: DEFAULT_SETTINGS };
  record(value, ['version', 'issuerRuc', 'branchId', 'profileRevision', 'settings', 'logo', 'branchName', 'branchAddress']);
  if (value.version !== 'factuez.print-presentation.v1' || value.issuerRuc !== issuerRuc ||
    !/^\d{11}$/.test(value.issuerRuc) || value.branchId !== (branchId ?? null) ||
    (value.branchId !== null && (typeof value.branchId !== 'string' || !value.branchId.trim())) ||
    !Number.isSafeInteger(value.profileRevision) || value.profileRevision < 0)
    throw new Error('Versión, RUC o sede de la presentación inválidos');
  record(value.settings, ['template', 'logoMode', 'logoWidthMm', 'logoAlignment', 'showBranchAddress', 'footerNote']);
  const settings = value.settings;
  if (settings.template !== 'SAN_JOSE_V1' || !['DEFAULT', 'CUSTOM', 'NONE'].includes(settings.logoMode) ||
    typeof settings.logoWidthMm !== 'number' || !Number.isFinite(settings.logoWidthMm) ||
    settings.logoWidthMm < 20 || settings.logoWidthMm > 60 ||
    !['LEFT', 'CENTER'].includes(settings.logoAlignment) || typeof settings.showBranchAddress !== 'boolean' ||
    typeof settings.footerNote !== 'string' || settings.footerNote.length > 160)
    throw new Error('Settings de impresión inválidos');
  optionalText(value.branchName, 500); optionalText(value.branchAddress, 4000);
  if (settings.logoMode === 'CUSTOM' ? !value.logo : value.logo !== null)
    throw new Error('Modo y logo de presentación inconsistentes');
  const logo = settings.logoMode === 'CUSTOM' ? frozenPng(value.logo!) : undefined;
  return {
    settings: { ...settings, footerNote: clean(settings.footerNote) },
    logo, logoWidth: value.logo?.width, logoHeight: value.logo?.height,
    branchName: value.branchName && clean(value.branchName),
    branchAddress: value.branchAddress && clean(value.branchAddress),
  };
}
