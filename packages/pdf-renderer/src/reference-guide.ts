import type { PrintableTransportGuide } from '@factuez/contracts';
import type { LocalPdfLayout, Row } from './layout';
import type { ResolvedPresentation } from './presentation';
import { clean, dateParts, quantity } from './types';

const SIZE = 7;
const PAIRS = [90, 197, 122, 146] as const;
const FLAGS = [200, 87, 200, 68] as const;
const GT_FLAGS = [200, 87, 147, 121] as const;
const GOODS = [23, 94, 250, 94, 94] as const;
const LOCAL_WARNING = 'DOCUMENTO LOCAL DE PRUEBA. SIN VALIDEZ TRIBUTARIA. NO AUTORIZA TRASLADO.';

function shown(value?: string): string {
  if (value === undefined) return '-';
  const text = clean(value);
  return text.trim() ? text : '-';
}

function indicator(value: boolean | undefined): string {
  return value === true ? 'SI' : value === false ? 'NO' : '-';
}

function freightPayer(value: PrintableTransportGuide['transportIndicators']): string {
  switch (value?.freightPayer) {
    case 'SENDER': return 'Remitente';
    case 'RECIPIENT': return 'Destinatario';
    case 'OTHER': return 'Otro';
    default: return '-';
  }
}

function modality(code: PrintableTransportGuide['transportModeCode']): string {
  return code === '01' ? 'Transporte Público' : code === '02' ? 'Transporte Privado' : '-';
}

function weight(s: PrintableTransportGuide): string {
  return `${shown(s.grossWeight)} ${shown(s.weightUnit)}`;
}

/**
 * Agrega únicamente bloques A4 de las referencias 09/31. El layout de referencia
 * aporta cabecera, wrapping, paginación, cierre y advertencia en cada página.
 * No emite, firma, genera PDF/QR ni interpreta una aceptación fiscal.
 */
