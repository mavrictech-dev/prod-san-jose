"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { GUIDE_FUEL_FAMILIES, summarizeGuideFuelProfile, type GuideFuelSettings, GUIDE_UNITS, validateGuideSettingsWrite, type GuideLocation, type GuideOperationalSettings, type GuideProduct, type GuideRole, type GuideRoute, type GuideSettingsDocument, type GuideSettingsIssue } from '@factuez/contracts';
import { Button } from '@factuez/ui/components/button';
import { Badge } from '@factuez/ui/components/badge';
import { Input } from '@factuez/ui/components/input';
import { Label } from '@factuez/ui/components/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@factuez/ui/components/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@factuez/ui/components/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@factuez/ui/components/select';
import { ApiError, useWorkspace } from './provider';
import { ErrorState, Loading, PageHeading } from './common';
import type { Company } from './types';

type Draft = Omit<GuideOperationalSettings, 'role'> & { role: GuideRole | '' };
const blank = (): Draft => ({ role: '', products: [], routes: [] });
const point = (): GuideLocation => ({ address: '', ubigeo: '', department: '', province: '', district: '' });
const roleLabels = { REMITENTE: 'Remitente', TRANSPORTISTA: 'Transportista', AMBOS: 'Remitente y transportista' };
const typeLabels = { FUEL: 'Combustible', OTHER_REGULATED: 'Otro producto fiscalizado', GENERAL: 'Mercancía general' };
const unitLabels = { LTR: 'Litros (LTR)', GLL: 'Galones (GLL)', KGM: 'Kilogramos (KGM)', TNE: 'Toneladas (TNE)', NIU: 'Unidades (NIU)' };

export function GuideOperationalSettingsPage() {
  const { user, can, catalog, companyId } = useWorkspace();
  const company = catalog?.companies.find(item => String(item.id) === companyId);
  return <div className="min-w-0 space-y-5">
    <PageHeading eyebrow="Administración" title="Configuración de guías" description="Declare los productos y las rutas que utiliza su empresa." />
    {!can('setup.manage') || user?.scope.kind !== 'GLOBAL' || !user.roles.includes('ADMIN')
      ? <ErrorState message="Se requiere un administrador general con permiso de configuración." />
      : company ? <GuideSettingsForm key={`${user.sub}:${company.id}`} company={company} />
      : <Card><CardContent className="pt-6"><p role="status">Seleccione un emisor en la cabecera para configurar sus guías.</p><Button className="mt-4" disabled>Guardar configuración</Button></CardContent></Card>}
  </div>;
}

