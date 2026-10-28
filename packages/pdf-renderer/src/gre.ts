import QRCode from 'qrcode';
import type { FrozenPrintPresentationV1, PrintableTransportGuide } from '@factuez/contracts';
import { LocalPdfLayout } from './layout';
import { buildReferenceGuide } from './reference-guide';
import { resolvePresentation } from './presentation';
import { assertPrintFormat, assertQaDigest, clean, dateParts, quantity, type PrintFormat } from './types';

export interface PrintableGre {
  id: string; ublNumber: string; issueDate: string; issuer: { ruc: string; legalName: string };
  transferDate: string;
  origin: { address: string; ubigeo: string; establishmentCode: string };
  destination: { address: string; ubigeo: string; establishmentCode: string };
  grossWeight: string; weightUnit: string;
  transport: { mode: string; plate?: string; driverDni?: string; driverFirstName?: string; driverLastName?: string;
    driverLicense?: string; carrierRuc?: string; carrierName?: string; mtcRegistration?: string };
  items: { code: string; description: string; quantity: string; unitCode: string }[];
  branchId?: string;
  printPresentation?: FrozenPrintPresentationV1;
  transferReason?: PrintableTransportGuide['transferReason'];
  packageCount?: string;
  sender?: PrintableTransportGuide['sender'];
  recipient?: PrintableTransportGuide['recipient'];
  relatedDocuments?: PrintableTransportGuide['relatedDocuments'];
  observations?: string;
}

function validate(s: PrintableTransportGuide, format: PrintFormat): void {
  assertPrintFormat(format);
  if (!s || !['09', '31'].includes(s.documentTypeCode) || !/^\d{11}$/.test(s.issuer.identityNumber) ||
    !/^[A-Z][A-Z0-9]{3}-[1-9]\d{0,17}$/.test(s.fullNumber) || !['01', '02'].includes(s.transportModeCode) ||
    !Array.isArray(s.items) || s.items.length < 1 || s.items.length > 100)
    throw new Error('Guía de plantilla local inválida');
  dateParts(s.issueDate); dateParts(s.transferDate);
  quantity(s.grossWeight); clean(s.weightUnit); clean(s.issuer.legalName);
  if (s.packageCount !== undefined) quantity(s.packageCount);
  for (const place of [s.origin, s.destination]) {
    if (!place || !/^\d{6}$/.test(place.ubigeo) || !clean(place.address).trim())
      throw new Error('Origen o destino de la guía inválidos');
  }
  for (const item of s.items) { clean(item.description); clean(item.unitCode); quantity(item.quantity); }
  if (s.transportIndicators !== undefined) {
    const flags = s.transportIndicators;
    const keys = ['categoryM1L', 'returnWithEmptyPackaging', 'scheduledTransshipment', 'emptyVehicleReturn', 'totalTransfer', 'subcontracted', 'freightPayer'];
    if (!flags || typeof flags !== 'object' || Array.isArray(flags) || Object.keys(flags).some(key => !keys.includes(key)) ||
      Object.entries(flags).some(([key, value]) => key === 'freightPayer' ? !['SENDER', 'RECIPIENT', 'OTHER'].includes(String(value)) : typeof value !== 'boolean'))
      throw new Error('Indicadores del traslado inválidos');
  }
}

