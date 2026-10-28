import {boundedSupplementJson} from './fiscal-supplement-command';
import {fiscalRuc,fiscalSnapshotSha256} from './fiscal-note';

export type GuideDispatchKey={companyId:number;issuerRuc:string;operationId:string};
/** This candidate only coordinates an isolated local emulator. It does not
 * attest numbering, XMLDSig, official rules or the authenticity of a CDR. */
export type GuideDispatchManifest={schemaVersion:'factuez.guide-dispatch-manifest.v1';environment:'BETA';key:GuideDispatchKey;
  documentId:string;guideType:'09'|'31';fullNumber:string;ownerRevision:number;
  snapshotSha256:string;xmlSha256:string;zipSha256:string;source:'LOCAL_EMULATOR'};
export type GuideDispatchChange=
  |{kind:'REGISTER';data:{manifestSha256:string}}
  |{kind:'ATTEMPT';data:{attemptId:string}}
  |{kind:'NO_RESPONSE';data:{attemptId:string}}
  |{kind:'TICKET';data:{attemptId:string;ticket:string}}
  |{kind:'POLL_PENDING';data:{ticket:string}}
  |{kind:'POLL_RESULT';data:{ticket:string;receiptSha256:string}};
export type GuideDispatchEvent=GuideDispatchChange&{schemaVersion:'factuez.guide-dispatch-event.v1';operationId:string;
  version:number;previousSha256:string|null;at:string;sha256:string};
export type GuideDispatchProjection={state:'READY'|'INTENT_RECORDED'|'UNCERTAIN'|'TICKET_RECEIVED'|'RESULT_PENDING_VERIFICATION';
  revision:number;headSha256:string|null;lastAt:string|null;attemptId:string|null;ticket:string|null;receiptSha256:string|null;
  candidateOnly:true;fiscalExecutionEnabled:false;transmissionAuthorized:false;authorizedForTransfer:false;officialCdrVerified:false};

