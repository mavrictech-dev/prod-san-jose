export const GRE_QA_SCENARIOS = ['READY','REJECTED','UNCERTAIN'] as const;
export type GreQaScenario = typeof GRE_QA_SCENARIOS[number];
/** Simulador en memoria: no HTTP, token, CDR falso ni estado fiscal ACCEPTED. */
export function simulateGreQa(scenario: unknown, localIdentifier: string) {
  if (!GRE_QA_SCENARIOS.includes(scenario as GreQaScenario)) throw new Error('Escenario GRE local inválido');
  if (!/^GRE-QA-[0-9a-f-]{36}$/i.test(localIdentifier)) throw new Error('Identificador GRE QA inválido');
  return { scenario, state: scenario === 'READY' ? 'SIMULATED_READY' : scenario === 'REJECTED' ? 'SIMULATED_REJECTED' : 'LOCAL_UNKNOWN',
    transport: 'LOCAL_SIMULATION', officialCdr: false, fiscalTransmission: false, authorizedForTransfer: false,
    localTicket: `LOCAL-${localIdentifier}`, description: scenario === 'READY' ? 'Simulación local completada; no es aceptación SUNAT ni autoriza traslado' : scenario === 'REJECTED' ? 'Rechazo simulado; no existe CDR oficial' : 'Respuesta perdida simulada; no reenviar automáticamente' };
}
