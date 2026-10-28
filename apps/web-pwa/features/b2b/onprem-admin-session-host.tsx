"use client";
import {useEffect,useState,useSyncExternalStore,type FormEvent} from 'react';
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from '@factuez/ui/components/card';
import {Button} from '@factuez/ui/components/button';
import {Input} from '@factuez/ui/components/input';
import {Label} from '@factuez/ui/components/label';
import {OnpremReadonlyAdminPanel} from './onprem-admin-panel';
import {useWorkspace} from '../workspace/provider';
import {createOnpremBrowserClient,onpremServerState,type OnpremBrowserClient,type OnpremSessionApi} from './onprem-admin-browser-client';
const subscribeNone=()=>()=>{};
/** The selector is explicit build/operator configuration, never inferred from
 * 404/503/SSO failure. The server must separately confirm ONPREM enabled=true. */
export function explicitOnpremProfile(profile:unknown){return profile==='ONPREM';}
export function OnpremWorkspaceAdminHost(){
 const {api}=useWorkspace();return <OnpremAdminSessionHost api={api}/>;
}
export function OnpremAdminSessionHost({api,client:injected}:{api?:OnpremSessionApi;client?:OnpremBrowserClient}={}){
 const [owned,setOwned]=useState<OnpremBrowserClient|null>(null),[password,setPassword]=useState('');
 const client=injected??owned,state=useSyncExternalStore(client?.subscribe??subscribeNone,client?.getSnapshot??(()=>onpremServerState),()=>onpremServerState);
 useEffect(()=>{
  const session=injected??(api?createOnpremBrowserClient(api):null);
  if(!injected)setOwned(session);
  if(session)void session.status().catch(()=>{});
  const logout=()=>{setPassword('');if(session)void session.logout().catch(()=>{}).finally(()=>session.close());};
  window.addEventListener('factuez:workspace-logout',logout);
  return()=>{window.removeEventListener('factuez:workspace-logout',logout);session?.close();};
 },[api,injected]);
 useEffect(()=>{if(state.phase!=='password-required')setPassword('');},[state.phase]);
 async function reauthenticate(event:FormEvent){
  event.preventDefault();if(!client)return;
  const current=password;setPassword('');
  await client.reauthenticate(current).catch(()=>{});
 }
 const authenticated=state.phase==='authenticated'&&client!==null;
 const message=state.phase==='disabled'?'La administración OnPrem no está habilitada en el servidor.':
  state.phase==='checking'?'Verificando el perfil OnPrem del servidor…':
  state.phase==='password-required'?'Confirma tu contraseña actual para administrar accesos SERVICE durante dos minutos.':
  state.phase==='authenticated'?'Contraseña verificada. Cada operación vuelve a comprobar tu sesión y permisos actuales.':
  state.phase==='expired'?'La verificación venció o tu acceso cambió. Verifica el servicio para continuar.':
  state.phase==='closed'?'La sesión de administración está cerrada.':'No se pudo verificar el acceso OnPrem. El panel permanece cerrado.';
 return <div className="space-y-4">
  <Card aria-busy={state.busy}>
   <CardHeader><CardTitle>Integraciones B2B · OnPrem</CardTitle>
    <CardDescription>BETA · configuración local · aplicaciones SERVICE para consultar comprobantes y gestionar webhooks. Verificación con tu sesión actual.</CardDescription></CardHeader>
   <CardContent className="space-y-4">
    <p role={state.error?'alert':'status'} className="text-sm text-muted-foreground">{message}</p>
    {state.phase==='password-required'&&<form onSubmit={reauthenticate} className="max-w-sm space-y-3">
     <Label htmlFor="onprem-b2b-password">Contraseña actual</Label>
     <Input id="onprem-b2b-password" type="password" autoComplete="current-password" value={password} maxLength={256} disabled={state.busy}
      onChange={event=>setPassword(event.target.value)} required/>
     <Button type="submit" disabled={state.busy||!password}>Confirmar contraseña</Button>
    </form>}
    {authenticated?<Button variant="outline" type="button" onClick={()=>{setPassword('');void client.logout().catch(()=>{});}}>Cerrar verificación OnPrem</Button>:
     state.phase!=='closed'&&<Button type="button" variant="outline" disabled={!client||state.busy} onClick={()=>{setPassword('');void client?.status().catch(()=>{});}}>Verificar perfil OnPrem</Button>}
   </CardContent>
  </Card>
  {authenticated&&<OnpremReadonlyAdminPanel client={client}/>}
 </div>;
}
