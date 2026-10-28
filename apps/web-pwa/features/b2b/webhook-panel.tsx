"use client";
import {useEffect,useRef,useState} from 'react';
import {Badge} from '@factuez/ui/components/badge';
import {Button} from '@factuez/ui/components/button';
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from '@factuez/ui/components/card';
import {Dialog,DialogContent,DialogDescription,DialogFooter,DialogHeader,DialogTitle} from '@factuez/ui/components/dialog';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@factuez/ui/components/table';
import {RefreshCw,Eye,RotateCcw} from 'lucide-react';
export const webhookStateLabels:Record<string,string>={PENDING:'Pendiente',RUNNING:'Enviando',RETRY:'Reintento programado',DELIVERED:'Notificado',DEAD_LETTER:'Requiere revisión',CANCELLED:'Bloqueado'};
interface Subscription {id:string;label:string;revision:string;verified:boolean;enabled:boolean;destinationId:string}
interface Delivery {id:string;subscriptionId:string;eventId:string;state:string;attempts:number;round:number;nextAttemptAt:string|null;lastCode:string|null;statusCode:number|null}
interface Page<T>{items:T[];page:{hasMore:boolean;nextCursor:string|null}}
export interface WebhookPanelClient {request<T>(path:string,init?:{method?:string;body?:unknown;headers?:Record<string,string>}):Promise<T>}
/** Candidate integrable panel. Inject an authorized B2B/BFF client, NEVER the PWA session cookie. */
export function WebhookPanel({issuerId,client}:{issuerId:number;client:WebhookPanelClient}){
  const [subscriptions,setSubscriptions]=useState<Subscription[]>([]),[rows,setRows]=useState<Delivery[]>([]),[next,setNext]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [detail,setDetail]=useState<any>(null),[replay,setReplay]=useState<{delivery:Delivery;key:string}|null>(null);const generation=useRef(0);
  const query='?issuerId='+issuerId+'&environment=BETA';
  async function load(after?:string){const current=++generation.current;setBusy(true);setError('');try{
    const [s,d]=await Promise.all([client.request<Page<Subscription>>('/b2b/v1/webhook-subscriptions'+query),client.request<Page<Delivery>>('/b2b/v1/webhook-deliveries'+query+(after?'&after='+after:''))]);
    if(current!==generation.current)return;setSubscriptions(s.items);setRows(old=>after?[...old,...d.items]:d.items);setNext(d.page.nextCursor);if(s.page.hasMore)setError('Hay más suscripciones; el detalle mantiene la autorización completa en el servidor.');
  }catch{if(current===generation.current)setError('No se pudo consultar el servicio. Comprueba la conexión y los permisos B2B.');}finally{if(current===generation.current)setBusy(false);}}
  useEffect(()=>{setRows([]);setDetail(null);setReplay(null);void load();return()=>{generation.current++;};},[issuerId,client]);
  async function inspect(d:Delivery){const current=generation.current;setBusy(true);setError('');try{const value=await client.request<any>('/b2b/v1/webhook-deliveries/'+d.id+query);if(current===generation.current)setDetail(value);}catch{if(current===generation.current)setError('No se pudo consultar el intento.');}finally{if(current===generation.current)setBusy(false);}}
  async function resend(){if(!replay)return;const sub=subscriptions.find(s=>s.id===replay.delivery.subscriptionId);if(!sub)return;const current=generation.current;setBusy(true);setError('');try{
    await client.request('/b2b/v1/webhook-deliveries/'+replay.delivery.id+'/replay'+query,{method:'POST',body:{},headers:{'Idempotency-Key':replay.key,'If-Match':sub.revision}});if(current!==generation.current)return;setReplay(null);await load();
  }catch{if(current===generation.current)setError('No se autorizó el reenvío o cambió la suscripción. Actualiza antes de volver a intentarlo.');}finally{if(current===generation.current)setBusy(false);}}
  return <section aria-label="Entregas de webhooks" className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold tracking-tight">Notificaciones a integraciones</h2><p className="mt-1 text-sm text-muted-foreground">Emisor {issuerId} · BETA. Notificar al receptor no significa aceptación de SUNAT.</p></div>
      <Button variant="outline" disabled={busy} onClick={()=>void load()}><RefreshCw className="mr-2 size-4"/>Actualizar</Button></div>
    {error&&<p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    <Card><CardHeader><CardTitle>Destinos de esta integración</CardTitle><CardDescription>Direcciones aprobadas por TI. Las claves de firma nunca se muestran en este panel.</CardDescription></CardHeader><CardContent>
      {!subscriptions.length?<p className="text-sm text-muted-foreground">{busy?'Consultando destinos…':'No hay suscripciones autorizadas para este emisor.'}</p>:<div className="grid gap-3 sm:grid-cols-2">{subscriptions.map(s=><div key={s.id} className="rounded-lg border p-4"><p className="font-medium">{s.label}</p><p className="mt-1 break-all text-xs text-muted-foreground">{s.destinationId}</p><Badge variant="outline" className="mt-3">{!s.enabled?'Desactivado':s.verified?'Verificado':'Pendiente de verificar'}</Badge></div>)}</div>}
    </CardContent></Card>
    <Card><CardHeader><CardTitle>Historial de entregas</CardTitle><CardDescription>Eventos de emisión local 01/03. Cada intento conserva la misma entrega lógica.</CardDescription></CardHeader><CardContent>
      <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Entrega / evento</TableHead><TableHead>Estado</TableHead><TableHead>Intentos</TableHead><TableHead className="text-right">Acciones</TableHead></TableRow></TableHeader><TableBody>
        {!rows.length?<TableRow><TableCell colSpan={4} className="py-10 text-center text-muted-foreground">{busy?'Consultando entregas…':'No hay entregas en este alcance.'}</TableCell></TableRow>:rows.map(d=>{const s=subscriptions.find(s=>s.id===d.subscriptionId);return <TableRow key={d.id}><TableCell><p className="font-mono text-xs">{d.id}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{d.eventId}</p></TableCell><TableCell><Badge variant="outline">{webhookStateLabels[d.state]??'Estado no reconocido'}</Badge>{d.nextAttemptAt&&<p className="mt-1 text-xs text-muted-foreground">{new Date(d.nextAttemptAt).toLocaleString('es-PE',{timeZone:'America/Lima'})}</p>}</TableCell><TableCell>{d.attempts} / 8</TableCell><TableCell className="space-x-2 text-right"><Button size="sm" variant="ghost" disabled={busy} onClick={()=>void inspect(d)} aria-label="Ver intentos"><Eye className="size-4"/></Button>{['DEAD_LETTER','CANCELLED'].includes(d.state)&&<Button size="sm" variant="outline" disabled={busy||!s?.verified||!s.enabled} onClick={()=>setReplay({delivery:d,key:crypto.randomUUID()})}><RotateCcw className="mr-2 size-4"/>Reenviar</Button>}</TableCell></TableRow>;})}
      </TableBody></Table></div>{next&&<Button variant="outline" className="mt-4" disabled={busy} onClick={()=>void load(next)}>Cargar más</Button>}
    </CardContent></Card>
    <Dialog open={!!detail} onOpenChange={open=>{if(!open)setDetail(null);}}><DialogContent><DialogHeader><DialogTitle>Intentos de notificación</DialogTitle><DialogDescription>Las respuestas HTTP no acreditan un estado tributario.</DialogDescription></DialogHeader><div className="max-h-80 overflow-auto space-y-3">{detail?.history?.map((a:any)=><div key={a.id} className="rounded-lg border p-3 text-sm"><p>Intento {a.number} · Ronda {a.round}</p><p className="mt-1 break-all text-xs text-muted-foreground">{a.code} · HTTP {a.status??'sin respuesta'}</p></div>)}</div></DialogContent></Dialog>
    <Dialog open={!!replay} onOpenChange={open=>{if(!open&&!busy)setReplay(null);}}><DialogContent><DialogHeader><DialogTitle>Confirmar reenvío</DialogTitle><DialogDescription>El receptor puede haber procesado este evento. El reenvío conserva su identidad y necesita permisos vigentes.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={busy} onClick={()=>setReplay(null)}>Cancelar</Button><Button disabled={busy} onClick={()=>void resend()}>Solicitar reenvío</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