export function buildReferenceGuide(
  layout: LocalPdfLayout,
  s: PrintableTransportGuide,
  presentation: ResolvedPresentation,
  qr?: Buffer,
  digest?: string,
): void {
  const carrierGuide = s.documentTypeCode === '31';
  const issued = dateParts(s.issueDate);
  const transfer = dateParts(s.transferDate);
  const flags = s.transportIndicators;

  function title(text: string, minHeight = 10): Row {
    return layout.row([{ text, width: layout.content, bold: true }], SIZE,
      { padding: 0, gap: 0, minHeight, keepNext: true });
  }

  function pair(
    leftLabel: string, left: string, rightLabel = '', right = '',
    widths: readonly number[] = PAIRS,
    options: { grid?: boolean; minHeight?: number; padding?: number; tableHeader?: Row; keepNext?: boolean;
      borderTop?: boolean; borderBottom?: boolean; borderSides?: boolean } = {},
  ): Row {
    return layout.row([
      { text: leftLabel, width: widths[0], bold: true },
      { text: left, width: widths[1] },
      { text: rightLabel, width: widths[2], bold: true },
      { text: right, width: widths[3] },
    ], SIZE, { padding: 0, gap: 0, minHeight: 13, ...options });
  }

  function single(text: string, options: { bold?: boolean; minHeight?: number; keepNext?: boolean } = {}): Row {
    return layout.row([{ text, width: layout.content }], SIZE,
      { padding: 0, gap: 0, minHeight: 13, ...options });
  }

  if (!layout.inlineIssuer) single(shown(s.issuer.legalName), { bold: true });
  layout.space(6);
  if (carrierGuide) {
    // Un transportista subcontratado no presta su registro MTC al emisor.
    const mtc = s.issuer.mtcRegistration ??
      (s.carrier?.identityNumber === s.issuer.identityNumber ? s.carrier.mtcRegistration : undefined);
    pair('Número registro MTC:', shown(mtc), '', '', [90, 197, 122, 146], { minHeight: 16 });
  }

  const party = carrierGuide ? s.sender : s.recipient;
  pair('Nombre/Razón Social:', shown(party?.legalName), 'RUC:', shown(party?.identityNumber));
  const emission = !carrierGuide && issued.time ? `${issued.date}\nHora: ${issued.time} (Lima)` : issued.date;
  const departure = transfer.time ? `${transfer.date}\nHora: ${transfer.time} (Lima)` : transfer.date;
  pair('Fecha Emisión:', emission, 'Fecha Traslado:', departure);
  pair('Punto de Partida:', shown(s.origin.address), 'Punto de Llegada:', shown(s.destination.address),
    PAIRS, { minHeight: 24 });

  if (carrierGuide) {
    pair('Hora Emisión:', shown(issued.time), 'Peso:', weight(s));
    pair('Ind. Retorno de Vehículo con Envases o Embalajes vacíos:', indicator(flags?.returnWithEmptyPackaging),
      'Indicador Transbordo Programado:', indicator(flags?.scheduledTransshipment), FLAGS, { minHeight: 16 });
    pair('Indicador Retorno Vehículo Vacío:', indicator(flags?.emptyVehicleReturn),
      'Indicador de traslado total de bienes:', indicator(flags?.totalTransfer), GT_FLAGS);
    pair('Indicador de pagador de flete:', freightPayer(flags),
      'Indicador de transporte subcontratado:', indicator(flags?.subcontracted), GT_FLAGS);
  } else {
    pair('Motivo de Traslado:', shown(s.transferReason?.description), 'Modalidad de Traslado:', modality(s.transportModeCode));
    pair('Peso:', weight(s));
    pair('Número de Bultos o Pallets:', shown(s.packageCount),
      'Ind. Traslado en Vehículos de categoría M1 o L:', indicator(flags?.categoryM1L), FLAGS);
    pair('Ind. Retorno de Vehículo con Envases o Embalajes vacíos:', indicator(flags?.returnWithEmptyPackaging),
      'Indicador Transbordo Programado:', indicator(flags?.scheduledTransshipment), FLAGS, { minHeight: 16 });
    pair('Indicador Retorno Vehículo Vacío:', indicator(flags?.emptyVehicleReturn), '', '', FLAGS);
  }

  layout.space(3);
  const goodsHeader = layout.table(['Ítem', 'Código', 'Descripción', 'Unidad', 'Cantidad'], [...GOODS], SIZE);
  for (const [index, item] of s.items.entries()) {
    const values = [`${index + 1}.`, shown(item.code), shown(item.description), shown(item.unitCode), quantity(item.quantity)];
    layout.row(values.map((text, column) => ({ text, width: GOODS[column],
      align: column === 4 ? 'right' : column === 2 ? 'left' : 'center' })), SIZE,
    { grid: true, tableHeader: goodsHeader, minHeight: 18, padding: 3, gap: 0 });
  }

  if (carrierGuide) {
    layout.space(10);
    const senderHeader = title('Datos del Remitente');
    pair('RUC:', shown(s.sender?.identityNumber), 'Nombre/Razón Social:', shown(s.sender?.legalName),
      [104, 138, 93, 220], { grid: false, borderTop: true, borderBottom: true, borderSides: true,
        padding: 3, minHeight: 20, tableHeader: senderHeader });
  }

  layout.space(carrierGuide ? 3 : 10);
  title('Datos del Vehículo y Conductor');
  // No se restringe a la primera unidad. Un header propio acompaña también los
  // fragmentos de filas extensas y los conductores o vehículos sin contraparte.
  const units = Math.max(1, s.vehicles?.length ?? 0, s.drivers?.length ?? 0);
  for (let index = 0; index < units; index++) {
    if (index) layout.space(3);
    const vehicle = s.vehicles?.[index];
    const driver = s.drivers?.[index];
    const unitHeader = layout.row([{ text: index ? `SECUNDARIO ${index + 1}` : 'PRINCIPAL',
      width: layout.content, bold: true }], SIZE,
    { grid: false, borderTop: true, borderSides: true, minHeight: 13, padding: 1, gap: 0, keepNext: true });
    const driverLabel = !driver || /^\d{8}$/.test(driver.identityNumber) ? 'DNI:' : 'Documento:';
    pair('Placa:', shown(vehicle?.plate), driverLabel, shown(driver?.identityNumber),
      carrierGuide ? [82, 160, 128, 185] : [82, 160, 52, 261],
      { grid: false, borderSides: true, padding: 3, minHeight: 14, tableHeader: unitHeader });
    pair('Nombres y Apellidos:', shown(driver?.legalName),
      'Número de la Tarjeta Única de Circulación:', shown(vehicle?.circulationCard), [82, 160, 160, 153],
      { grid: false, borderSides: true, padding: 3, minHeight: 14, tableHeader: unitHeader });
    pair('Número de Licencia de Conducir:', shown(driver?.license), '', '', [122, 120, 160, 153],
      { grid: false, borderSides: true, borderBottom: true, padding: 3, minHeight: 14, tableHeader: unitHeader });
  }

  layout.space(2);
  const observationsHeader = layout.row([{ text: 'Observaciones', width: layout.content, bold: true }], SIZE,
    { grid: false, borderTop: true, borderSides: true, minHeight: 14, padding: 3, gap: 0, keepNext: true });
  const observations = [
    LOCAL_WARNING,
    ...(s.observations !== undefined ? [
      `Observaciones aportadas: ${shown(s.observations)}`,
    ] : []),
    ...(presentation.settings.footerNote.trim() ? [
      `Nota comercial: ${clean(presentation.settings.footerNote)}`,
    ] : []),
  ];
  layout.row([{ text: observations.join('\n'), width: layout.content }], SIZE,
    { grid: false, borderSides: true, borderBottom: true,
      minHeight: 20, padding: 3, gap: 0, tableHeader: observationsHeader });

  // Campos congelados que no tienen casilla en el original se conservan en
  // extensiones del mismo formulario, después de los bloques de la referencia.
  const issuerDetails = ([
    ...(!layout.inlineIssuer ? [['Nombre comercial:', s.issuer.tradeName], ['Dirección del emisor:', s.issuer.address]] as const : []),
    ...(presentation.settings.showBranchAddress ? [
      ['Sede:', presentation.branchName], ['Dirección de sede:', presentation.branchAddress],
    ] as const : []),
  ] as const).filter(([, value]) => value?.trim());
  if (issuerDetails.length) {
    layout.space(2);
    const issuerHeader = title('Datos complementarios del emisor y sede', 9);
    for (let index = 0; index < issuerDetails.length; index += 2) {
      const [label, value] = issuerDetails[index];
      const next = issuerDetails[index + 1];
      pair(label, shown(value), next?.[0] ?? '', next ? shown(next[1]) : '', PAIRS,
        { minHeight: 10, tableHeader: issuerHeader });
    }
  }
  layout.space(2);
  const placeHeader = title('Datos complementarios del traslado', 9);
  pair('Ubigeo de partida:', shown(s.origin.ubigeo), 'Ubigeo de llegada:', shown(s.destination.ubigeo),
    PAIRS, { minHeight: 10, tableHeader: placeHeader });
  if (s.origin.establishmentCode !== undefined || s.destination.establishmentCode !== undefined) {
    pair('Establecimiento de partida:', shown(s.origin.establishmentCode),
      'Establecimiento de llegada:', shown(s.destination.establishmentCode), PAIRS, { minHeight: 10, tableHeader: placeHeader });
  }
  if (carrierGuide) {
    pair('Motivo de Traslado:', shown(s.transferReason?.description), 'Modalidad de Traslado:', modality(s.transportModeCode),
      PAIRS, { minHeight: 10, tableHeader: placeHeader });
    if (s.packageCount !== undefined || flags?.categoryM1L !== undefined) {
      pair('Número de Bultos o Pallets:', shown(s.packageCount),
        'Ind. Traslado en Vehículos de categoría M1 o L:', indicator(flags?.categoryM1L), FLAGS,
        { minHeight: 10, tableHeader: placeHeader });
    }
  } else {
    if (s.issuer.mtcRegistration !== undefined) pair('Registro MTC del emisor:', shown(s.issuer.mtcRegistration),
      '', '', PAIRS, { minHeight: 10, tableHeader: placeHeader });
    if (flags?.totalTransfer !== undefined || flags?.subcontracted !== undefined) {
      pair('Indicador de traslado total de bienes:', indicator(flags?.totalTransfer),
        'Indicador de transporte subcontratado:', indicator(flags?.subcontracted), FLAGS,
        { minHeight: 10, tableHeader: placeHeader });
    }
    if (flags?.freightPayer !== undefined) pair('Indicador de pagador de flete:', freightPayer(flags),
      '', '', FLAGS, { minHeight: 10, tableHeader: placeHeader });
  }
  if (s.transferReason?.code !== undefined) pair('Código del motivo:', shown(s.transferReason.code),
    '', '', PAIRS, { minHeight: 10, tableHeader: placeHeader });

  for (const [label, detail, alreadyNamed] of [
    ['Remitente', s.sender, carrierGuide], ['Destinatario', s.recipient, !carrierGuide],
  ] as const) {
    if (!detail || alreadyNamed && detail.address === undefined) continue;
    layout.space(2);
    const partyHeader = title(`Datos complementarios del ${label.toLowerCase()}`, 9);
    if (!alreadyNamed) pair('Nombre/Razón Social:', shown(detail.legalName), 'RUC:', shown(detail.identityNumber),
      PAIRS, { minHeight: 10, tableHeader: partyHeader });
    if (detail.address !== undefined) layout.row([
      { text: 'Dirección:', width: 90, bold: true },
      { text: shown(detail.address), width: 465 },
    ], SIZE, { padding: 0, gap: 0, minHeight: 10, tableHeader: partyHeader });
  }

  if (s.carrier) {
    layout.space(2);
    const carrierHeader = title('Datos del Transportista', 9);
    pair('Nombre/Razón Social:', shown(s.carrier.legalName), 'RUC:', shown(s.carrier.identityNumber),
      PAIRS, { grid: true, padding: 1, minHeight: 11, tableHeader: carrierHeader });
    pair('Número registro MTC:', shown(s.carrier.mtcRegistration), '', '', PAIRS,
      { grid: true, padding: 1, minHeight: 11, tableHeader: carrierHeader });
  }

  if (s.relatedDocuments?.length) {
    layout.space(2);
    title('Documentos relacionados', 9);
    const widths = [47, 235, 273];
    const relatedHeader = layout.row(['Tipo', 'Número', 'RUC del emisor']
      .map((text, index) => ({ text, width: widths[index], align: 'center', bold: true })), SIZE,
    { grid: true, minHeight: 16, padding: 1, gap: 0, keepNext: true });
    for (const related of s.relatedDocuments) {
      layout.row([shown(related.documentTypeCode), shown(related.fullNumber), shown(related.issuerRuc)]
        .map((text, index) => ({ text, width: widths[index] })), SIZE,
      { grid: true, tableHeader: relatedHeader, minHeight: 11, padding: 1, gap: 0 });
    }
  }

  layout.space(2);
  layout.closing({
    description: `Guía ${carrierGuide ? 'Transportista' : 'Remitente'} de prueba local. Sin aceptación oficial de SUNAT. NO AUTORIZA TRASLADO.`,
    qr,
    digest,
  });
}
