import {it,expect} from 'vitest';
it('loads minimal owner factories without ambient database or enrollment',async()=>{
 for(const path of ['../services/identity-service/src/b2b/readonly-owner-runtime','../services/billing-service/src/b2b/readonly-owner-runtime','../services/sunat-service/src/b2b/readonly-owner-runtime','./helpers/b2b-readonly-postgres','../services/b2b-api-service/src/readonly-main']){
  try{expect(await import(path)).toBeTruthy();}catch(e){console.error(path,(e as Error).stack);throw e;}
 }
});