"use client";
import {useState} from 'react';
import {useResource,useWorkspace} from './provider';
import {ErrorState,Loading} from './common';
import {Button} from '@factuez/ui/components/button';
import {Input} from '@factuez/ui/components/input';
import {Label} from '@factuez/ui/components/label';
import {Card,CardContent,CardHeader,CardTitle,CardDescription} from '@factuez/ui/components/card';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter} from '@factuez/ui/components/dialog';
const legacyConfirmation='AUTORIZAR NOTAS REALES 07 Y 08 SOBRE FACTURA 01';
const extendedProfile='07-08-ON-01-03-PEN-0101-IGV18-v2';
const extendedConfirmation='AUTORIZAR NOTAS REALES 07 Y 08 SOBRE FACTURAS Y BOLETAS';
type Grant={issuerRuc:string;profile:string;version:number;credentialRevision:number;serverEnabled:boolean;enabled:boolean;supportedDocumentTypes:string[]};
export function ProductionNotesActivation({companyId}:{companyId:number}){
 const {api,catalog,user,can}=useWorkspace(),company=catalog?.companies.find(c=>c.id===companyId);
 const path=`/api/v1/setup/sunat/${companyId}/PRODUCTION/notes/authorization`,resource=useResource<Grant>(path);
 const [extended,setExtended]=useState(false);const confirmation=extended?extendedConfirmation:legacyConfirmation;
 const [open,setOpen]=useState(false),[text,setText]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[message,setMessage]=useState<string>();
 if(user?.scope.kind!=='GLOBAL'||!user.roles.includes('ADMIN')||!can('sunat.configure'))return null;
 const grant=resource.data,valid=Boolean(company&&grant&&company.ruc===grant.issuerRuc),canEnable=valid&&grant?.serverEnabled&&company?.environment==='PRODUCTION';
 async function save(enabled:boolean){
  if(!grant||!valid||busy||enabled&&(!canEnable||text!==confirmation))return;setBusy(true);setError(undefined);setMessage(undefined);
  try{await api(path,{method:'POST',body:JSON.stringify({enabled,expectedVersion:grant.version,expectedRevision:grant.credentialRevision,...(enabled?{authorizedDocumentTypes:['07','08'],confirmation:text,...(extended?{profile:extendedProfile}:{})}:{})})});setOpen(false);setText('');setMessage(enabled?'Autorización de notas registrada para esta revisión.':'Autorización de notas suspendida.');resource.reload();}
  catch(e){setError(e instanceof Error?e.message:'No se pudo actualizar la autorización.');resource.reload();}finally{setBusy(false);}
 }
 return <Card className="mb-6 shadow-none"><CardHeader><CardTitle>Autorización de notas de crédito y débito</CardTitle><CardDescription>Perfil separado para anulación total 07/01 y aumento de precio 08/02 sobre una factura 01 propia aceptada. El perfil ampliado añade motivos y notas sobre boletas; requiere una nueva confirmación.</CardDescription></CardHeader><CardContent className="space-y-4">
 {resource.error?<ErrorState message={resource.error} retry={resource.reload}/>:!grant?<Loading/>:<><p className="text-sm">RUC {grant.issuerRuc} · Revisión fiscal {grant.credentialRevision} · Autorización {grant.version}</p><p className="text-sm">{grant.enabled&&valid?'Envío de notas autorizado para esta revisión.':grant.serverEnabled?'Sin autorización vigente de notas para este emisor.':'Notas productivas no habilitadas en este servidor.'}</p>
 <div className="space-y-2"><Label className="flex gap-2 items-center"><input type="checkbox" checked={extended} disabled={busy} onChange={e=>{setExtended(e.target.checked);setText('');}}/>Autorizar perfil ampliado para facturas y boletas</Label></div><div className="flex flex-wrap gap-3"><Button disabled={busy||!canEnable||(grant.enabled&&(!extended||grant.profile===extendedProfile))} onClick={()=>{setOpen(true);setText('');}}>Autorizar notas 07 y 08</Button><Button variant="outline" disabled={busy||!valid||!grant.enabled} onClick={()=>void save(false)}>Suspender notas</Button></div></>}
 {message&&<p role="status" className="text-sm">{message}</p>}{error&&<ErrorState message={error}/>}
 <Dialog open={open} onOpenChange={v=>{if(!busy)setOpen(v);}}><DialogContent><DialogHeader><DialogTitle>Autorizar envíos reales de notas</DialogTitle><DialogDescription>RUC {company?.ruc}. Se volverá a verificar el certificado, SOL, confianza y revisión vigentes. Esta autorización no emite una nota por sí sola.</DialogDescription></DialogHeader><Label htmlFor="production-notes-confirm">Escriba: {confirmation}</Label><Input id="production-notes-confirm" value={text} disabled={busy} autoComplete="off" onChange={e=>setText(e.target.value)}/>{error&&<ErrorState message={error}/>}<DialogFooter><Button variant="outline" disabled={busy} onClick={()=>setOpen(false)}>Cancelar</Button><Button disabled={busy||text!==confirmation||!canEnable} onClick={()=>void save(true)}>{busy?'Verificando…':'Confirmar autorización'}</Button></DialogFooter></DialogContent></Dialog>
 </CardContent></Card>;
}
