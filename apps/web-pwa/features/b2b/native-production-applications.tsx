"use client";
import {useEffect,useState} from 'react';
import {Button} from '@factuez/ui/components/button';
import {Input} from '@factuez/ui/components/input';
import {Label} from '@factuez/ui/components/label';
import {Card,CardHeader,CardTitle,CardContent,CardDescription} from '@factuez/ui/components/card';
import {useResource,useWorkspace} from '../workspace/provider';
import {ErrorState,Loading} from '../workspace/common';
import {choiceClass} from '../workspace/tax-policy-admin';
type Binding={ruc:string;branchId:string;pointId:string;series:string};
type Grant={scope:string;binding:Binding};
type Application={id:string;label:string;enabled:boolean;revision:number;grantCount:number};
type Reference={companies:{id:number;ruc:string;legalName:string}[];branches:{id:string;companyId:number;name:string}[];points:{id:string;companyId:number;branchId:string;name:string}[];series:{id:string;companyId:number;emissionPointId:string;series:string;documentType:string}[]};
const base='/api/v1/b2b/production-applications';
const labels:Record<string,string>={'production:documents:read':'Consultar documentos, estados y archivos','production:masters:read':'Consultar maestros para preparar documentos','production:documents:issue:01':'Emitir facturas','production:documents:issue:03':'Emitir boletas','production:notes:issue:07':'Emitir notas de crédito','production:notes:issue:08':'Emitir notas de débito','production:guides:issue:09':'Emitir guías remitente','production:guides:issue:31':'Emitir guías transportista'};
function issueScope(type:string,series:string){return type==='INVOICE'?'production:documents:issue:01':type==='SALES_RECEIPT'?'production:documents:issue:03':type==='CREDIT_NOTE'?'production:notes:issue:07':type==='DEBIT_NOTE'?'production:notes:issue:08':type==='DESPATCH_ADVICE'?(series.startsWith('V')?'production:guides:issue:31':'production:guides:issue:09'):'';}
export function NativeProductionApplications(){
 const {api,setDirty}=useWorkspace(),[after,setAfter]=useState(''),list=useResource<{items:Application[];nextAfter:string|null}>(base+(after?'?after='+after:'')),reference=useResource<Reference>(base+'/reference');
 const [dirty,markDirty]=useState(false);
 const [label,setLabel]=useState(''),[grants,setGrants]=useState<Grant[]>([]),[edit,setEdit]=useState<{id:string;revision:number;enabled:boolean}>(),[selected,setSelected]=useState(''),[ruc,setRuc]=useState(''),[branch,setBranch]=useState(''),[point,setPoint]=useState(''),[series,setSeries]=useState(''),[permission,setPermission]=useState('production:masters:read');
 const [busy,setBusy]=useState(false),[error,setError]=useState<string>(),[notice,setNotice]=useState<string>(),[secret,setSecret]=useState<{clientId:string;clientSecret:string}>();
 useEffect(()=>{setDirty(!!secret||dirty);return()=>setDirty(false);},[secret,dirty,setDirty]);
 const ref=reference.data,company=ref?.companies.find(c=>c.ruc===ruc),points=ref?.points.filter(p=>p.companyId===company?.id&&p.branchId===branch)??[],counter=ref?.series.find(s=>s.emissionPointId===point&&s.series===series);
 function add(){if(!counter||!company||!branch||!point)return;const grant={scope:permission,binding:{ruc,branchId:branch,pointId:point,series}};if(!grants.some(g=>JSON.stringify(g)===JSON.stringify(grant))){setGrants([...grants,grant]);markDirty(true);}setError(undefined);}
 async function load(id:string){if(!id)return;setBusy(true);setError(undefined);setSecret(undefined);try{const app=await api<{clientId:string;label:string;revision:number;enabled:boolean;grants:Grant[]}>(base+'/'+id);setEdit({id:app.clientId,revision:app.revision,enabled:app.enabled});setLabel(app.label);setGrants(app.grants);markDirty(false);}catch(e){setError(e instanceof Error?e.message:'No se pudo cargar la aplicación.');}finally{setBusy(false);}}
 async function save(action:'save'|'rotate'|'revoke'){
  setBusy(true);setError(undefined);setNotice(undefined);setSecret(undefined);
  try{
   if(!edit&&action!=='save')return;
   const result=await api<{clientId:string;revision:number;clientSecret?:string}>(base+(edit?'/'+edit.id:''),{method:edit?'PATCH':'POST',body:JSON.stringify(edit?{revision:edit.revision,enabled:action==='revoke'?false:edit.enabled,grants,rotateSecret:action==='rotate'}:{label,grants})});
   setEdit({id:result.clientId,revision:result.revision,enabled:action==='revoke'?false:edit?.enabled??true});
   if(result.clientSecret)setSecret({clientId:result.clientId,clientSecret:result.clientSecret});
   setNotice(action==='revoke'?'Aplicación suspendida. Sus tokens dejaron de ser válidos.':'Aplicación guardada. Obtenga un token nuevo; los anteriores quedaron revocados.');list.reload();markDirty(false);
  }catch(e){setError(e instanceof Error?e.message:'No se pudo guardar la aplicación.');}finally{setBusy(false);}
 }
 return <Card><CardHeader><CardTitle>Aplicaciones para Producción</CardTitle><CardDescription>Credenciales propias para integrar sus aplicaciones. Los permisos se asignan por RUC, sede, punto y serie. Las credenciales SUNAT se administran por separado.</CardDescription></CardHeader><CardContent className="space-y-5">
 {list.error?<ErrorState message={list.error} retry={list.reload}/>:!list.data?<Loading/>:<><div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]"><select aria-label="Aplicación registrada" className={choiceClass} value={selected} onChange={e=>{setSelected(e.target.value);void load(e.target.value);}}><option value="">Seleccione una aplicación</option>{list.data.items.map(a=><option key={a.id} value={a.id}>{a.label} · {a.enabled?'activa':'suspendida'} · revisión {a.revision}</option>)}</select><Button variant="outline" onClick={()=>{setEdit(undefined);setSelected('');setLabel('');setGrants([]);setSecret(undefined);markDirty(false);}}>Nueva aplicación</Button><Button variant="outline" onClick={()=>{setAfter('');list.reload();}}>Actualizar</Button></div>{list.data.nextAfter&&<Button variant="outline" onClick={()=>setAfter(list.data!.nextAfter!)}>Más aplicaciones</Button>}</>}
 {reference.error?<ErrorState message={reference.error} retry={reference.reload}/>:!ref?<Loading/>:<>
 <div><Label htmlFor="native-b2b-label">Nombre de la aplicación</Label><Input id="native-b2b-label" maxLength={160} value={label} disabled={!!edit} onChange={e=>{setLabel(e.target.value);markDirty(true);}}/></div>
 <div className="grid gap-3 sm:grid-cols-2"><div><Label htmlFor="native-b2b-ruc">RUC en Producción</Label><select id="native-b2b-ruc" className={choiceClass} value={ruc} onChange={e=>{setRuc(e.target.value);setBranch('');setPoint('');setSeries('');}}><option value="">Seleccione emisor</option>{ref.companies.map(c=><option key={c.id} value={c.ruc}>{c.ruc} · {c.legalName}</option>)}</select></div>
 <div><Label htmlFor="native-b2b-branch">Sede</Label><select id="native-b2b-branch" className={choiceClass} value={branch} onChange={e=>{setBranch(e.target.value);setPoint('');setSeries('');}}><option value="">Seleccione sede</option>{ref.branches.filter(b=>b.companyId===company?.id).map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
 <div><Label htmlFor="native-b2b-point">Punto de emisión</Label><select id="native-b2b-point" className={choiceClass} value={point} onChange={e=>{setPoint(e.target.value);setSeries('');}}><option value="">Seleccione punto</option>{points.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
 <div><Label htmlFor="native-b2b-series">Serie</Label><select id="native-b2b-series" className={choiceClass} value={series} onChange={e=>{setSeries(e.target.value);setPermission('production:masters:read');}}><option value="">Seleccione serie</option>{ref.series.filter(s=>s.emissionPointId===point).map(s=><option key={s.id} value={s.series}>{s.series}</option>)}</select></div>
 <div><Label htmlFor="native-b2b-permission">Permiso</Label><select id="native-b2b-permission" className={choiceClass} value={permission} onChange={e=>setPermission(e.target.value)}>{['production:masters:read','production:documents:read',...(counter?[issueScope(counter.documentType,counter.series)]:[])].filter(Boolean).map(s=><option key={s} value={s}>{labels[s]}</option>)}</select></div><Button disabled={!counter||busy} onClick={add} variant="outline">Añadir permiso a esta serie</Button></div>
 <p className="text-sm text-muted-foreground">Añada consulta de maestros y emisión a la serie correspondiente. Para estado y archivos, añada consulta de documentos. Las notas requieren también consulta sobre la serie del comprobante original. Las guías requieren una concesión adicional en su módulo.</p>
 <ul className="space-y-2">{grants.map((g,i)=><li key={JSON.stringify(g)} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"><span>{g.binding.ruc} · {ref.branches.find(b=>b.id===g.binding.branchId)?.name??g.binding.branchId} · {ref.points.find(p=>p.id===g.binding.pointId)?.name??g.binding.pointId} · {g.binding.series}<br/>{labels[g.scope]??g.scope}</span><Button size="sm" variant="outline" onClick={()=>{setGrants(grants.filter((_,j)=>j!==i));markDirty(true);}}>Quitar permiso</Button></li>)}</ul>
 {edit&&<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.enabled} onChange={e=>{setEdit({...edit,enabled:e.target.checked});markDirty(true);}}/>Aplicación activa</label>}
 <div className="flex flex-wrap gap-3"><Button disabled={busy||!grants.length||!label.trim()} onClick={()=>void save('save')}>Guardar aplicación</Button>{edit&&<><Button disabled={busy} variant="outline" onClick={()=>void save('rotate')}>Generar nuevo secreto</Button><Button disabled={busy||!edit.enabled} variant="outline" onClick={()=>void save('revoke')}>Suspender acceso</Button></>}</div></>}
 {error&&<ErrorState message={error}/>} {notice&&<p role="status" className="text-sm">{notice}</p>}
 {secret&&<div role="status" className="space-y-3 rounded-lg border border-amber-400 bg-amber-50 p-4 text-slate-950"><p className="font-medium">Guarde este secreto ahora. Se muestra una sola vez.</p><p>Client ID: <code className="break-all select-all">{secret.clientId}</code></p><p>Client Secret: <code className="break-all select-all">{secret.clientSecret}</code></p><p className="text-sm">Token: POST /b2b/oauth/token · Consultas: GET /b2b/v1 · Emisión: POST con Idempotency-Key.</p><Button variant="outline" onClick={()=>setSecret(undefined)}>Ya guardé el secreto</Button></div>}
 <a href="/b2b-api-reference" className="text-sm underline">Documentación y ejemplos de la API de Producción</a>
 </CardContent></Card>;
}
