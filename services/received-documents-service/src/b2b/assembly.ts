import type {B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {B2bReceptionReads,type ReceptionGrantAdministrator} from './read';
import {PostgresReceivedReadStore,type ReceivedDatabase} from './store';

/** Explicit owner composition, inert until a host supplies the dedicated
 * reception database and pinned Identity client. Never installs schema, opens a
 * listener, reads PWA credentials, starts SIRE/mail or grants a default policy.
 * Grant administration fails closed if its live step-up port is not supplied. */
export function createB2bReceivedReadOwner(options:{
  database:ReceivedDatabase;identity:B2bIdentityPort;grantAdministrator?:ReceptionGrantAdministrator;
}){
  if(!options?.database||typeof options.database.$transaction!=='function'||!options.identity||typeof options.identity.authenticate!=='function')
    throw new Error('EXPLICIT_RECEPTION_DATABASE_AND_IDENTITY_REQUIRED');
  return new B2bReceptionReads(new PostgresReceivedReadStore(options.database),options.identity,options.grantAdministrator??null);
}
