import type { B2bBinding, B2bPrincipal, EmailDeliveryAttachment, EmailDeliveryDocumentSource } from './email-deliveries.types';
import { checkedEmailDocument, emailFail, emailHash } from './email-deliveries';
import { b2bBindingsContain, b2bBindingKey, validB2bBinding } from './email-deliveries.security';
export interface EmailDeliveryOwnerProof {
  binding:B2bBinding;documentId:string;sourceProofSha256:string;presentationRevision:string;
  originals:readonly {id:string;kind:'XML'|'CDR';fileName:string;mediaType:'application/xml'|'application/zip';sha256:string;byteLength:number}[];
}
/** Composition implements these against actual document, immutable storage and current PDF owners.
 * No acceptance boolean is accepted or synthesized. Absent original references remain absent. */
export interface EmailDeliveryArtifactOwner {
  authorizeDocumentCurrent(p:B2bPrincipal,binding:B2bBinding,documentId:string):Promise<EmailDeliveryOwnerProof>;
  currentPdf(proof:Readonly<EmailDeliveryOwnerProof>,format:'ticket'|'a4'):Promise<{bytes:Uint8Array;presentationRevision:string}>;
  readOriginal(proof:Readonly<EmailDeliveryOwnerProof>,id:string,maximumBytes:number):Promise<Uint8Array>;
}
export class OwnerEmailDeliveryDocumentSource implements EmailDeliveryDocumentSource {
  constructor(private readonly owner:EmailDeliveryArtifactOwner) {}
  async authorizeDocumentCurrent(p:B2bPrincipal,binding:B2bBinding,documentId:string,format:'ticket'|'a4') {
    if(!validB2bBinding(binding)||!b2bBindingsContain(p.bindings,binding))emailFail(404,'RESOURCE_NOT_FOUND');
    const get=async()=>structuredClone(await this.owner.authorizeDocumentCurrent(structuredClone(p),structuredClone(binding),documentId));
    const proof=await get();
    if(!proof||!validB2bBinding(proof.binding)||b2bBindingKey(proof.binding)!==b2bBindingKey(binding)||
      proof.documentId!==documentId||!Array.isArray(proof.originals)||proof.originals.length>2||
      proof.originals.some(o=>!o||!['XML','CDR'].includes(o.kind)||!Number.isSafeInteger(o.byteLength)||o.byteLength<1||o.byteLength>10*1024*1024)||
      new Set(proof.originals.map(o=>o.kind)).size!==proof.originals.length)emailFail(409,'EMAIL_ARTIFACT_INTEGRITY');
    const pdf=await this.owner.currentPdf(structuredClone(proof),format);
    if(pdf.presentationRevision!==proof.presentationRevision)emailFail(409,'EMAIL_ARTIFACT_INTEGRITY');
    const shared={documentId,binding:structuredClone(binding),sourceProofSha256:proof.sourceProofSha256};
    const attachments:EmailDeliveryAttachment[]=[{...shared,kind:'PDF',representation:'CURRENT_GENERATED',
      fileName:documentId+'-current-'+format+'.pdf',mediaType:'application/pdf',bytes:Buffer.from(pdf.bytes),sha256:emailHash(pdf.bytes)}];
    for(const original of proof.originals) {
      const bytes=Buffer.from(await this.owner.readOriginal(structuredClone(proof),original.id,original.byteLength));
      if(bytes.length!==original.byteLength||emailHash(bytes)!==original.sha256)emailFail(409,'EMAIL_ARTIFACT_INTEGRITY');
      attachments.push({...shared,kind:original.kind,representation:'IMMUTABLE_ORIGINAL',fileName:original.fileName,
        mediaType:original.mediaType,bytes,sha256:original.sha256});
    }
    if(JSON.stringify(await get())!==JSON.stringify(proof))emailFail(409,'EMAIL_ARTIFACT_INTEGRITY');
    return checkedEmailDocument({...shared,presentationRevision:proof.presentationRevision,attachments},{binding,documentId});
  }
}

