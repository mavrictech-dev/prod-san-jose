"use client";
import {useEffect,useMemo,useState,useSyncExternalStore,type FormEvent} from 'react';
import {Button} from '@factuez/ui/components/button';
import {Input} from '@factuez/ui/components/input';
import {Label} from '@factuez/ui/components/label';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter} from '@factuez/ui/components/dialog';
import {IntegrationAdminController,integrationAdminInputError,type IntegrationAdminCommand,type IntegrationAdminCreate,type IntegrationAdminClient} from './integration-admin-model';
import {IntegrationAdminBindings} from './integration-admin-panel';
import {createIntegrationAdminPort,type AuthorizedAdminHttpClient} from './integration-admin-remote';
import {onpremReadonlyScopes} from './onprem-admin-browser-client';
type Modal={kind:'edit';client?:IntegrationAdminClient}|{kind:'confirm';command:IntegrationAdminCommand}|{kind:'secret';secret:string};
const blank=()=>({issuerId:'',issuerRuc:'',branchId:'',pointId:'',seriesId:'',documentType:'01' as '01'|'03'});
/** Restricted OnPrem editor. The OIDC/full-scope editor is kept unchanged. */
export function OnpremReadonlyEditor({client,onPrepare,onCancel}:{client?:IntegrationAdminClient;onPrepare:(input:IntegrationAdminCreate)=>void;onCancel:()=>void}){
 const [label,setLabel]=useState(client?.label??''),[scopes,setScopes]=useState<string[]>(client?.scopes??['b2b:context:read','b2b:catalog:read']);
 const [rows,setRows]=useState(()=>client?.bindings.map(b=>({...b,issuerId:String(b.issuerId)}))??[blank()]),[error,setError]=useState('');
 function submit(event:FormEvent){
  event.preventDefault();const input:IntegrationAdminCreate={label:label.trim(),kind:'SERVICE',scopes,
   bindings:rows.map(b=>({issuerId:Number(b.issuerId),issuerRuc:b.issuerRuc,branchId:b.branchId,pointId:b.pointId,seriesId:b.seriesId,documentType:b.documentType,environment:'BETA'}))};
  const invalid=integrationAdminInputError(input);setError(invalid??'');if(!invalid)onPrepare(input);
 }
 return <form onSubmit={submit} className="space-y-4">
  {error&&<p role="alert">{error}</p>}
  <Label htmlFor="onprem-client-label">Nombre de la aplicación SERVICE</Label><Input id="onprem-client-label" value={label} maxLength={120} required disabled={!!client} onChange={e=>setLabel(e.target.value)}/>
  <fieldset className="space-y-2"><legend>Permisos de lectura y webhooks</legend>{onpremReadonlyScopes.map(scope=><label key={scope} className="flex gap-2 text-sm">
   <input type="checkbox" checked={scopes.includes(scope)} onChange={e=>setScopes(old=>e.target.checked?[...old,scope]:old.filter(s=>s!==scope))}/>{scope}
  </label>)}</fieldset>
  <p className="text-sm text-muted-foreground">BETA · tipos 01 y 03. El servidor comprueba que emisor, sede, punto y serie estén activos.</p>
  {rows.map((row,index)=><fieldset key={index} className="grid gap-3 rounded border p-3 sm:grid-cols-2"><legend>Alcance {index+1}</legend>
   {([['issuerId','Emisor (ID)'],['issuerRuc','RUC'],['branchId','Sede (ID)'],['pointId','Punto (ID)'],['seriesId','Serie (ID)']] as const).map(([key,title])=><label key={key} className="space-y-1 text-sm">{title}
    <Input value={row[key]} required autoComplete="off" maxLength={key==='issuerRuc'?11:36} onChange={e=>setRows(old=>old.map((b,i)=>i===index?{...b,[key]:e.target.value.trim()}:b))}/>
   </label>)}
   <label className="text-sm">Tipo<select value={row.documentType} onChange={e=>setRows(old=>old.map((b,i)=>i===index?{...b,documentType:e.target.value as '01'|'03'}:b))} className="block w-full rounded border bg-background p-2"><option value="01">Factura (01)</option><option value="03">Boleta (03)</option></select></label>
   <Button type="button" variant="outline" disabled={rows.length===1} onClick={()=>setRows(old=>old.filter((_b,i)=>i!==index))}>Quitar alcance</Button>
  </fieldset>)}
  <Button type="button" variant="outline" disabled={rows.length>=500} onClick={()=>setRows(old=>[...old,blank()])}>Añadir alcance</Button>
  <DialogFooter><Button type="button" variant="outline" onClick={onCancel}>Cancelar</Button><Button type="submit">Revisar y confirmar</Button></DialogFooter>
 </form>;
}
export function OnpremReadonlyAdminPanel({client}:{client:AuthorizedAdminHttpClient}){
 const controller=useMemo(()=>new IntegrationAdminController(createIntegrationAdminPort(client)),[client]);
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot),[modal,setModal]=useState<Modal|null>(null);
 useEffect(()=>{controller.start();return()=>controller.dispose();},[controller]);
 function close(){controller.cancelReveal();setModal(null);}
 return <section className="space-y-4" aria-label="Aplicaciones SERVICE de lectura">
  <div className="flex gap-2"><Button variant="outline" disabled={state.loading||!!modal} onClick={()=>void controller.load()}>Actualizar</Button>
   <Button disabled={state.loading||!state.loaded||!!modal} onClick={()=>setModal({kind:'edit'})}>Nueva aplicación SERVICE</Button></div>
  {state.error&&<p role="alert">{state.error}</p>}<p role="status" className="text-sm text-muted-foreground">{state.loading?'Consultando accesos…':state.notice}</p>
  <ul className="divide-y rounded border">{state.items.map(item=><li key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
   <span>{item.label} · {item.enabled?'Habilitada':'Deshabilitada'} · revisión {item.revision}</span><Button type="button" variant="outline" disabled={state.loading||!!modal} onClick={()=>void controller.inspect(item.id)}>Detalle</Button>
  </li>)}</ul>
  {state.hasMore&&<Button variant="outline" disabled={state.loading||!!modal} onClick={()=>void controller.load(true)}>Cargar más</Button>}
  {state.selected&&<div className="space-y-3 rounded border p-3"><h3 className="font-medium">{state.selected.label}</h3><p className="break-all font-mono text-xs">{state.selected.id}</p>
   <p className="text-sm">{state.selected.scopes.join(', ')}</p><IntegrationAdminBindings bindings={state.selected.bindings}/>
   <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={state.loading||!!modal} onClick={()=>setModal({kind:'edit',client:state.selected!})}>Editar permisos y alcances</Button>
    <Button variant="outline" disabled={state.loading||!!modal} onClick={()=>setModal({kind:'confirm',command:{action:'update',id:state.selected!.id,input:{expectedRevision:state.selected!.revision,enabled:!state.selected!.enabled}}})}>{state.selected.enabled?'Desactivar':'Activar'}</Button>
    <Button variant="outline" disabled={state.loading||!!modal} onClick={()=>setModal({kind:'confirm',command:{action:'rotate',id:state.selected!.id,input:{expectedRevision:state.selected!.revision}}})}>Rotar secreto</Button></div>
  </div>}
  <Dialog open={!!modal} onOpenChange={open=>{if(!open)close();}}><DialogContent className="max-h-[85vh] overflow-y-auto">
   <DialogHeader><DialogTitle>{modal?.kind==='secret'?'Secreto de la aplicación':modal?.kind==='confirm'?'Confirmar cambio':'Aplicación SERVICE de lectura'}</DialogTitle>
    <DialogDescription>{modal?.kind==='secret'?'Se muestra una sola vez. Cópialo antes de cerrar.':'BETA. La contraseña y los permisos vigentes se comprueban en el servidor.'}</DialogDescription></DialogHeader>
   {modal?.kind==='edit'&&<OnpremReadonlyEditor client={modal.client} onCancel={close} onPrepare={input=>setModal({kind:'confirm',command:modal.client?{action:'update',id:modal.client.id,input:{expectedRevision:modal.client.revision,scopes:input.scopes,bindings:input.bindings}}:{action:'create',input}})}/>}
   {modal?.kind==='confirm'&&<DialogFooter><Button type="button" variant="outline" onClick={close}>Cancelar</Button><Button type="button" disabled={state.loading} onClick={()=>void controller.confirm(modal.command,secret=>setModal({kind:'secret',secret}),close)}>Confirmar</Button></DialogFooter>}
   {modal?.kind==='secret'&&<><Input aria-label="Secreto de un solo uso" readOnly value={modal.secret} autoComplete="off"/><Button type="button" onClick={close}>Ya lo guardé · cerrar</Button></>}
  </DialogContent></Dialog>
 </section>;
}
