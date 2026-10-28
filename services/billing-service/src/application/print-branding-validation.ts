import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  PRINT_TEMPLATE, type PrintBrandingDraft, type PrintBrandingSettings,
  type PrintLogoSnapshot, type PrintLogoUpload,
} from '@factuez/contracts';

export const MAX_LOGO_UPLOAD_BYTES = 256 * 1024;
export const MAX_FROZEN_LOGO_BYTES = 128 * 1024;
const settingsKeys = ['template', 'logoMode', 'logoWidthMm', 'logoAlignment', 'showBranchAddress', 'footerNote'];
export function plainObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => keys.includes(key)));
}
export function validatePrintSettings(value: unknown): PrintBrandingSettings {
  if (!plainObject(value, settingsKeys) || Object.keys(value).length !== settingsKeys.length ||
      value.template !== PRINT_TEMPLATE || typeof value.logoMode !== 'string' || !['DEFAULT', 'CUSTOM', 'NONE'].includes(value.logoMode) ||
      !Number.isInteger(value.logoWidthMm) || (value.logoWidthMm as number) < 20 || (value.logoWidthMm as number) > 60 ||
      typeof value.logoAlignment !== 'string' || !['LEFT', 'CENTER'].includes(value.logoAlignment) || typeof value.showBranchAddress !== 'boolean' ||
      typeof value.footerNote !== 'string' || value.footerNote.length > 160 ||
      /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069<>]/.test(value.footerNote)) {
    throw new BadRequestException('Revise el logo, su ancho (20 a 60 mm) y el texto comercial (hasta 160 caracteres).');
  }
  return { ...(value as unknown as PrintBrandingSettings), footerNote: value.footerNote.trim() };
}
export function validatePrintDraft(value: unknown): PrintBrandingDraft {
  if (!plainObject(value, ['settings', 'logoUpload']) || !Object.hasOwn(value, 'settings'))
    throw new BadRequestException('Configuración de impresión inválida.');
  const settings = value.settings === null ? null : validatePrintSettings(value.settings);
  if (value.logoUpload !== undefined && (!settings || settings.logoMode !== 'CUSTOM'))
    throw new BadRequestException('El archivo de logo sólo se admite en modo personalizado.');
  if (value.logoUpload !== undefined && !plainObject(value.logoUpload, ['mediaType', 'base64']))
    throw new BadRequestException('El logo no admite rutas, URLs ni campos adicionales.');
  return { settings, ...(value.logoUpload === undefined ? {} : { logoUpload: value.logoUpload as unknown as PrintLogoUpload }) };
}
function uploadBytes(value: unknown) {
  if (!plainObject(value, ['mediaType', 'base64']) || Object.keys(value).length !== 2 ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(String(value.mediaType)) || typeof value.base64 !== 'string' ||
      !value.base64.length || value.base64.length > Math.ceil(MAX_LOGO_UPLOAD_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64))
    throw new BadRequestException('Use un logo PNG, JPG o WebP de hasta 256 KB. No se admiten SVG ni enlaces.');
  const bytes = Buffer.from(value.base64, 'base64');
  if (!bytes.length || bytes.length > MAX_LOGO_UPLOAD_BYTES || bytes.toString('base64') !== value.base64)
    throw new BadRequestException('Contenido de logo inválido.');
  const format = value.mediaType === 'image/png' ? 'png' : value.mediaType === 'image/jpeg' ? 'jpeg' : 'webp';
  const magic = format === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
    format === 'jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 :
    bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!magic) throw new BadRequestException('El contenido del archivo no coincide con el formato indicado.');
  return { bytes, format };
}
/** Decodifica píxeles, limita memoria, rechaza animación y elimina metadata/EXIF. */
export async function normalizePrintLogo(value: unknown): Promise<PrintLogoSnapshot> {
  const { bytes, format } = uploadBytes(value);
  try {
    const options = { failOn: 'warning' as const, limitInputPixels: 4_194_304, animated: false };
    const metadata = await sharp(bytes, options).metadata();
    if (metadata.format !== format || !metadata.width || !metadata.height ||
        metadata.width < 8 || metadata.height < 8 || metadata.width > 4096 || metadata.height > 4096 ||
        metadata.width * metadata.height > 4_194_304 || (metadata.pages ?? 1) !== 1)
      throw new Error('Dimensiones o animación no admitidas');
    for (const [width, height] of [[1024, 512], [512, 256], [256, 128]]) {
      const result = await sharp(bytes, options).rotate().toColourspace('srgb')
        .resize({ width, height, fit: 'inside', withoutEnlargement: true })
        .png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer({ resolveWithObject: true });
      if (result.data.length <= MAX_FROZEN_LOGO_BYTES) return {
        mediaType: 'image/png', base64: result.data.toString('base64'),
        sha256: createHash('sha256').update(result.data).digest('hex'),
        width: result.info.width, height: result.info.height,
      };
    }
    throw new Error('Logo demasiado grande después de normalizar');
  } catch {
    throw new BadRequestException('No se pudo leer el logo. Use una imagen estática válida, hasta 4 megapíxeles y 256 KB.');
  }
}
