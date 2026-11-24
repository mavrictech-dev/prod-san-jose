"use client";
import {useState} from 'react';
import {Button} from '@factuez/ui/components/button';
import {Input} from '@factuez/ui/components/input';
import {Label} from '@factuez/ui/components/label';
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from '@factuez/ui/components/card';
import {useResource,useWorkspace} from './provider';
import {ErrorState,Loading} from './common';
export type CategoryMaster={id:string;name:string;active:boolean;revision:number};
export type UnitMaster={code:string;description:string;active:boolean;revision:number};
export function ProductMasters(){
 const {api}=useWorkspace();const categories=useResource<CategoryMaster[]>('/api/v1/stations/product-categories'),units=useResource<UnitMaster[]>('/api/v1/stations/product-units');
 const [search,setSearch]=useState(''),[name,setName]=useState(''),[target,setTarget]=useState<CategoryMaster|UnitMaster>(),[kind,setKind]=useState<'categories'|'units'>('categories');
 const [busy,setBusy]=useState(false),[error,setError]=useState<string>(),[notice,setNotice]=useState<string>();
 async function save(active=true){setBusy(true);setError(undefined);try{await api(`/api/v1/stations/product-${kind}${target?`/${'id'in target?target.id:target.code}`:''}`,{method:target?'PATCH':'POST',body:JSON.stringify({[kind==='categories'?'name':'description']:name,active,...(target?{expectedRevision:target.revision}:{})})});setTarget(undefined);setName('');categories.reload();units.reload();setNotice('Catálogo guardado. Las referencias anteriores se conservan.');}catch(e){setError(e instanceof Error?e.message:'No se pudo guardar');}finally{setBusy(false);}}
 return <Card><CardHeader><CardTitle>Categorías y unidades</CardTitle><CardDescription>Maestros únicos del catálogo compartido. Se desactivan sin eliminar referencias. Las unidades se limitan al subconjunto validado.</CardDescription></CardHeader><CardContent className="space-y-4">
 <Input aria-label="Buscar categoría o unidad" placeholder="Buscar categoría o unidad" value={search} onChange={e=>setSearch(e.target.value)}/>
 {categories.error||units.error?<ErrorState message={categories.error??units.error!} retry={()=>{categories.reload();units.reload();}}/>:!categories.data||!units.data?<Loading/>:<div className="grid gap-4 sm:grid-cols-2">{[['Categorías',categories.data],['Unidades',units.data]].map(([label,rows])=><div className="space-y-2" key={label as string}><h3 className="font-semibold">{label as string}</h3>{(rows as (CategoryMaster|UnitMaster)[]).filter(r=>('name'in r?r.name:`${r.code} ${r.description}`).toLowerCase().includes(search.toLowerCase())).map(r=><div key={'id'in r?r.id:r.code} className="flex items-center justify-between gap-2 rounded-md border p-3"><span className="text-sm">{'name'in r?r.name:`${r.code} · ${r.description}`} {!r.active&&'· Inactivo'}</span><Button size="sm" variant="outline" onClick={()=>{setTarget(r);setKind('id'in r?'categories':'units');setName('name'in r?r.name:r.description);setError(undefined);}}>Editar</Button></div>)}</div>)}</div>}
 <div className="space-y-3 rounded-lg border p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{target?'Editar maestro':'Nueva categoría'}</h3>{target&&<Button variant="ghost" onClick={()=>{setTarget(undefined);setKind('categories');setName('');}}>Nueva categoría</Button>}</div><Label htmlFor="master-name">{kind==='categories'?'Nombre de categoría':'Descripción de unidad'}</Label><Input id="master-name" value={name} onChange={e=>setName(e.target.value)} disabled={busy}/>{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}<div className="flex flex-wrap gap-2"><Button disabled={busy||!name.trim()} onClick={()=>void save(true)}>{target&&!target.active?'Reactivar y guardar':'Guardar'}</Button>{target?.active&&<Button variant="outline" disabled={busy} onClick={()=>void save(false)}>Desactivar</Button>}</div></div>
 {notice&&<p role="status" className="text-sm text-emerald-700">{notice}</p>}
 </CardContent></Card>;
}
