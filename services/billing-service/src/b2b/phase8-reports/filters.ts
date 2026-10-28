import { b2bDocumentFilters, b2bQuery } from '@factuez/contracts/b2b-read-query';
import type { ReportsFilters, ReportsDocumentType } from './types';
import { fail } from './validation';
export const reportsTypes = ['01','03','07','08','09','31','NV'] as const;
/** Owner-local extension; shared 01/03 query contracts remain unchanged. */
export function reportsFilters(value:unknown, extended=false):ReportsFilters {
  const q=b2bQuery(value,['issuerId','issuerRuc','environment','from','to','types','branchId','pointId','seriesId'],['issuerId','environment','from','to']);
  const types=q.types===undefined?['01','03']:q.types.split(',');
  if(!types.length||types.some(t=>!reportsTypes.includes(t as ReportsDocumentType))||new Set(types).size!==types.length) fail(400,'INVALID_DOCUMENT_TYPES');
  if(!extended&&types.some(t=>!['01','03'].includes(t))) fail(422,'SOURCE_NOT_SUPPORTED');
  if(q.issuerRuc!==undefined&&!/^[0-9]{11}$/.test(q.issuerRuc)) fail(400,'INVALID_ISSUER');
  const {issuerRuc,...base}=q;
  const parsed=b2bDocumentFilters({...base,types:'01,03'});
  return {...parsed,types:types.sort() as ReportsDocumentType[],...(issuerRuc?{issuerRuc}:{})};
}

