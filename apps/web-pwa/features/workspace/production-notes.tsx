"use client";
import Link from 'next/link';
import {calculateTaxLine,addMoney} from '@factuez/sunat-core/dist/tax';
import {useEffect,useRef,useState} from 'react';
import {ApiError,useResource,useWorkspace} from './provider';
import {ErrorState,Loading,money} from './common';
import {Button} from '@factuez/ui/components/button';
import {Input} from '@factuez/ui/components/input';
import {Label} from '@factuez/ui/components/label';
import {Card,CardContent,CardHeader,CardTitle,CardDescription} from '@factuez/ui/components/card';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter} from '@factuez/ui/components/dialog';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@factuez/ui/components/select';

type Line={lineNumber:number;description:string;quantity:string;unitCode:string;unitPriceWithTax:string;totalAmount:string};
type Ready={serverEnabled:boolean;profile:string;availableProfiles?:string[];originalType?:string;extendedReasons?:Record<'07'|'08',string[]>;original:{documentId:string;fullNumber:string;lines:Line[];totals:{payableAmount:string}};series:{id:string;series:string;documentTypeCode:'07'|'08'}[]};
export function productionNoteCommand(seriesCounterId:string,type:'07'|'08',reason:string,increments:Record<string,string>){
 if(!['07','08'].includes(type)||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(seriesCounterId)||!reason.trim()||reason.trim().length>250)throw Error('Seleccione la serie y escriba el motivo.');
 const base={documentTypeCode:type,reasonCode:type==='07'?'01':'02',reasonDescription:reason.trim()};
 if(type==='07')return{seriesCounterId,adjustment:base};
 const lines=Object.entries(increments).filter(([,v])=>v.trim()!=='').map(([k,v])=>{
  if(!/^[1-9]\d*$/.test(k)||!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(v)||!/[1-9]/.test(v))throw Error('El incremento por unidad debe ser positivo, con hasta seis decimales.');
  return{originalLineNumber:Number(k),unitPriceAdjustmentWithTax:v};
 });
 if(!lines.length)throw Error('Indique al menos un incremento de precio.');
 return{seriesCounterId,adjustment:{...base,lines}};
}
export function productionNotePreview(lines:Line[],increments:Record<string,string>){
 const amounts=Object.entries(increments).filter(([,value])=>value.trim()!=='').map(([key,value])=>{
  if(!/^[1-9]\d*$/.test(key)||!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(value)||!/[1-9]/.test(value))throw Error('Incremento inválido');
  const original=lines.find(line=>line.lineNumber===Number(key));if(!original)throw Error('Ítem fuera de la factura');
  const result=calculateTaxLine({quantity:original.quantity,unitPriceWithTax:value,igvRate:'18'});if(result.totalAmount==='0.00')throw Error('El ajuste del ítem debe producir un importe mayor que cero.');return result;
 });
 if(!amounts.length)return undefined;
 return{taxableAmount:addMoney(amounts.map(a=>a.lineExtensionAmount)),igvAmount:addMoney(amounts.map(a=>a.igvAmount)),payableAmount:addMoney(amounts.map(a=>a.totalAmount))};
}
const EXTENDED_PROFILE='07-08-ON-01-03-PEN-0101-IGV18-v2';
const reasonLabels:Record<string,string>={'07:01':'Anulación de la operación','07:02':'Error en el RUC','07:03':'Corrección de descripción','07:04':'Descuento global','07:05':'Descuento por ítem','07:06':'Devolución total','07:07':'Devolución por ítem','07:08':'Bonificación monetaria','07:09':'Disminución de valor','07:10':'Otros conceptos','08:01':'Interés moratorio inafecto','08:02':'Aumento de valor','08:03':'Otros cargos'};
export function productionExtendedNoteCommand(seriesCounterId:string,type:'07'|'08',code:string,reason:string,fields:Record<string,Record<string,string>>,interestBasis:string){
 if(!/^[a-f0-9-]{36}$/i.test(seriesCounterId)||!reason.trim()||reason.trim().length>250||!(type+':'+code in reasonLabels))throw Error('Seleccione serie, motivo y sustento.');
 const base={documentTypeCode:type,reasonCode:code,reasonDescription:reason.trim()};
 if(type==='07'&&['01','02','06'].includes(code))return{seriesCounterId,profile:EXTENDED_PROFILE,adjustment:base};
 const required=type==='07'&&code==='03'?['correctedDescription']:type==='07'&&code==='04'?['amountWithTax']:type==='07'&&code==='07'?['quantity']:type==='07'&&code==='08'?['bonusAmountWithTax','description']:code==='10'||type==='08'&&code==='03'?['quantity','unitPriceAdjustmentWithTax','description']:type==='08'&&code==='01'?['interestAmount']:['unitPriceAdjustmentWithTax'];
 const lines=Object.entries(fields).filter(([,f])=>required.some(k=>!!f[k]?.trim())).map(([number,f])=>{
  if(!/^[1-9]\d*$/.test(number))throw Error('Ítem inválido');
  return{originalLineNumber:Number(number),...Object.fromEntries(required.map(k=>{const v=f[k]?.trim()??'';if(!v||(['description','correctedDescription'].includes(k)?v.length>500:! /^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(v)||!/[1-9]/.test(v)))throw Error('Complete los campos del ítem con importes positivos.');return[k,v];}))};
 });
 if(!lines.length)throw Error('Complete al menos un ítem');
 const extra:Record<string,unknown>={};
 if(type==='07'&&code==='04')extra.amountWithTax=addMoney(lines.map(l=>String((l as Record<string,unknown>).amountWithTax)));
 if(type==='08'&&code==='01'){if(!interestBasis.trim())throw Error('Indique la base documentada del interés moratorio');extra.interestNature='MORATORIO';extra.interestBasis=interestBasis.trim();}
 return{seriesCounterId,profile:EXTENDED_PROFILE,adjustment:{...base,...extra,lines}};
}
export function ProductionNotesPanel({documentId}:{documentId:string}){
 const {can}=useWorkspace();if(!can('document.issue'))return null;
 return <ProductionNotesForm key={documentId} documentId={documentId}/>;
}
function ProductionNotesForm({documentId}:{documentId:string}){
 const {api}=useWorkspace(),resource=useResource<Ready>(`/api/v1/documents/${documentId}/production-notes/ready`);
 const [type,setType]=useState<'07'|'08'>('07'),[series,setSeries]=useState(''),[reason,setReason]=useState(''),[increments,setIncrements]=useState<Record<string,string>>({});
 const [extended,setExtended]=useState(false),[reasonCode,setReasonCode]=useState('01'),[fields,setFields]=useState<Record<string,Record<string,string>>>({}),[interestBasis,setInterestBasis]=useState('');
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[created,setCreated]=useState<string>(),[uncertain,setUncertain]=useState(false);
 const attempt=useRef<{key:string;body:string}|undefined>(undefined),abort=useRef<AbortController|undefined>(undefined);
 useEffect(()=>()=>abort.current?.abort(),[]);
 const data=resource.data;const useExtended=extended||data?.originalType==='03';
 const command=()=>useExtended?productionExtendedNoteCommand(series,type,reasonCode,reason,fields,interestBasis):productionNoteCommand(series,type,reason,increments);
 let preview:ReturnType<typeof productionNotePreview>,previewError:string|undefined;
 if(type==='08'&&data&&!useExtended){try{preview=productionNotePreview(data.original.lines,increments);}catch(e){previewError=(e as Error).message;}}
 const seriesOptions=data?.series.filter(s=>s.documentTypeCode===type)??[],locked=busy||uncertain||Boolean(created);
 async function issue(){
  if(busy||!data?.serverEnabled||created)return;setBusy(true);setError(undefined);
  const control=new AbortController();abort.current=control;
  try{
   const body=uncertain&&attempt.current?attempt.current.body:JSON.stringify(command());
   if(!attempt.current||attempt.current.body!==body)attempt.current={key:crypto.randomUUID(),body};
   setUncertain(true);
   const result=await api<{documentId:string}>(`/api/v1/documents/${documentId}/production-notes`,{method:'POST',body,headers:{'Idempotency-Key':attempt.current.key},signal:AbortSignal.any([control.signal,AbortSignal.timeout(60000)])});
   if(!/^[a-f0-9-]{36}$/i.test(result.documentId))throw Error('Respuesta de emisión no verificable; conserve esta solicitud.');
   if(control.signal.aborted)return;
   setCreated(result.documentId);setOpen(false);setUncertain(false);resource.reload();window.dispatchEvent(new Event('factuez:live-refresh'));
  }catch(e){if(!control.signal.aborted){if(e instanceof ApiError&&[400,403,409,422,423].includes(e.status)){setUncertain(false);attempt.current=undefined;}setError(e instanceof Error?e.message:'No se pudo confirmar la emisión.');}}
  finally{if(!control.signal.aborted)setBusy(false);}
 }
 function confirm(){try{command();setError(undefined);setOpen(true);}catch(e){setError((e as Error).message);}}
 return <Card className="mb-6 shadow-none"><CardHeader><CardTitle>Nota sobre este comprobante</CardTitle><CardDescription>Seleccione el motivo y los ajustes. El servidor obtiene el original aceptado y valida el saldo, el XML/CDR y la autorización del perfil elegido.</CardDescription></CardHeader>
 <CardContent className="space-y-4">{resource.error?<ErrorState message={resource.error} retry={resource.reload}/>:!data?<Loading/>:<>
  {!data.serverEnabled&&<p className="rounded-lg border p-3 text-sm">La emisión productiva de notas no está habilitada en este servidor.</p>}
  <div className="grid gap-4 md:grid-cols-2"><div className="space-y-2"><Label>Tipo de nota</Label><Select value={type} disabled={locked} onValueChange={v=>{setType(v as '07'|'08');setSeries('');setIncrements({});setReasonCode(v==='07'?'01':'02');setFields({});}}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="07">Nota de crédito</SelectItem><SelectItem value="08">Nota de débito</SelectItem></SelectContent></Select></div>
  <div className="space-y-2"><Label>Serie autorizada del punto</Label><Select value={series} disabled={locked} onValueChange={setSeries}><SelectTrigger><SelectValue placeholder="Seleccione una serie"/></SelectTrigger><SelectContent>{seriesOptions.map(s=><SelectItem key={s.id} value={s.id}>{s.series}</SelectItem>)}</SelectContent></Select></div></div>
  {!seriesOptions.length&&<p className="text-sm text-muted-foreground">No hay una serie activa de este tipo en su punto y alcance. Configúrela en Sedes y maestros.</p>}
  <div className="space-y-2"><Label htmlFor="production-note-reason">Motivo</Label><Input id="production-note-reason" maxLength={250} value={reason} disabled={locked} onChange={e=>setReason(e.target.value)}/></div>
  {data.availableProfiles?.includes(EXTENDED_PROFILE)&&<Label className="flex items-center gap-2"><input type="checkbox" checked={useExtended} disabled={locked||data.originalType==='03'} onChange={e=>{setExtended(e.target.checked);setFields({});}}/>Usar motivos del perfil ampliado</Label>}
  {useExtended&&<div className="space-y-3"><Label>Motivo SUNAT</Label><Select value={reasonCode} disabled={locked} onValueChange={v=>{setReasonCode(v);setFields({});}}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent>{(data.extendedReasons?.[type]??[]).map(c=><SelectItem value={c} key={c}>{c} · {reasonLabels[type+':'+c]}</SelectItem>)}</SelectContent></Select>
  {type==='08'&&reasonCode==='01'&&<div><Label>Sustento documentado del interés moratorio</Label><Input maxLength={500} value={interestBasis} disabled={locked} onChange={e=>setInterestBasis(e.target.value)}/></div>}
  {!(type==='07'&&['01','02','06'].includes(reasonCode))&&data.original.lines.map(line=>{const keys=type==='07'&&reasonCode==='03'?['correctedDescription']:type==='07'&&reasonCode==='04'?['amountWithTax']:type==='07'&&reasonCode==='07'?['quantity']:type==='07'&&reasonCode==='08'?['bonusAmountWithTax','description']:reasonCode==='10'||type==='08'&&reasonCode==='03'?['quantity','unitPriceAdjustmentWithTax','description']:type==='08'&&reasonCode==='01'?['interestAmount']:['unitPriceAdjustmentWithTax'];const labels:Record<string,string>={correctedDescription:'Descripción corregida',amountWithTax:'Descuento asignado con IGV',quantity:'Cantidad del ajuste',bonusAmountWithTax:'Bonificación monetaria con IGV',description:'Descripción del concepto',interestAmount:'Interés moratorio sin IGV',unitPriceAdjustmentWithTax:'Variación unitaria con IGV'};return <div key={line.lineNumber} className="rounded-lg border p-3 space-y-2"><p className="text-sm font-medium">{line.description} · {line.quantity} {line.unitCode}</p>{keys.map(k=><div key={k}><Label htmlFor={`extended-note-${line.lineNumber}-${k}`}>{labels[k]}</Label><Input id={`extended-note-${line.lineNumber}-${k}`} disabled={locked} value={fields[String(line.lineNumber)]?.[k]??''} onChange={e=>setFields(f=>({...f,[line.lineNumber]:{...f[String(line.lineNumber)],[k]:e.target.value}}))}/></div>)}</div>;})}
  <p className="text-xs text-muted-foreground">Los importes se recalculan y validan en el servidor antes de reservar numeración. Deje vacíos los ítems que no ajustará; en descuento global complete todas las asignaciones.</p></div>}
  {!useExtended&&(type==='07'?<p className="text-sm">Se anulará el importe íntegro de {data.original.fullNumber}: {money(data.original.totals.payableAmount,'PEN')}. La admisión comprueba que no exista un ajuste incompatible.</p>:<div className="space-y-3">{data.original.lines.map(line=><div key={line.lineNumber} className="grid gap-2 rounded-lg border p-3 md:grid-cols-[1fr_200px]"><div><p className="text-sm font-medium">{line.description}</p><p className="text-xs text-muted-foreground">{line.quantity} {line.unitCode} · precio original {money(line.unitPriceWithTax,'PEN')}</p></div><div className="space-y-1"><Label htmlFor={`note-increment-${line.lineNumber}`}>Incremento unitario con IGV</Label><Input id={`note-increment-${line.lineNumber}`} inputMode="decimal" value={increments[String(line.lineNumber)]??''} disabled={locked} onChange={e=>setIncrements(v=>({...v,[line.lineNumber]:e.target.value}))}/></div></div>)}</div>)}
  {type==='08'&&preview&&<p className="rounded-lg border p-3 text-sm">Vista previa: base {money(preview.taxableAmount,'PEN')} · IGV {money(preview.igvAmount,'PEN')} · Total {money(preview.payableAmount,'PEN')}. El servidor volverá a calcular estos importes.</p>}
  {previewError&&<p role="alert" className="text-sm text-destructive">{previewError}</p>}
  {created?<Button asChild variant="outline"><Link href={`/documents/${created}`}>Ver nota registrada</Link></Button>:uncertain?<div className="space-y-2"><p className="text-sm">La solicitud anterior debe resolverse antes de crear otra. El reintento conserva el mismo identificador y contenido.</p><Button variant="outline" disabled={busy||!data.serverEnabled} onClick={()=>void issue()}>Consultar o reintentar la misma solicitud</Button></div>:<Button disabled={!data.serverEnabled||busy||!series||!reason.trim()||Boolean(previewError)||(!useExtended&&type==='08'&&!preview)} onClick={confirm}>Revisar nota</Button>}
 </>}{error&&<ErrorState message={error}/>}<Dialog open={open} onOpenChange={v=>{if(!busy)setOpen(v);}}><DialogContent><DialogHeader><DialogTitle>Confirmar emisión de nota</DialogTitle><DialogDescription>Se registrará una nota real vinculada a {data?.original.fullNumber}. El servidor validará el saldo, reservará el correlativo de la serie elegida y tramitará su envío según la autorización vigente.</DialogDescription></DialogHeader>{error&&<ErrorState message={error}/>}<DialogFooter><Button variant="outline" disabled={busy} onClick={()=>setOpen(false)}>Cancelar</Button><Button disabled={busy} onClick={()=>void issue()}>{busy?'Registrando…':uncertain?'Consultar misma solicitud':'Confirmar y emitir'}</Button></DialogFooter></DialogContent></Dialog>
 </CardContent></Card>;
}
