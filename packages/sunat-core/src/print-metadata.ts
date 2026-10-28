type RecordValue = Record<string, unknown>;
const record = (value: unknown, fields: readonly string[]): value is RecordValue =>
  !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => fields.includes(key));
const text = (value: unknown, length: number) => value === undefined ||
  typeof value === 'string' && value.length <= length && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value);
const operationFields = ['branchName', 'branchAddress', 'emissionPointName', 'vehiclePlate', 'attendedBy',
  'shiftLabel', 'observations', 'amountInWords', 'purchaseOrder', 'scopNumber', 'relatedGuide', 'odometer'];

/** Sólo metadata visual congelada. Nunca se serializa en UBL ni reemplaza datos fiscales. */
export function validPrintMetadata(snapshot: RecordValue): boolean {
  if (snapshot.printOperation !== undefined && (!record(snapshot.printOperation, operationFields) ||
    !Object.values(snapshot.printOperation).every(value => text(value, 1000)))) return false;
  const value = snapshot.printPresentation;
  if (value === undefined) return true;
  if (!record(value, ['version', 'issuerRuc', 'branchId', 'profileRevision', 'settings', 'logo', 'branchName', 'branchAddress']) ||
    value.version !== 'factuez.print-presentation.v1' || !record(snapshot.issuer, ['identityType', 'identityNumber', 'legalName', 'address', 'tradeName', 'ubigeo', 'establishmentCode']) ||
    value.issuerRuc !== snapshot.issuer.identityNumber || value.branchId !== (snapshot.branchId ?? null) ||
    !Number.isSafeInteger(value.profileRevision) || Number(value.profileRevision) < 0 ||
    !text(value.branchName, 250) || !text(value.branchAddress, 1000)) return false;
  const settings = value.settings;
  if (!record(settings, ['template', 'logoMode', 'logoWidthMm', 'logoAlignment', 'showBranchAddress', 'footerNote']) ||
    settings.template !== 'SAN_JOSE_V1' || typeof settings.logoMode !== 'string' || !['DEFAULT', 'CUSTOM', 'NONE'].includes(settings.logoMode) ||
    typeof settings.logoAlignment !== 'string' || !['LEFT', 'CENTER'].includes(settings.logoAlignment) || !Number.isInteger(settings.logoWidthMm) ||
    Number(settings.logoWidthMm) < 20 || Number(settings.logoWidthMm) > 60 || typeof settings.showBranchAddress !== 'boolean' ||
    typeof settings.footerNote !== 'string' || settings.footerNote.length > 160 || /[<>\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(settings.footerNote)) return false;
  if (settings.logoMode !== 'CUSTOM') return value.logo === null;
  const logo = value.logo;
  if (!record(logo, ['mediaType', 'base64', 'sha256', 'width', 'height']) || logo.mediaType !== 'image/png' ||
    typeof logo.base64 !== 'string' || !logo.base64.length || logo.base64.length > 4 * Math.ceil(128 * 1024 / 3) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(logo.base64) ||
    typeof logo.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(logo.sha256) ||
    !Number.isInteger(logo.width) || !Number.isInteger(logo.height) || Number(logo.width) < 1 || Number(logo.width) > 1024 ||
    Number(logo.height) < 1 || Number(logo.height) > 512) return false;
  // También se usa en PWA: sólo estructura y binding. CRC/SHA del PNG se
  // verifican en Billing/pdf-renderer. El PNG nunca forma parte del UBL.
  const padding = logo.base64.endsWith('==') ? 2 : logo.base64.endsWith('=') ? 1 : 0;
  const length = logo.base64.length / 4 * 3 - padding;
  return length >= 33 && length <= 128 * 1024 && logo.base64.startsWith('iVBORw0KGgo');
}
