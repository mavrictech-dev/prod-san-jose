"use client";
import {useState} from 'react';
import {Button} from '@factuez/ui/components/button';
import {Input} from '@factuez/ui/components/input';
import {Label} from '@factuez/ui/components/label';
import {Card,CardContent,CardHeader,CardTitle,CardDescription} from '@factuez/ui/components/card';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter} from '@factuez/ui/components/dialog';
import {useResource,useWorkspace} from './provider';
import {ErrorState,Loading} from './common';
type Readiness={companyId:number;recipientRuc:string;revision:number;ready:boolean;activated:boolean;checks:{database:boolean;encryption:boolean;externalReadAllowed:boolean};reviewVersion:string;validation:null|{id:string;revision:number;createdAt:string;result:{ready:boolean;recipientRuc:string}}};
type Validation={validationId:string;revision:number;recipientRuc:string;ready:boolean;expiresAt:string;mail:string;sire:string};
export function receivedActivationMatches(value:Readiness|undefined,companyId:number,ruc:string){return !!value&&value.companyId===companyId&&value.recipientRuc===ruc&&Number.isSafeInteger(value.revision)&&value.revision>=0&&value.reviewVersion==='RECEIVED_READ_ONLY_V1';}
export function receivedActivationCommand(status:Readiness,ruc:string,validation:Validation|undefined,confirmation:string){
 const id=validation?.validationId??status.validation?.id;
 const ok=validation?validation.ready&&validation.revision===status.revision&&validation.recipientRuc===ruc&&Date.parse(validation.expiresAt)>Date.now():status.validation?.result.ready&&status.validation.revision===status.revision&&status.validation.result.recipientRuc===ruc&&Date.now()-Date.parse(status.validation.createdAt)<900000;
 if(!id||!ok||!status.ready||status.recipientRuc!==ruc||confirmation!==ruc||!/^[a-f0-9-]{36}$/i.test(id))throw Error('Valide la conexión vigente y confirme el RUC.');
 return{expectedRevision:status.revision,recipientRuc:ruc,validationId:id,confirmation,reviewVersion:status.reviewVersion};
}
export function ReceivedProductionActivation({companyId,ruc,disabled=false,onChanged}:{companyId:number;ruc:string;disabled?:boolean;onChanged?:()=>void}){
 const {user,can,api}=useWorkspace();
 if(user?.scope.kind!=='GLOBAL'||!user.roles.includes('ADMIN')||!can('setup.manage'))return null;
 return <ActivationForm key={`${companyId}:${ruc}`} companyId={companyId} ruc={ruc} disabled={disabled} onChanged={onChanged}/>;
}
function ActivationForm({companyId,ruc,disabled,onChanged}:{companyId:number;ruc:string;disabled:boolean;onChanged?:()=>void}){
 const {api}=useWorkspace(),base='/api/v1/received-documents/automation',query=`?companyId=${companyId}`,resource=useResource<Readiness>(base+'/readiness'+query);
 const [busy,setBusy]=useState(false),[open,setOpen]=useState(false),[confirmation,setConfirmation]=useState(''),[validation,setValidation]=useState<Validation>(),[error,setError]=useState<string>();
 const s=resource.data,matches=receivedActivationMatches(s,companyId,ruc),locked=disabled||busy||!matches||!s?.ready;
 async function validate(){if(locked||!s)return;setBusy(true);setError(undefined);setValidation(undefined);try{const v=await api<Validation>(base+'/validate'+query,{method:'POST',body:JSON.stringify({expectedRevision:s.revision,recipientRuc:ruc}),signal:AbortSignal.timeout(60000)});if(v.recipientRuc!==ruc||v.revision!==s.revision)throw Error('La validación corresponde a otra revisión.');setValidation(v);resource.reload();}catch(e){setError(e instanceof Error?e.message:'No se pudo validar la conexión.');}finally{setBusy(false);}}
 async function activate(){if(locked||!s)return;setBusy(true);setError(undefined);try{const body=receivedActivationCommand(s,ruc,validation,confirmation);await api(base+'/activate'+query,{method:'POST',body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});setOpen(false);setConfirmation('');resource.reload();onChanged?.();}catch(e){setError(e instanceof Error?e.message:'No se pudo activar la recepción.');resource.reload();}finally{setBusy(false);}}
 const validated=matches&&(validation?.ready&&validation.revision===s!.revision||s?.validation?.result.ready&&s.validation.revision===s.revision);
 return <Card className="shadow-none"><CardHeader><CardTitle>Conectar recepción automática</CardTitle><CardDescription>Guarde la configuración, valide las conexiones y autorice la lectura para este RUC. Guardar no activa la automatización.</CardDescription></CardHeader><CardContent className="space-y-4">
 {resource.error?<ErrorState message={resource.error} retry={resource.reload}/>:!s?<Loading/>:!matches?<ErrorState message="La preparación no corresponde al emisor seleccionado."/>:<><p className="text-sm">RUC {ruc} · Revisión {s.revision} · {s.activated?'Lectura autorizada':'Sin activar'}</p><p className="text-sm text-muted-foreground">Base: {s.checks.database?'preparada':'pendiente'} · Cifrado: {s.checks.encryption?'preparado':'pendiente'} · Lectura externa del servidor: {s.checks.externalReadAllowed?'habilitada':'deshabilitada'}</p>
 {validation&&<p role="status" className="text-sm">Correo: {validation.mail} · SIRE: {validation.sire} · {validation.ready?'Conexión validada':'Revise configuración y credenciales'}</p>}
 <p className="text-sm text-muted-foreground">SIRE descubre compras y totales; el XML completo y su detalle se reciben de los proveedores por correo. No presenta ni acepta registros SIRE y no emite comprobantes.</p>
 <div className="flex flex-wrap gap-3"><Button variant="outline" disabled={locked||s.revision<1} onClick={()=>void validate()}>{busy?'Procesando…':'Validar conexiones guardadas'}</Button><Button disabled={locked||!validated||s.activated} onClick={()=>{setOpen(true);setConfirmation('');}}>Autorizar lectura automática</Button><Button variant="outline" disabled={busy} onClick={resource.reload}>Consultar preparación</Button></div></>}
 {disabled&&<p className="text-xs text-muted-foreground">Guarde o descarte los cambios antes de validar o activar.</p>}{error&&<ErrorState message={error}/>}
 <Dialog open={open} onOpenChange={v=>{if(!busy)setOpen(v);}}><DialogContent><DialogHeader><DialogTitle>Autorizar recepción para RUC {ruc}</DialogTitle><DialogDescription>Autorizo la consulta periódica de compras y del buzón configurado. No se envían comprobantes ni se presentan libros. Una modificación de configuración requiere nueva validación y autorización.</DialogDescription></DialogHeader><Label htmlFor="received-production-ruc">Escriba el RUC para confirmar</Label><Input id="received-production-ruc" value={confirmation} autoComplete="off" disabled={busy} onChange={e=>setConfirmation(e.target.value)}/>{error&&<ErrorState message={error}/>}<DialogFooter><Button variant="outline" disabled={busy} onClick={()=>setOpen(false)}>Cancelar</Button><Button disabled={locked||confirmation!==ruc} onClick={()=>void activate()}>Confirmar lectura automática</Button></DialogFooter></DialogContent></Dialog>
 </CardContent></Card>;
}