async function render(s: PrintableTransportGuide, format: PrintFormat, digest?: string): Promise<Buffer> {
  validate(s, format);
  const presentation = resolvePresentation(s.printPresentation, s.issuer.identityNumber, s.branchId);
  const qr = digest ? await QRCode.toBuffer(
    `FACTUEZ-GRE-QA|${s.issuer.identityNumber}|${s.fullNumber}|${digest}|NO-AUTORIZA-TRASLADO`,
    { type: 'png', margin: 4, width: 400, errorCorrectionLevel: 'M' }) : undefined;
  const layout = new LocalPdfLayout({ fullNumber: s.fullNumber, ruc: s.issuer.identityNumber,
    label: s.documentTypeCode === '09' ? 'GUÍA DE REMISIÓN REMITENTE' : 'GUÍA DE REMISIÓN TRANSPORTISTA',
    issueDate: s.issueDate, issuer: s.issuer, guide: true, presentation, reference: true }, format);
  if (format === 'a4') {
    buildReferenceGuide(layout, s, presentation, qr, digest);
    return layout.finish();
  }
  layout.text(s.issuer.tradeName || s.issuer.legalName, layout.ticket ? 11 : 15, { bold: true, gap: 2 });
  if (s.issuer.tradeName) layout.text(s.issuer.legalName, layout.size, { gap: 2 });
  if (s.issuer.address) layout.text(s.issuer.address, layout.size, { gap: 2 });
  if (presentation.settings.showBranchAddress) {
    if (presentation.branchName) layout.text(`Sede: ${presentation.branchName}`);
    if (presentation.branchAddress) layout.text(`Dirección de sede: ${presentation.branchAddress}`);
  }
  layout.text(s.documentTypeCode === '31' ? 'GT · PLANTILLA 31 · SOLO VISTA LOCAL · SIN EMISIÓN' :
    'GR · PLANTILLA 09 · SOLO VISTA LOCAL', layout.ticket ? 7 : 8, { bold: true });
  const issued = dateParts(s.issueDate), transfer = dateParts(s.transferDate);
  const dates = [`Emisión: ${issued.date}${issued.time ? ` · ${issued.time} Lima` : ''}`, `Inicio del traslado: ${transfer.date}`];
  if (layout.ticket) for (const value of dates) layout.text(value);
  else layout.fields(dates);
  layout.section('ORIGEN Y DESTINO');
  const places = [s.origin, s.destination].map((place, index) =>
    `${index ? 'DESTINO' : 'ORIGEN'}\n${place.address}\nUbigeo: ${place.ubigeo}${place.establishmentCode ? ` · Establecimiento: ${place.establishmentCode}` : ''}`);
  if (layout.ticket) places.forEach(value => layout.text(value));
  else layout.fields(places);
  layout.section('DATOS DEL TRASLADO');
  if (s.transferReason) layout.text(`Motivo ${s.transferReason.code}: ${s.transferReason.description}`);
  layout.fields([`Peso bruto: ${s.grossWeight} ${s.weightUnit}`, ...(s.packageCount !== undefined ? [`Bultos: ${s.packageCount}`] : [])]);
  layout.text(`Modalidad: ${s.transportModeCode === '02' ? 'Transporte privado' : 'Transporte público'}`);
  const parties: string[] = [];
  for (const [label, party] of [['Remitente', s.sender], ['Destinatario', s.recipient], ['Transportista', s.carrier]] as const) {
    if (!party) continue;
    const details = [`${label}:`, party.legalName, `Documento: ${party.identityNumber}`];
    if ('address' in party && party.address) details.push(`Dirección: ${party.address}`);
    if ('mtcRegistration' in party && party.mtcRegistration) details.push(`Registro MTC: ${party.mtcRegistration}`);
    parties.push(details.join('\n'));
  }
  if (layout.ticket) parties.forEach(value => layout.text(value));
  else if (parties.length) layout.fields(parties);
  if (s.vehicles?.length || s.drivers?.length) layout.section('VEHÍCULOS Y CONDUCTORES');
  const vehicles: string[] = [], drivers: string[] = [];
  for (const vehicle of s.vehicles ?? []) {
    vehicles.push(`Placa: ${vehicle.plate}${vehicle.circulationCard ? `\nTarjeta de circulación: ${vehicle.circulationCard}` : ''}`);
  }
  for (const driver of s.drivers ?? []) drivers.push(`Conductor: ${driver.legalName}\nDocumento: ${driver.identityNumber}\nLicencia: ${driver.license}`);
  const transport = [vehicles.join('\n\n'), drivers.join('\n\n')].filter(Boolean);
  if (layout.ticket) transport.forEach(value => layout.text(value));
  else if (transport.length) layout.fields(transport);
  layout.section('BIENES A TRASLADAR');
  const widths = [30, 65, layout.content - 210, 45, 70];
  const table = layout.ticket ? undefined : layout.table(['Ítem', 'Código', 'Descripción', 'Unidad', 'Cantidad'], widths, 8);
  for (const [index, item] of s.items.entries()) {
    if (layout.ticket) {
      layout.text(`${index + 1}. ${item.description}`, 8, { bold: true, gap: 1 });
      layout.row([{ text: item.code ?? '', width: layout.content * 0.5 },
        { text: `${quantity(item.quantity)} ${item.unitCode}`, width: layout.content * 0.5, align: 'right' }], 8, { rule: true, gap: 3 });
    } else {
      layout.row([`${index + 1}.`, item.code ?? '', item.description, item.unitCode, quantity(item.quantity)].map((text, column) =>
        ({ text, width: widths[column], align: column === 4 ? 'right' : 'left' })),
      8.5, { tableHeader: table, rule: true, gap: 0, padding: 4 });
    }
  }
  if (s.relatedDocuments?.length) {
    layout.section('DOCUMENTOS RELACIONADOS');
    for (const reference of s.relatedDocuments) layout.text(`${reference.documentTypeCode} · ${reference.fullNumber}${reference.issuerRuc ? ` · RUC ${reference.issuerRuc}` : ''}`);
  }
  if (s.observations) { layout.section('OBSERVACIONES'); layout.text(s.observations); }
  if (presentation.settings.footerNote) { layout.section('NOTA COMERCIAL'); layout.text(presentation.settings.footerNote); }
  if (digest) {
    layout.section('EVIDENCIA DE PRUEBA QA'); layout.image(qr!);
    layout.text(`Hash del XML firmado localmente: ${digest}`, layout.ticket ? 6.5 : 8);
    layout.text('QR interno de prueba. Certificado ficticio, sin CDR oficial ni transmisión a SUNAT.', layout.ticket ? 7 : 8);
  }
  layout.text('Representación local de plantilla. NO AUTORIZA TRASLADO.', layout.ticket ? 7 : 8, { bold: true });
  return layout.finish();
}

