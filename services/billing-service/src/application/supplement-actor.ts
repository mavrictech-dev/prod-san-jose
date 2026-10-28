import type {AccessScope} from '@factuez/contracts';
import type {B2bPrincipal} from '@factuez/contracts/b2b-security';
import {boundedSupplementJson} from '@factuez/sunat-core/dist/fiscal-supplement-command';
export type SupplementActor={userId:string|null;scope:AccessScope;b2b?:Pick<B2bPrincipal,'kind'|'clientId'|'revision'|'subjectId'|'userAuthRevision'>};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function check(v:unknown):asserts v{if(!v)throw new Error('Reserva BETA: actor/scope inválido');}
/** Internal verified-actor representation, NOT an authentication or token endpoint. */
export function supplementActor(value:unknown):SupplementActor {
  const a=boundedSupplementJson(value) as SupplementActor;
  check(a&&Object.keys(a).every(k=>['userId','scope','b2b'].includes(k))&&a.scope&&['GLOBAL','ASSIGNED'].includes(a.scope.kind));
  if(a.scope.kind==='ASSIGNED')check([a.scope.branchIds,a.scope.emissionPointIds,a.scope.series].every(ids=>Array.isArray(ids)&&ids.length<=500&&ids.every(id=>typeof id==='string'&&UUID.test(id))));
  if(Object.hasOwn(a,'b2b')){
    check(a.b2b&&typeof a.b2b==='object');
    check(a.scope.kind==='ASSIGNED');
    const p=a.b2b;check(Object.keys(p).sort().join(',')==='clientId,kind,revision,subjectId,userAuthRevision'&&typeof p.clientId==='string'&&UUID.test(p.clientId)&&Number.isSafeInteger(p.revision)&&p.revision>0);
    if(p.kind==='SERVICE')check(a.userId===null&&p.subjectId===null&&p.userAuthRevision===null);
    else check(p.kind==='USER'&&typeof a.userId==='string'&&UUID.test(a.userId)&&p.subjectId===a.userId&&Number.isSafeInteger(p.userAuthRevision)&&Number(p.userAuthRevision)>=0);
  }else check(typeof a.userId==='string'&&UUID.test(a.userId));
  return a;
}
export function supplementActorIdentity(a:SupplementActor){return a.b2b?{kind:a.b2b.kind,clientId:a.b2b.clientId,subjectId:a.b2b.subjectId}:{kind:'LEGACY_USER',subjectId:a.userId};}