export class GuideDispatchError extends Error{constructor(readonly code:string){super(code);}}
function fail(code:string):never{throw new GuideDispatchError(code);}
function copy(value:unknown):any{try{const v=boundedSupplementJson(value);if(Buffer.byteLength(JSON.stringify(v))>256*1024)throw new Error();return v;}catch{return fail('INVALID_GUIDE_DISPATCH_JSON');}}
function exact(v:any,keys:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==[...keys].sort().join(','))fail('INVALID_GUIDE_DISPATCH');}
const matches=(v:unknown,p:RegExp):v is string=>typeof v==='string'&&p.exec(v)?.[0]===v;
const uuid=(v:unknown)=>matches(v,/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const sha=(v:unknown)=>matches(v,/^[a-f0-9]{64}$/);
const integer=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const instant=(v:unknown):v is string=>matches(v,/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
export function validateGuideDispatchKey(value:unknown):GuideDispatchKey{
  const k=copy(value);exact(k,['companyId','issuerRuc','operationId']);
  if(!integer(k.companyId)||!uuid(k.operationId)||!matches(k.issuerRuc,/^[0-9]{11}$/))fail('INVALID_GUIDE_DISPATCH_KEY');
  try{fiscalRuc(k.issuerRuc,'issuerRuc');}catch{fail('INVALID_GUIDE_DISPATCH_KEY');}return k;
}
export function validateGuideDispatchManifest(value:unknown):GuideDispatchManifest{
  const m=copy(value);exact(m,['schemaVersion','environment','key','documentId','guideType','fullNumber','ownerRevision','snapshotSha256','xmlSha256','zipSha256','source']);
  validateGuideDispatchKey(m.key);
  if(m.schemaVersion!=='factuez.guide-dispatch-manifest.v1'||m.environment!=='BETA'||m.source!=='LOCAL_EMULATOR'||!uuid(m.documentId)||!['09','31'].includes(m.guideType)||
    !matches(m.fullNumber,m.guideType==='09'?/^T[A-Z0-9]{3}-[1-9][0-9]{0,7}$/:/^V[A-Z0-9]{3}-[1-9][0-9]{0,7}$/)||!integer(m.ownerRevision)||
    ![m.snapshotSha256,m.xmlSha256,m.zipSha256].every(sha))fail('INVALID_GUIDE_DISPATCH_MANIFEST');return m;
}
const flags={candidateOnly:true as const,fiscalExecutionEnabled:false as const,transmissionAuthorized:false as const,authorizedForTransfer:false as const,officialCdrVerified:false as const};
function change(value:unknown):GuideDispatchChange{
  const c=copy(value);exact(c,['kind','data']);
  switch(c.kind){
    case 'REGISTER':exact(c.data,['manifestSha256']);if(!sha(c.data.manifestSha256))fail('INVALID_GUIDE_DISPATCH');break;
    case 'ATTEMPT':case 'NO_RESPONSE':exact(c.data,['attemptId']);if(!uuid(c.data.attemptId))fail('INVALID_GUIDE_DISPATCH');break;
    case 'TICKET':exact(c.data,['attemptId','ticket']);if(!uuid(c.data.attemptId)||!matches(c.data.ticket,/^[A-Za-z0-9_-]{1,100}$/))fail('INVALID_GUIDE_DISPATCH');break;
    case 'POLL_PENDING':exact(c.data,['ticket']);if(!matches(c.data.ticket,/^[A-Za-z0-9_-]{1,100}$/))fail('INVALID_GUIDE_DISPATCH');break;
    case 'POLL_RESULT':exact(c.data,['ticket','receiptSha256']);if(!matches(c.data.ticket,/^[A-Za-z0-9_-]{1,100}$/)||!sha(c.data.receiptSha256))fail('INVALID_GUIDE_DISPATCH');break;
    default:fail('INVALID_GUIDE_DISPATCH');
  }return c;
}
export function rebuildGuideDispatch(manifest:unknown,eventsInput:unknown):GuideDispatchProjection{
  const m=validateGuideDispatchManifest(manifest),events=copy(eventsInput);
  if(!Array.isArray(events)||events.length>128)fail('GUIDE_DISPATCH_HISTORY_LIMIT');
  const p:GuideDispatchProjection={state:'READY',revision:0,headSha256:null,lastAt:null,attemptId:null,ticket:null,receiptSha256:null,...flags};
  for(const raw of events){
    exact(raw,['kind','data','schemaVersion','operationId','version','previousSha256','at','sha256']);
    const {sha256,...unsigned}=raw;
    if(raw.schemaVersion!=='factuez.guide-dispatch-event.v1'||raw.operationId!==m.key.operationId||raw.version!==p.revision+1||raw.previousSha256!==p.headSha256||
      !instant(raw.at)||p.lastAt!==null&&raw.at<p.lastAt||!sha(raw.sha256)||fiscalSnapshotSha256(unsigned)!==sha256)fail('GUIDE_DISPATCH_HISTORY_INCONSISTENT');
    const c=change({kind:raw.kind,data:raw.data});
    if(p.revision===0){if(c.kind!=='REGISTER'||c.data.manifestSha256!==fiscalSnapshotSha256(m))fail('GUIDE_DISPATCH_HISTORY_INCONSISTENT');}
    else if(c.kind==='ATTEMPT'){
      if(p.state!=='READY'||p.attemptId!==null)fail('GUIDE_DISPATCH_TRANSITION_FORBIDDEN');p.state='INTENT_RECORDED';p.attemptId=c.data.attemptId;
    }else if(c.kind==='NO_RESPONSE'){
      if(p.state!=='INTENT_RECORDED'||c.data.attemptId!==p.attemptId)fail('GUIDE_DISPATCH_TRANSITION_FORBIDDEN');p.state='UNCERTAIN';
    }else if(c.kind==='TICKET'){
      if(!['INTENT_RECORDED','UNCERTAIN'].includes(p.state)||c.data.attemptId!==p.attemptId)fail('GUIDE_DISPATCH_TRANSITION_FORBIDDEN');p.state='TICKET_RECEIVED';p.ticket=c.data.ticket;
    }else if(c.kind==='POLL_PENDING'||c.kind==='POLL_RESULT'){
      if(p.state!=='TICKET_RECEIVED'||p.ticket!==c.data.ticket)fail('GUIDE_DISPATCH_TRANSITION_FORBIDDEN');
      if(c.kind==='POLL_RESULT'){p.state='RESULT_PENDING_VERIFICATION';p.receiptSha256=c.data.receiptSha256;}
    }else fail('GUIDE_DISPATCH_TRANSITION_FORBIDDEN');
    p.revision=raw.version;p.headSha256=raw.sha256;p.lastAt=raw.at;
  }return p;
}
export function appendGuideDispatch(manifest:unknown,events:unknown,event:unknown,at:string):GuideDispatchEvent{
  const m=validateGuideDispatchManifest(manifest),history=copy(events),p=rebuildGuideDispatch(m,history),c=change(event);
  if(p.revision>=128)fail('GUIDE_DISPATCH_HISTORY_LIMIT');
  const unsigned={...c,schemaVersion:'factuez.guide-dispatch-event.v1' as const,operationId:m.key.operationId,version:p.revision+1,previousSha256:p.headSha256,at};
  const next={...unsigned,sha256:fiscalSnapshotSha256(unsigned)} as GuideDispatchEvent;
  rebuildGuideDispatch(m,[...history,next]);return next;
}
