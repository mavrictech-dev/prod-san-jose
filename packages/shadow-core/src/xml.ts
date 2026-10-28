import { createHash } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import type { HistoricalDocumentSnapshotV1 } from '@factuez/history-core';

export class ShadowError extends Error {
  constructor(readonly code:string){super(`Modo sombra aislado: ${code}`);delete this.stack;}
}
export function shadowAssert(ok:unknown,code:string):asserts ok{if(!ok)throw new ShadowError(code);}
export const CBC='urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
export const EXT='urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';
const DS='http://www.w3.org/2000/09/xmldsig#',XMLNS='http://www.w3.org/2000/xmlns/';
export const byteSha=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
export function limaDay(issueDate:string){
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Lima',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(issueDate));
}

/** Structural diagnostic, NOT C14N, signature verification, XSD or SUNAT acceptance.
 * Only a signature in the expected UBL extension is omitted. Fiscal IDs/dates remain.
 * No XML entities, DTD, processing instructions, comments or CDATA are accepted.
 */
export function inspectShadowXml(xml:string,snapshot:HistoricalDocumentSnapshotV1){
  shadowAssert(typeof xml==='string'&&xml.length>0&&xml.length<=16000&&Buffer.byteLength(xml)<=64000&&
    !/<!|<\?(?!xml\s)/i.test(xml)&&
    !/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(xml),'SHADOW_XML_INVALID');
  try{
    const doc=new DOMParser({onError:()=>{throw new ShadowError('SHADOW_XML_INVALID');}}).parseFromString(xml,'application/xml');
    const root=doc.documentElement,type=snapshot.ownership.documentTypeCode;
    const kind=type==='07'?'CreditNote':type==='08'?'DebitNote':'Invoice';
    shadowAssert(root&&root.localName===kind&&root.namespaceURI===`urn:oasis:names:specification:ubl:schema:xsd:${kind}-2`&&
      doc.getElementsByTagNameNS(root.namespaceURI,kind).length===1,'SHADOW_XML_ROOT_INVALID');
    let roots=0;
    for(let n=doc.firstChild;n;n=n.nextSibling){
      if(n.nodeType===1)roots++;
      else shadowAssert(n.nodeType===3&&!n.textContent?.trim()||n.nodeType===7&&n.nodeName==='xml','SHADOW_XML_INVALID');
    }
    shadowAssert(roots===1,'SHADOW_XML_INVALID');
    const signatures=doc.getElementsByTagNameNS(DS,'Signature');
    shadowAssert(signatures.length<=1,'SHADOW_XML_SIGNATURE_AMBIGUOUS');
    const signature=signatures[0]??null;
    if(signature){
      const chain=['ExtensionContent','UBLExtension','UBLExtensions'];let n=signature.parentNode;
      for(const name of chain){shadowAssert(n?.nodeType===1&&n.namespaceURI===EXT&&n.localName===name,'SHADOW_XML_SIGNATURE_LOCATION');n=n.parentNode;}
      shadowAssert(n===root,'SHADOW_XML_SIGNATURE_LOCATION');
    }
    type El=NonNullable<typeof root>;
    const tokens:unknown[]=[],ids=new Set<string>();let count=0;
    function walk(el:El,depth:number){
      shadowAssert(++count<=2000&&depth<=32,'SHADOW_XML_LIMIT');
      const attributes:Array<[string,string,string]>=[];
      for(let i=0;i<el.attributes.length;i++){
        const a=el.attributes.item(i)!;
        if(['id','Id','ID'].includes(a.localName!)){
          shadowAssert(a.value.length>0&&!ids.has(a.value),'SHADOW_XML_DUPLICATE_ID');ids.add(a.value);
        }
        if(a.namespaceURI!==XMLNS)attributes.push([a.namespaceURI??'',a.localName??a.name,a.value]);
      }
      if(el.namespaceURI===DS)shadowAssert(el===signature||signature?.contains(el),'SHADOW_XML_SIGNATURE_LOCATION');
      // Traverse omitted signature too: complexity/duplicate-ID limits still apply.
      if(el===signature){
        function inspectOmitted(node:El,d:number){
          for(let n=node.firstChild;n;n=n.nextSibling)if(n.nodeType===1){
            const child=n as El;shadowAssert(++count<=2000&&d+1<=32,'SHADOW_XML_LIMIT');
            for(let i=0;i<child.attributes.length;i++){const a=child.attributes.item(i)!;
              if(['id','Id','ID'].includes(a.localName!)){shadowAssert(a.value.length>0&&!ids.has(a.value),'SHADOW_XML_DUPLICATE_ID');ids.add(a.value);}}
            inspectOmitted(child,d+1);
          }
        }
        inspectOmitted(el,depth);return;
      }
      attributes.sort((a,b)=>JSON.stringify(a.slice(0,2)).localeCompare(JSON.stringify(b.slice(0,2))));
      tokens.push(['OPEN',el.namespaceURI??'',el.localName,attributes]);
      let elements=0;
      for(let n=el.firstChild;n;n=n.nextSibling)if(n.nodeType===1&&n!==signature)elements++;
      for(let n=el.firstChild;n;n=n.nextSibling){
        if(n.nodeType===1)walk(n as El,depth+1);
        else if(n.nodeType===3){
          const value=n.textContent??'';
          if(value.trim()||!elements&&el.namespaceURI!==EXT)tokens.push(['TEXT',value]);
        }else throw new ShadowError('SHADOW_XML_INVALID');
      }
      tokens.push(['CLOSE',el.namespaceURI??'',el.localName]);
    }
    walk(root,1);
    const headerRoot=root;
    function leaf(name:string){
      const nodes=[];
      for(let n=headerRoot.firstChild;n;n=n.nextSibling)if(n.nodeType===1&&n.namespaceURI===CBC&&n.localName===name)nodes.push(n);
      shadowAssert(nodes.length===1,'SHADOW_XML_HEADER_INVALID');
      for(let n=nodes[0].firstChild;n;n=n.nextSibling)shadowAssert(n.nodeType===3,'SHADOW_XML_HEADER_INVALID');
      return nodes[0].textContent??'';
    }
    let digestValue:string|null=null;
    if(signature){
      const digests=signature.getElementsByTagNameNS(DS,'DigestValue');
      shadowAssert(digests.length===1,'SHADOW_XML_SIGNATURE_AMBIGUOUS');
      digestValue=digests[0].textContent??'';
      shadowAssert(/^[A-Za-z0-9+/]{43}=$/.test(digestValue)&&Buffer.from(digestValue,'base64').toString('base64')===digestValue,'SHADOW_DIGEST_INVALID');
    }
    return {rawSha256:byteSha(xml),structuralSha256:byteSha(JSON.stringify(tokens)),
      signatureExcluded:signature!==null,digestValue,signatureVerified:false as const,
      header:{fullNumber:leaf('ID'),issueDate:leaf('IssueDate'),currencyCode:leaf('DocumentCurrencyCode'),
        documentTypeCode:kind==='Invoice'?leaf('InvoiceTypeCode'):type}};
  }catch(error){throw error instanceof ShadowError?error:new ShadowError('SHADOW_XML_INVALID');}
}
