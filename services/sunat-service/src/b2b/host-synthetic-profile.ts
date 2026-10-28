import {fiscalRuc} from '@factuez/sunat-core/dist/fiscal-note';
/** Reserved fixture namespace for this NEW standalone lab. These values are
 * syntactically valid only; no ownership, registration or SUNAT enablement is
 * asserted. Existing history/received QA guards are deliberately unchanged. */
export function syntheticSunatHostRuc(value:unknown):value is string {
 if(typeof value!=='string'||!/^2000000[0-9]{4}$/.test(value))return false;
 try{fiscalRuc(value,'syntheticHostRuc');return true;}catch{return false;}
}