function GuideSettingsForm({ company }: { company: Company }) {
  const { api, setDirty } = useWorkspace();
  const path = `/api/v1/stations/issuers/${company.id}/guide-settings`;
  const [saved, setSaved] = useState<GuideSettingsDocument>();
  const [draft, setDraft] = useState<Draft>(blank);
  const [changed, setChanged] = useState(false);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>(), [success, setSuccess] = useState(false);
  const [issues, setIssues] = useState<GuideSettingsIssue[]>([]);
  const [tab, setTab] = useState('issuer');
  const [reviewRequired, setReviewRequired] = useState(false), [review, setReview] = useState<GuideSettingsDocument>();
  const alive = useRef(true), flight = useRef(false), readGeneration = useRef(0);
  const summary = useRef<HTMLDivElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; readGeneration.current++; }; }, []);
  useEffect(() => { setDirty(changed); return () => setDirty(false); }, [changed, setDirty]);
  const check = useCallback((value: GuideSettingsDocument) => {
    if (value.companyId !== company.id || value.ruc !== company.ruc || value.fiscalTransmission !== false || value.version !== 'factuez.guide-operational-settings.v1') throw new Error('La respuesta no corresponde al emisor seleccionado. Recargue.');
    return value;
  }, [company.id, company.ruc]);
  const load = useCallback(async () => {
    const generation = ++readGeneration.current;
    setLoading(true); setError(undefined);
    try {
      const value = check(await api<GuideSettingsDocument>(path, { signal: AbortSignal.timeout(15000) }));
      if (!alive.current || generation !== readGeneration.current) return;
      setSaved(value); setDraft(value.settings ?? blank()); setChanged(false); setIssues([]); setReview(undefined); setReviewRequired(false);
    } catch (reason) { if (alive.current && generation === readGeneration.current) setError(message(reason)); }
    finally { if (alive.current && generation === readGeneration.current) setLoading(false); }
  }, [api, path, check]);
  useEffect(() => { void load(); }, [load]);
  function message(reason: unknown) {
    if (reason instanceof ApiError && reason.status === 403) return 'Acceso denegado. Se requiere un administrador general activo y un emisor activo.';
    if (reason instanceof ApiError && reason.status === 503) return 'La configuración de guías no está disponible. El administrador debe preparar el almacenamiento en el servidor.';
    return reason instanceof Error ? reason.message : 'No se pudo completar la solicitud.';
  }
  function update(patch: Partial<Draft>) { setDraft(value => ({ ...value, ...patch })); setChanged(true); setSuccess(false); setIssues([]); }
  async function save() {
    if (!saved || flight.current || loading || reviewRequired) return;
    const validation = validateGuideSettingsWrite({ expectedRevision: saved.revision, settings: draft });
    if (!validation.ok) {
      setIssues(validation.issues);
      const first = validation.issues[0]?.path ?? '';
      setTab(first.startsWith('settings.fuelProfile') ? 'fuel' : first.startsWith('settings.products') ? 'products' : first.startsWith('settings.routes') ? 'routes' : 'issuer');
      setTimeout(() => summary.current?.focus(), 0); return;
    }
    flight.current = true; setBusy(true); setError(undefined); setSuccess(false);
    try {
      const value = check(await api<GuideSettingsDocument>(path, { method: 'PUT', body: JSON.stringify(validation.value), signal: AbortSignal.timeout(20000) }));
      if (!alive.current) return;
      setSaved(value); setDraft(value.settings ?? blank()); setChanged(false); setSuccess(true); setIssues([]);
    } catch (reason) {
      if (!alive.current) return;
      const conflict = reason instanceof ApiError && reason.status === 409;
      setError(conflict ? 'Otra persona guardó cambios. Su borrador se conserva; revise los datos guardados antes de reenviar.' : message(reason));
      // No automatic retries, including a response lost after the server committed.
      setReviewRequired(conflict || !(reason instanceof ApiError) || reason.status >= 500);
    } finally { flight.current = false; if (alive.current) setBusy(false); }
  }
  async function reviewSaved() {
    if (flight.current) return; flight.current = true; setBusy(true);
    try { const value = check(await api<GuideSettingsDocument>(path, { signal: AbortSignal.timeout(15000) })); if (alive.current) setReview(value); }
    catch (reason) { if (alive.current) setError(message(reason)); }
    finally { flight.current = false; if (alive.current) setBusy(false); }
  }
  const fieldIssue = (path: string) => issues.find(issue => issue.path === path)?.message;
  function field(label: string, value: string, path: string, max: number, onChange: (value: string) => void, numeric = false) {
    const id = `guide-${path}`, issue = fieldIssue(path);
    return <div className="min-w-0 space-y-2"><Label htmlFor={id} className="leading-normal">{label}</Label><Input id={id} value={value} maxLength={max} inputMode={numeric ? 'numeric' : 'text'} onChange={event => onChange(event.target.value)} aria-invalid={!!issue} aria-describedby={issue ? `${id}-error` : undefined} />{issue && <p id={`${id}-error`} className="text-sm text-destructive">{issue}</p>}</div>;
  }
  function select(label: string, value: string, path: string, options: Record<string, string>, onChange: (value: string) => void) {
    const id = `guide-${path}`, issue = fieldIssue(path);
    return <div className="min-w-0 space-y-2"><Label htmlFor={id} className="leading-normal">{label}</Label><Select value={value} onValueChange={onChange} disabled={busy}><SelectTrigger id={id} className="w-full min-w-0" aria-invalid={!!issue} aria-describedby={issue ? `${id}-error` : undefined}><SelectValue placeholder="Seleccione una opción" /></SelectTrigger><SelectContent>{Object.entries(options).map(([key, text]) => <SelectItem key={key} value={key}>{text}</SelectItem>)}</SelectContent></Select>{issue && <p id={`${id}-error`} className="text-sm text-destructive">{issue}</p>}</div>;
  }
  function product(index: number, patch: Partial<GuideProduct>) { update({ products: draft.products.map((value, i) => i === index ? { ...value, ...patch } : value) }); }
  function route(index: number, patch: Partial<GuideRoute>) { update({ routes: draft.routes.map((value, i) => i === index ? { ...value, ...patch } : value) }); }
  function location(index: number, kind: 'origin' | 'destination') {
    const value = draft.routes[index][kind], prefix = `settings.routes.${index}.${kind}`;
    const patch = (change: Partial<GuideLocation>) => route(index, { [kind]: { ...value, ...change } });
    return <fieldset className="min-w-0 space-y-4 rounded-lg border p-4"><legend className="px-1 text-sm font-medium">{kind === 'origin' ? 'Punto de partida' : 'Punto de llegada'}</legend>
      {field('Dirección', value.address, `${prefix}.address`, 300, address => patch({ address }))}
      {field('UBIGEO (6 dígitos)', value.ubigeo, `${prefix}.ubigeo`, 6, ubigeo => patch({ ubigeo }), true)}
      {field('Departamento', value.department, `${prefix}.department`, 100, department => patch({ department }))}
      {field('Provincia', value.province, `${prefix}.province`, 100, province => patch({ province }))}
      {field('Distrito', value.district, `${prefix}.district`, 100, district => patch({ district }))}
      {field('Establecimiento SUNAT (opcional, 4 dígitos)', value.establishmentCode ?? '', `${prefix}.establishmentCode`, 4, establishmentCode => patch({ establishmentCode: establishmentCode || undefined }), true)}
    </fieldset>;
  }
  const fuelSummary = summarizeGuideFuelProfile({...draft,role:draft.role || 'REMITENTE'});
  function initializeFuel() {
    update({fuelProfile:{version:'factuez.guide-fuel-settings.v1',...(draft.fuelProfile?.hydrocarbonRegistry?{hydrocarbonRegistry:draft.fuelProfile.hydrocarbonRegistry}:{}),
      products:draft.products.filter(p=>p.type==='FUEL').map(p=>draft.fuelProfile?.products.find(f=>f.productId===p.id)??{productId:p.id,family:'PENDING_REVIEW'}),
      routes:draft.routes.map(r=>draft.fuelProfile?.routes.find(f=>f.routeId===r.id)??{routeId:r.id,regime:'PENDING_REVIEW',transportMode:'01',reasonCode:'01',scop:'PENDING_REVIEW'})}});
  }
  function fuelPatch(patch:Partial<GuideFuelSettings>){if(draft.fuelProfile)update({fuelProfile:{...draft.fuelProfile,...patch}});}
  return <div className="min-w-0 space-y-5">
    <div className="min-w-0 rounded-lg border bg-muted/30 p-4 text-sm"><p className="break-words font-medium">{company.legalName}</p><p className="mt-1">RUC {company.ruc} · Emisor seleccionado en la cabecera</p></div>
    {loading ? <Loading /> : !saved ? <ErrorState message={error ?? 'No se pudo cargar la configuración.'} retry={() => void load()} /> : <>
      <div className="flex flex-wrap gap-2" role="status"><Badge variant="outline">{changed ? 'Cambios sin guardar' : saved.configured ? 'Datos guardados' : 'Sin configurar'}</Badge>{saved.configured && <Badge variant="outline">Revisión del perfil pendiente</Badge>}</div>
      <p className="text-sm text-muted-foreground">Guardar estos datos no autoriza envíos a SUNAT. El perfil fiscal y la conexión del servidor requieren revisión posterior.</p>
      {success && <p role="status" className="text-sm font-medium text-emerald-700">Datos guardados. Revisión del perfil pendiente.</p>}
      {error && <div role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm">{error}</div>}
      {!!issues.length && <div ref={summary} tabIndex={-1} role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm"><p className="font-medium">Revise los campos indicados</p><ul className="mt-2 list-inside list-disc">{[...new Set(issues.map(issue => issue.message))].map(text => <li key={text}>{text}</li>)}</ul></div>}
      {reviewRequired && <Button variant="outline" disabled={busy} onClick={() => void reviewSaved()}>Revisar datos guardados</Button>}
      {review && <Card><CardHeader><CardTitle className="text-base">Datos actuales del servidor</CardTitle><CardDescription>Revise esta información antes de conservar o descartar su borrador.</CardDescription></CardHeader><CardContent className="min-w-0 space-y-3 text-sm">
        {review.settings ? <><p>Rol: {roleLabels[review.settings.role]}</p>{review.settings.products.map(p => <p className="break-words" key={p.id}>{p.name} · {typeLabels[p.type]} · {unitLabels[p.unit]}{p.commercialCode ? ` · ${p.commercialCode}` : ''}</p>)}{review.settings.routes.map(r => <div key={r.id} className="break-words"><p className="font-medium">{r.name}</p>{[r.origin, r.destination].map((p, i) => <p key={i}>{i === 0 ? 'Partida' : 'Llegada'}: {p.address}, {p.department}, {p.province}, {p.district} · {p.ubigeo}{p.establishmentCode ? ` · Establecimiento ${p.establishmentCode}` : ''}</p>)}</div>)}</> : <p>Sin configurar</p>}
        {review.settings?.fuelProfile && <div className="space-y-1"><p>Registro de hidrocarburos: {review.settings.fuelProfile.hydrocarbonRegistry??'Pendiente'}</p>{review.settings.fuelProfile.products.map(p=><p key={p.productId}>Combustible: {review.settings!.products.find(x=>x.id===p.productId)?.name} ? {p.family}</p>)}{review.settings.fuelProfile.routes.map(p=><p key={p.routeId}>Ruta: {review.settings!.routes.find(x=>x.id===p.routeId)?.name} ? {p.regime} ? Modalidad {p.transportMode} ? Motivo {p.reasonCode} ? SCOP {p.scop}</p>)}</div>}
        <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => { setSaved(review); setReview(undefined); setReviewRequired(false); setError(undefined); }}>Conservar mi borrador</Button><Button variant="outline" disabled={busy} onClick={() => { setSaved(review); setDraft(review.settings ?? blank()); setChanged(false); setReview(undefined); setReviewRequired(false); setError(undefined); setIssues([]); }}>Usar datos guardados</Button></div>
      </CardContent></Card>}
      <fieldset disabled={busy} className="min-w-0 space-y-5">
        <Tabs value={tab} onValueChange={setTab} className="min-w-0"><TabsList aria-label="Configuración operativa"><TabsTrigger value="issuer">Emisor</TabsTrigger><TabsTrigger value="products">Productos</TabsTrigger><TabsTrigger value="routes">Rutas</TabsTrigger><TabsTrigger value="fuel">Combustibles</TabsTrigger></TabsList>
          <TabsContent value="issuer"><Card><CardHeader><CardTitle className="text-base">Emisor</CardTitle><CardDescription>Indique cómo participa la empresa en el traslado.</CardDescription></CardHeader><CardContent>{select('Emite como', draft.role, 'settings.role', roleLabels, role => update({ role: role as GuideRole }))}</CardContent></Card></TabsContent>
          <TabsContent value="products" className="min-w-0 space-y-4"><p className="text-sm text-muted-foreground">Use el nombre comercial o producto exacto. El código comercial no es una homologación SUNAT.</p>
            {!draft.products.length && <p className="py-4 text-sm">Aún no hay productos. Agregue al menos uno para guardar.</p>}
            {draft.products.map((p, i) => <Card key={p.id} className="min-w-0"><CardHeader><CardTitle className="break-words text-base">Producto {i + 1}</CardTitle></CardHeader><CardContent className="grid min-w-0 gap-4 md:grid-cols-2">
              {field('Nombre comercial / producto exacto', p.name, `settings.products.${i}.name`, 160, name => product(i, { name }))}
              {select('Tipo de producto', p.type, `settings.products.${i}.type`, typeLabels, type => product(i, { type: type as GuideProduct['type'] }))}
              {select('Unidad de medida', p.unit, `settings.products.${i}.unit`, Object.fromEntries(GUIDE_UNITS.map(key => [key, unitLabels[key]])), unit => product(i, { unit: unit as GuideProduct['unit'] }))}
              {field('Código comercial (opcional)', p.commercialCode ?? '', `settings.products.${i}.commercialCode`, 80, commercialCode => product(i, { commercialCode: commercialCode || undefined }))}
              <Button variant="outline" className="justify-self-start" onClick={() => update({ products: draft.products.filter((_, index) => index !== i) })} aria-label={`Quitar producto ${i + 1}`}>Quitar producto</Button>
            </CardContent></Card>)}
            <Button variant="outline" disabled={busy || draft.products.length >= 30} onClick={() => update({ products: [...draft.products, { id: crypto.randomUUID(), name: '', type: '' as GuideProduct['type'], unit: '' as GuideProduct['unit'] }] })}>Agregar producto</Button><p className="text-xs text-muted-foreground">{draft.products.length} de 30 productos</p>
          </TabsContent>
          <TabsContent value="routes" className="min-w-0 space-y-4"><p className="text-sm text-muted-foreground">Direcciones y UBIGEO declarados por su empresa, pendientes de revisión. El SCOP, cuando corresponda, es un dato de cada operación y no se guarda como valor fijo en esta configuración.</p>
            {!draft.routes.length && <p className="py-4 text-sm">Aún no hay rutas. Agregue al menos una para guardar.</p>}
            {draft.routes.map((r, i) => <Card key={r.id} className="min-w-0"><CardHeader><CardTitle className="text-base">Ruta {i + 1}</CardTitle></CardHeader><CardContent className="min-w-0 space-y-4">
              {field('Nombre de la ruta', r.name, `settings.routes.${i}.name`, 160, name => route(i, { name }))}
              <div className="grid min-w-0 gap-4 lg:grid-cols-2">{location(i, 'origin')}{location(i, 'destination')}</div>
              <Button variant="outline" onClick={() => update({ routes: draft.routes.filter((_, index) => index !== i) })} aria-label={`Quitar ruta ${i + 1}`}>Quitar ruta</Button>
            </CardContent></Card>)}
            <Button variant="outline" disabled={busy || draft.routes.length >= 30} onClick={() => update({ routes: [...draft.routes, { id: crypto.randomUUID(), name: '', origin: point(), destination: point() }] })}>Agregar ruta</Button><p className="text-xs text-muted-foreground">{draft.routes.length} de 30 rutas</p>
          </TabsContent>
          <TabsContent value="fuel" className="min-w-0 space-y-4">
            <Card><CardHeader><CardTitle className="text-base">Perfil de combustibles</CardTitle><CardDescription>Complete los productos y las rutas primero. La clasificación declarada requiere revisión según el producto y el recorrido.</CardDescription></CardHeader><CardContent className="min-w-0 space-y-4">
              <p className="text-sm">El SCOP se consigna en cada operación. Este formulario guarda la configuración de la empresa; no solicita su clave SOL ni el número SCOP de un traslado.</p>
              {!draft.products.some(p=>p.type==='FUEL') ? <p>Agregue un producto de tipo Combustible en la pestaña Productos.</p> : <>
                <Button variant="outline" onClick={initializeFuel} disabled={!draft.routes.length}>{draft.fuelProfile?'Actualizar productos y rutas del perfil':'Preparar perfil de combustibles'}</Button>
                {draft.fuelProfile && <>
                  {field('Registro de hidrocarburos del emisor',draft.fuelProfile.hydrocarbonRegistry??'','settings.fuelProfile.hydrocarbonRegistry',60,hydrocarbonRegistry=>fuelPatch({hydrocarbonRegistry:hydrocarbonRegistry||undefined}))}
                  <p className="text-xs text-muted-foreground">Dato declarado por la empresa, pendiente de verificar con OSINERGMIN.</p>
                  {draft.fuelProfile.products.map((p,i)=><div key={p.productId}>{select(`Familia: ${draft.products.find(x=>x.id===p.productId)?.name??'Producto eliminado; actualice el perfil'}`,p.family,`settings.fuelProfile.products.${i}.family`,{PENDING_REVIEW:'Pendiente de determinar',DIESEL:'Diésel',GASOHOL:'Gasohol (precisar familia)',GASOHOL_PREMIUM:'Gasohol premium',GASOHOL_REGULAR:'Gasohol regular',GASOLINE:'Gasolina (requiere revisión)',GLP:'GLP',OTHER:'Otro combustible'},family=>fuelPatch({products:draft.fuelProfile!.products.map((v,n)=>n===i?{...v,family:family as typeof GUIDE_FUEL_FAMILIES[number]}:v)}))}</div>)}
                  {draft.fuelProfile.routes.map((p,i)=>{
                    const prefix=`settings.fuelProfile.routes.${i}`;
                    const patch=(change:Partial<typeof p>)=>fuelPatch({routes:draft.fuelProfile!.routes.map((v,n)=>n===i?{...v,...change}:v)});
                    return <fieldset key={p.routeId} className="grid min-w-0 gap-4 rounded-lg border p-4 md:grid-cols-2"><legend className="px-1 text-sm font-medium">{draft.routes.find(r=>r.id===p.routeId)?.name??'Ruta eliminada; actualice el perfil'}</legend>
                      {select('Régimen del traslado',p.regime,`${prefix}.regime`,{PENDING_REVIEW:'Pendiente de determinar',ORDINARY_GRE:'GRE ordinaria',GRE_BF:'GRE de bienes fiscalizados'},regime=>patch({regime:regime as typeof p.regime}))}
                      {select('Modalidad de transporte',p.transportMode,`${prefix}.transportMode`,{'01':'Público (transportista contratado)','02':'Privado'},transportMode=>patch({transportMode:transportMode as typeof p.transportMode}))}
                      {select('Motivo del traslado',p.reasonCode,`${prefix}.reasonCode`,{'01':'Venta','04':'Entre establecimientos de la empresa'},reasonCode=>patch({reasonCode:reasonCode as typeof p.reasonCode}))}
                      {select('SCOP por operación',p.scop,`${prefix}.scop`,{PENDING_REVIEW:'Pendiente de determinar',REQUIRED:'Requerido en cada traslado',NOT_APPLICABLE:'No corresponde (requiere otro perfil)'},scop=>patch({scop:scop as typeof p.scop}))}
                    </fieldset>;
                  })}
                </>}
                <div role="status" className="min-w-0 rounded-lg border bg-muted/30 p-4 text-sm"><p className="font-medium">{fuelSummary.status==='READY_FOR_TECHNICAL_REVIEW'?'Datos completos para revisión técnica':'Perfil pendiente de completar'}</p>
                  {fuelSummary.blockers.length>0&&<ul className="mt-2 list-inside list-disc">{fuelSummary.blockers.map((b,i)=><li key={i}>{b}</li>)}</ul>}
                  {fuelSummary.profiles.length>0&&<><p className="mt-2">Perfiles existentes para revisión técnica (sin concesión):</p>{fuelSummary.profiles.map(p=><p key={p} className="break-words text-xs">{{GRE09_HYDROCARBON_PRIVATE04_V1:'Remitente: 09 privada, requiere habilitación por sede, combustible, ruta, vehículo y registros',GRE09_HYDROCARBON_PUBLIC01_V1:'Remitente: 09 pública, requiere habilitación por sede, combustible, ruta y transportista'}[p]??p}</p>)}</>}
                  <p className="mt-2">Guardar no habilita la emisión. Las rutas que requieren GRE de bienes fiscalizados deben tramitarse por ese sistema de SUNAT.</p>
                </div>
              </>}
            </CardContent></Card>
          </TabsContent>
        </Tabs>
        <div className="flex flex-wrap gap-3"><Button disabled={busy || !changed || reviewRequired} onClick={() => void save()}>{busy ? 'Guardando…' : 'Guardar configuración'}</Button>{changed && <Button variant="outline" disabled={busy || reviewRequired} onClick={() => { setDraft(saved.settings ?? blank()); setChanged(false); setIssues([]); setSuccess(false); }}>Descartar cambios</Button>}</div>
      </fieldset>
    </>}
  </div>;
}
