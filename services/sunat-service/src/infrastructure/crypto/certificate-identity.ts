/** Sólo atributos de identidad, nunca CN ni búsqueda libre por substring.
 * NTRPE-/VATPE-: organizationIdentifier ETSI EN 319 412-1, §5.1.4.
 * Identificar el RUC no verifica confianza PKI ni registro en SUNAT.
 */
export function certificateRucCandidates(attributes: ReadonlyArray<{ type?: string; value?: unknown }>): string[] {
  return [...new Set(attributes.flatMap(attribute => {
    if (!['2.5.4.5', '2.5.4.97'].includes(attribute.type ?? '')) return [];
    const value = String(attribute.value ?? '').trim();
    const local = /^(?:(?:RUC|RUCPE)[: -]?)?(\d{11})$/i.exec(value);
    if (local) return [local[1]];
    if (attribute.type === '2.5.4.97') {
      const organizational = /^(?:NTRPE|VATPE)-(\d{11})$/.exec(value);
      if (organizational) return [organizational[1]];
    }
    return [];
  }))];
}
