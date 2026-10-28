import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { B2bOwnerReadFrame,type B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import { OwnerChanges,type OwnerJournalReader } from '@factuez/service-access/dist/integration-owner-changes';
import { readQuery } from '@factuez/service-access/dist/integration';
import { BillingCapture,type BillingCaptureRepository } from '../integration/capture';
import { BillingRead,type BillingReadRepository } from '../integration/read';
/** Reuse owner engines explicitly; the original readonly audience guard is never bypassed. */
export class B2bBillingExtraction {
  constructor(private readonly documents:BillingReadRepository,private readonly captures:BillingCaptureRepository,private readonly journals:OwnerJournalReader,private readonly identity:B2bIdentityPort){}
  async execute(token:string,kind:'SERVICE'|'USER',action:string,args:unknown){
    const frame=new B2bOwnerReadFrame(this.identity,kind),capture=new BillingCapture(this.captures,frame),changes=new OwnerChanges(this.journals,frame);
    if(action==='extract:capture')return capture.capture(token,args);
    if(action==='extract:reauthorize')return capture.reauthorize(token,args);
    if(action==='extract:journal')return changes.read(token,args);
    if(action==='extract:change-ready'||action==='extract:capture-ready')return changes.ready(token,args);
    const q=readQuery(args,['issuerRuc','environment','id'],['issuerRuc','id']);
    if(action==='extract:document')return new BillingRead(this.documents,frame).document(token,q.issuerRuc,q.id);
    if(action==='extract:batch')return new BillingRead(this.documents,frame).batch(token,q.issuerRuc,q.id);
    throw new B2bSecurityError(422,'SOURCE_NOT_SUPPORTED');
  }
}
