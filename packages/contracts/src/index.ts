export * from './events';
export * from './authorization';
export * from './fiscal-delivery';
export * from './production-status';
export * from './print-presentation';
export * from './station-admin';
// El payload específico del cliente es opt-in del servidor, no se carga al
// importar eventos/permisos desde un consumidor o un bundle de navegador.
export type { ClientIntakeV1, ClientIntakeCompany, ClientIntakeBranch, ClientIntakePending, ClientIntakeReportV1 } from './client-intake';
export * from './received-documents';
export * from './received-automation';

export * from './production-notes';

export * from './production-guides';

export * from './production-batches';
