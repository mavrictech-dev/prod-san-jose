"use client";
import { useEffect, useState } from 'react';
import { DEFAULT_TAX_POLICY, NATURAL_REGIONS, TAX_TREATMENTS, type TaxPolicy, type TaxPolicyView } from '@factuez/contracts';
import { Button } from '@factuez/ui/components/button';
import { Input } from '@factuez/ui/components/input';
import { Label } from '@factuez/ui/components/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@factuez/ui/components/card';
import { useResource, useWorkspace } from './provider';
import { ErrorState, Loading } from './common';
import {parseDecimal,roundDivide,formatScaled} from '@factuez/sunat-core/dist/tax';

export const choiceClass = 'flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
type Assignment = { productId:string; branchId:string|null; revision:number; overridden:boolean; treatment:string };
export function TaxPolicyAdmin() {
  const { catalog, companyId, branchId, can, user } = useWorkspace();
  const [company, setCompany] = useState(companyId);
  const [branch, setBranch] = useState(branchId);
  useEffect(()=>{setCompany(companyId);setBranch(branchId);},[companyId,branchId]);
  const branches = catalog?.branches.filter(b=>String(b.companyId)===company)??[];
  const editable=!!user?.roles.includes('ADMIN')&&can('setup.manage');
  return <Card><CardHeader><CardTitle>Política tributaria por RUC y sede</CardTitle><CardDescription>RUC → sede → operación. El punto usa la política de su sede. La región no concede exoneración automáticamente.</CardDescription></CardHeader><CardContent className="space-y-5">
    <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="tax-company">Emisor RUC</Label><select id="tax-company" className={choiceClass} value={company} onChange={e=>{setCompany(e.target.value);setBranch('');}}><option value="">Seleccione emisor</option>{catalog?.companies.map(c=><option key={c.id} value={c.id}>{c.ruc} · {c.legalName}</option>)}</select></div><div className="space-y-2"><Label htmlFor="tax-branch">Alcance de configuración</Label><select id="tax-branch" className={choiceClass} value={branch} onChange={e=>setBranch(e.target.value)}><option value="">Predeterminados del RUC</option>{branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></div></div>
    {company?<PolicyEditor key={`${company}:${branch}`} company={company} branch={branch} editable={editable}/>:<p className="text-sm">Seleccione un emisor autorizado para consultar su política.</p>}
    <div className="flex flex-wrap gap-4 text-sm"><a className="underline" href="/sunat-settings">Credenciales y certificado SUNAT</a><a className="underline" href="/guides">Preparación y operación GRE</a><a className="underline" href="/api-reference">Contrato nativo de la API</a></div>
  </CardContent></Card>;
}
function PolicyEditor({company,branch,editable}:{company:string;branch:string;editable:boolean}) {
  const {api,catalog,setDirty}=useWorkspace();
  const suffix=branch?`?branchId=${encodeURIComponent(branch)}`:'';
  const base=`/api/v1/stations/companies/${company}`;
  const resource=useResource<TaxPolicyView>(`${base}/tax-policy${suffix}`);
  const taxes=useResource<Assignment[]>(`${base}/product-taxes${suffix}`);
  const [form,setForm]=useState<TaxPolicy>(DEFAULT_TAX_POLICY),[override,setOverride]=useState(false),[changed,setChanged]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string>(),[notice,setNotice]=useState<string>();
  useEffect(()=>{if(resource.data){setForm(resource.data.policy);setOverride(resource.data.overridden);setChanged(false);}},[resource.data]);
  useEffect(()=>{setDirty(changed);return()=>setDirty(false);},[changed,setDirty]);
  const change=(patch:Partial<TaxPolicy>)=>{setForm(f=>({...f,...patch}));setChanged(true);};
  let preview:string|undefined;try{const tax=form.defaultTreatment==='10'?roundDivide(10000n*parseDecimal(form.rate,2),10000n):0n;preview=`Base S/ 100.00 → IGV S/ ${formatScaled(tax,2)} → Total S/ ${formatScaled(10000n+tax,2)}`;}catch{/* El servidor valida la tasa al guardar; no se muestra una vista previa inválida. */}
  async function save(){if(!resource.data)return;setBusy(true);setError(undefined);try{await api(`${base}/tax-policy${suffix}`,{method:'PUT',body:JSON.stringify({expectedRevision:resource.data.revision,overridden:override,policy:form})});setChanged(false);resource.reload();setNotice('Política guardada. Los originales históricos conservan su tratamiento.');}catch(e){setError(e instanceof Error?e.message:'No se pudo guardar');}finally{setBusy(false);}}
  if(resource.error)return <ErrorState message={resource.error} retry={resource.reload}/>;
  if(!resource.data)return <Loading/>;
  return <div className="space-y-5">
    <p className="text-sm" role="status">Origen efectivo: {resource.data.source==='BRANCH'?'Sobrescritura de esta sede':resource.data.source==='RUC'?'Predeterminados del RUC':'Predeterminados del sistema'} · Revisión {resource.data.revision}</p>
    <fieldset disabled={!editable||busy} className="space-y-4">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={override} onChange={e=>{setOverride(e.target.checked);setChanged(true);if(!e.target.checked)setForm(resource.data!.inherited);}}/>{branch?'Sobrescribir en esta sede (desmarcar restaura herencia del RUC)':'Configurar predeterminados de este RUC'}</label>
      <fieldset disabled={!override} className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="tax-region">Región natural</Label><select id="tax-region" className={choiceClass} value={form.region} onChange={e=>change({region:e.target.value as TaxPolicy['region']})}>{NATURAL_REGIONS.map(r=><option key={r.code} value={r.code}>{r.label}</option>)}</select></div>
        <div className="space-y-2"><Label htmlFor="tax-regime">Régimen de tasa</Label><select id="tax-regime" className={choiceClass} value={form.regime} onChange={e=>change({regime:e.target.value as TaxPolicy['regime'],...(e.target.value==='GENERAL'?{rate:'18.00'}:{})})}><option value="GENERAL">General · 18 %</option><option value="CUSTOM">Personalizada · sujeta a perfil fiscal</option></select></div>
        <div className="space-y-2"><Label htmlFor="tax-rate">Tasa IGV (%)</Label><Input id="tax-rate" inputMode="decimal" value={form.rate} readOnly={form.regime==='GENERAL'} onChange={e=>change({rate:e.target.value})}/><p className="text-xs text-muted-foreground">La tasa es un porcentaje; el código SUNAT 10 identifica una operación gravada.</p></div>
        <div className="space-y-2"><Label htmlFor="tax-date">Vigente desde</Label><Input id="tax-date" type="date" value={form.validFrom} onChange={e=>change({validFrom:e.target.value})}/></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.allowExempt} onChange={e=>change({allowExempt:e.target.checked,defaultTreatment:!e.target.checked&&form.defaultTreatment==='20'?'10':form.defaultTreatment})}/>Permitir exonerado (20) cuando corresponda</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.allowUnaffected} onChange={e=>change({allowUnaffected:e.target.checked,defaultTreatment:!e.target.checked&&form.defaultTreatment==='30'?'10':form.defaultTreatment})}/>Permitir inafecto (30)</label>
        <div className="space-y-2"><Label htmlFor="tax-treatment">Tratamiento predeterminado</Label><select id="tax-treatment" className={choiceClass} value={form.defaultTreatment} onChange={e=>change({defaultTreatment:e.target.value as TaxPolicy['defaultTreatment']})}>{TAX_TREATMENTS.filter(t=>t.code==='10'||t.code==='20'&&form.allowExempt||t.code==='30'&&form.allowUnaffected).map(t=><option key={t.code} value={t.code}>{t.code} · {t.label}</option>)}</select></div>
      </fieldset>
      {preview&&<p className="rounded-lg bg-muted p-3 text-sm" role="status">Vista previa: {preview}</p>}
      <p className="rounded-lg border p-3 text-sm">La tasa general predeterminada es 18 %. Selva requiere evaluar las condiciones del contribuyente y de la operación. El perfil 10/20/30 permite gravado al 18 %, exonerado e inafecto con una nueva autorización fiscal explícita. Una tasa personalizada no admitida se rechaza antes de asignar correlativo.</p>
      {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button disabled={!changed||busy} onClick={()=>void save()}>{busy?'Guardando…':'Guardar política'}</Button>
    </fieldset>
    {!editable&&<p className="text-sm">Consulta autorizada. Se requiere rol administrador y permiso de configuración para editar.</p>}
    {notice&&<p role="status" className="text-sm text-emerald-700">{notice}</p>}
    <div className="space-y-3"><h3 className="font-semibold">Afectación de productos en {branch?'esta sede':'este RUC'}</h3><p className="text-sm text-muted-foreground">Cada asignación puede heredar del RUC o del tratamiento predeterminado. El catálogo de productos sigue siendo compartido.</p>
      {taxes.error?<ErrorState message={taxes.error} retry={taxes.reload}/>:!taxes.data?<Loading/>:catalog?.products.map(p=>{const own=taxes.data!.find(t=>t.productId===p.id&&t.branchId===(branch||null)),parent=taxes.data!.find(t=>t.productId===p.id&&t.branchId===null&&t.overridden);return <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3" key={p.id}><span className="min-w-32 flex-1 text-sm">{p.sku} · {p.description}</span><select aria-label={`Afectación de ${p.description}`} className={`${choiceClass} max-w-xs`} disabled={!editable||busy} value={own?.overridden?own.treatment:'inherit'} onChange={async e=>{const value=e.target.value;setBusy(true);setError(undefined);try{await api(`${base}/product-taxes/${p.id}${suffix}`,{method:'PUT',body:JSON.stringify({expectedRevision:own?.revision??0,overridden:value!=='inherit',treatment:value==='inherit'?'10':value})});taxes.reload();}catch(e){setError(e instanceof Error?e.message:'No se pudo guardar');}finally{setBusy(false);}}}><option value="inherit">Heredado · {branch&&parent?parent.treatment:resource.data!.policy.defaultTreatment}</option>{TAX_TREATMENTS.filter(t=>t.code==='10'||t.code==='20'&&resource.data!.policy.allowExempt||t.code==='30'&&resource.data!.policy.allowUnaffected).map(t=><option key={t.code} value={t.code}>{t.code} · {t.label} · {t.code==='10'?resource.data!.policy.rate:'0'} %</option>)}</select></div>;})}
    </div>
  </div>;
}
