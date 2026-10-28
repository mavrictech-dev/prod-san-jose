"use client";
import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@factuez/ui/components/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@factuez/ui/components/card';
import { useWorkspace } from './provider';
import { ErrorState } from './common';
const formats=[['xml','XML firmado','application/xml'],['cdr-xml','CDR XML','application/xml'],['cdr-zip','CDR ZIP','application/zip'],['submission-zip','ZIP enviado','application/zip']] as const;
export function FiscalOriginals({documentId,fileNumber}:{documentId:string;fileNumber:string}){
 const {apiBlob}=useWorkspace();const [busy,setBusy]=useState<string>(),[error,setError]=useState<string>();const active=useRef<AbortController|null>(null);
 useEffect(()=>()=>active.current?.abort(),[documentId]);
 async function download(kind:typeof formats[number][0],media:typeof formats[number][2]){
  if(busy)return;const abort=new AbortController();active.current=abort;setBusy(kind);setError(undefined);
  try{
   const blob=await apiBlob(`/api/v1/fiscal-artifacts/${documentId}/original/${kind}`,AbortSignal.any([abort.signal,AbortSignal.timeout(20000)]),media);
   if(abort.signal.aborted)return;
   const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;
   link.download=blob instanceof File?blob.name:`${kind.startsWith('cdr')?'R-':''}${fileNumber}.${media==='application/zip'?'zip':'xml'}`;
   document.body.appendChild(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),60000);
  }catch(reason){if(!abort.signal.aborted)setError(reason instanceof Error?reason.message:'No se pudo descargar el original');}
  finally{if(!abort.signal.aborted)setBusy(undefined);}
 }
 return <Card className="mb-6 shadow-none"><CardHeader><CardTitle>Archivos originales</CardTitle><CardDescription>XML firmado y archivos originales. En boletas, el CDR y el paquete enviado corresponden a su resumen RC.</CardDescription></CardHeader>
  <CardContent className="space-y-3"><div className="flex flex-wrap gap-2">{formats.map(([kind,label,media])=><Button key={kind} variant="outline" disabled={Boolean(busy)} onClick={()=>void download(kind,media)}><Download className="size-4"/>{busy===kind?'Preparando…':label}</Button>)}</div>{error&&<ErrorState message={error}/>}</CardContent></Card>;
}