/** Sólo vista local de 09/31; no emite 31 ni genera QR fiscal. */
export async function renderLocalTransportGuidePdf(snapshot: PrintableTransportGuide, format: PrintFormat): Promise<Buffer> {
  return render(snapshot, format);
}

/** Perfil GRE QA histórico: se preservan firma, RUC 00, TQ00 y 50 ítems. */
export async function renderLocalGrePdf(s: PrintableGre, format: PrintFormat, digest?: string): Promise<Buffer> {
  if (!['ticket', 'a4'].includes(format) || !/^00\d{9}$/.test(s.issuer.ruc) ||
    !/^TQ00-[1-9]\d{0,7}$/.test(s.ublNumber) || !s.items.length || s.items.length > 50 ||
    (digest !== undefined && (!digest || !/^[A-Za-z0-9+/]{43}=$/.test(digest))))
    throw new Error('GRE imprimible fuera del perfil QA');
  if (digest) assertQaDigest(digest);
  const t = s.transport;
  return render({ documentTypeCode: '09', fullNumber: s.ublNumber, issueDate: s.issueDate, transferDate: s.transferDate,
    issuer: { identityNumber: s.issuer.ruc, legalName: s.issuer.legalName }, origin: s.origin, destination: s.destination,
    grossWeight: s.grossWeight, weightUnit: s.weightUnit, transportModeCode: t.mode as '01' | '02', items: s.items,
    branchId: s.branchId, printPresentation: s.printPresentation, transferReason: s.transferReason, packageCount: s.packageCount,
    sender: s.sender, recipient: s.recipient, relatedDocuments: s.relatedDocuments, observations: s.observations,
    ...(t.carrierRuc || t.carrierName ? { carrier: { identityNumber: t.carrierRuc ?? '', legalName: t.carrierName ?? '',
      ...(t.mtcRegistration ? { mtcRegistration: t.mtcRegistration } : {}) } } : {}),
    ...(t.plate ? { vehicles: [{ plate: t.plate }] } : {}),
    ...(t.driverDni || t.driverFirstName || t.driverLastName || t.driverLicense ? {
      drivers: [{ identityNumber: t.driverDni ?? '', legalName: [t.driverFirstName, t.driverLastName].filter(Boolean).join(' '), license: t.driverLicense ?? '' }],
    } : {}),
  }, format, digest);
}
