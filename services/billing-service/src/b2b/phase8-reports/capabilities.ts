import type { ReportsDocumentType } from './types';
/** Capability facts, not grants or an assertion that an owner is activated. */
export function reportTypeCapability(type:ReportsDocumentType) {
  const guide=type==='09'||type==='31',commercial=type==='NV',correction=type==='07'||type==='08';
  return {
    type,representations:['CSV','XLSX','PDF'] as const,
    dataParity:guide?'LOCAL_NUMBERED_GUIDE':commercial?'LOCAL_COMPLETED_COMMERCIAL':'CURRENT_OWNER_DOCUMENT',
    financialContribution:guide||commercial?'NONE':type==='07'?'NEGATIVE_LOCAL_AMOUNT':'POSITIVE_LOCAL_AMOUNT',
    authorization:guide?'EXPLICIT_NUMBERED_GUIDE_READ':correction?'EXPLICIT_CORRECTION_PAIR_READ':commercial?'EXACT_COMMERCIAL_ACTOR_READ':'EXACT_DOCUMENT_BINDING',
    metadataCapability:guide?'EXISTING_PRIVATE_HTTP_READ_ONLY':'NOT_APPLICABLE',
    metadataProvidesReportRows:false,
    finalFiscalParity:false,fiscalAcceptance:'NOT_ASSERTED',authorizedForTransfer:false,
    sourceActivation:correction?'REQUIRES_COMPOSED_CORRECTION_READ_AUTHORITY':'REQUIRES_EXPLICIT_OWNER_COMPOSITION',
  } as const;
}
export const reportsSourceCapabilities=()=> (['01','03','07','08','09','31','NV'] as const).map(reportTypeCapability);

