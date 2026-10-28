import { createHash } from 'node:crypto';
import { productionBatchesZipMembers } from './production-batches-zip';
import { CdrSignatureTrustService } from './crypto/cdr-signature-trust.service';
import { CAC_NS, CBC_NS, child, children, leaf, safeXml } from './sunat/safe-xml';
import type { ProductionBatchesSnapshot } from '@factuez/contracts/production-batches';
export const productionBatchesHash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
/** ZIP validated with CRC, bounds, central/local agreement, uniqueness and exact membership before parsing.
 * All ApplicationResponses must be signed by the externally pinned SUNAT PKI/CRL verifier.
 * A summary-only CDR covers the exact signed RC/RA; an expanded CDR must contain EVERY member. */
export async function verifyProductionBatchesCdr(zip:Buffer,b:ProductionBatchesSnapshot,trust:Pick<CdrSignatureTrustService,'verify'>){
  const prefix='R-'+b.issuerRuc+'-',summary=prefix+b.identifier+'.xml';
  const expanded=[summary,...b.entries.map(e=>prefix+e.snapshot.documentTypeCode+'-'+e.snapshot.fullNumber+'.xml')];
  const files=productionBatchesZipMembers(zip);
  const names=Object.keys(files).sort();
  if(JSON.stringify(names)!==JSON.stringify([summary])&&JSON.stringify(names)!==JSON.stringify(expanded.sort()))throw Error('Miembros CDR no exactos');
  const hashes:Record<string,string>={};let summaryCode:string|undefined;
  for(const name of names){
    const xml=files[name],root=safeXml(new TextDecoder('utf-8',{fatal:true}).decode(xml));
    if(root.localName!=='ApplicationResponse'||root.namespaceURI!=='urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2'||!await trust.verify(xml))throw Error('Firma/PKI CDR no verificada');
    if(leaf(child(child(root,CAC_NS,'SenderParty'),CAC_NS,'PartyIdentification'),CBC_NS,'ID',11)!=='20131312955'||
       leaf(child(child(root,CAC_NS,'ReceiverParty'),CAC_NS,'PartyIdentification'),CBC_NS,'ID',11)!==b.issuerRuc)throw Error('Emisor/receptor CDR ajeno');
    const response=child(root,CAC_NS,'DocumentResponse'),ref=child(response,CAC_NS,'DocumentReference'),inner=child(response,CAC_NS,'Response');
    const entry=b.entries.find(e=>name===prefix+e.snapshot.documentTypeCode+'-'+e.snapshot.fullNumber+'.xml');
    const expected=name===summary?b.identifier:entry!.snapshot.fullNumber;
    if(leaf(ref,CBC_NS,'ID',60)!==expected)throw Error('Referencia CDR ajena');
    const ids=children(inner,CBC_NS,'ReferenceID');
    if(ids.length>1||ids.length===1&&leaf(inner,CBC_NS,'ReferenceID',60)!==expected)throw Error('ReferenceID CDR ajeno');
    const types=children(ref,CBC_NS,'DocumentTypeCode');
    if(types.length>1||types.length===1&&leaf(ref,CBC_NS,'DocumentTypeCode',2)!==(entry?.snapshot.documentTypeCode??b.kind))throw Error('Tipo CDR ajeno');
    const code=leaf(inner,CBC_NS,'ResponseCode',10);
    if(!/^[0-9]{1,5}$/.test(code)||code!=='0'&&Number(code)<2000)throw Error('Código CDR no final');
    if(name===summary)summaryCode=code;
    hashes[name]=productionBatchesHash(xml);
  }
  if(summaryCode===undefined)throw Error('CDR resumen ausente');
  // Do not turn conflicting per-member results into a batch acceptance.
  if(summaryCode==='0'&&names.some(name=>{
    const root=safeXml(files[name].toString('utf8'));
    return leaf(child(child(root,CAC_NS,'DocumentResponse'),CAC_NS,'Response'),CBC_NS,'ResponseCode',10)!=='0';
  }))throw Error('Resultado resumen/miembros incompatible');
  return {status:summaryCode==='0'?'ACCEPTED' as const:'REJECTED' as const,responseCode:summaryCode,zipSha256:productionBatchesHash(zip),files,hashes};
}
