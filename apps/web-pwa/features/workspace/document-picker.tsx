"use client";
import { useState } from 'react';
import Link from 'next/link';
import { useResource,useWorkspace } from './provider';
import type { DocumentPage } from './types';
import { Card,CardContent } from '@factuez/ui/components/card';
import { Input } from '@factuez/ui/components/input';
import { Button } from '@factuez/ui/components/button';
import { ErrorState,Loading,money } from './common';
export function DocumentPicker(){
  const {companyId,branchId}=useWorkspace();const [q,setQ]=useState('');const [page,setPage]=useState(1);
  const params=new URLSearchParams({page:String(page),q});if(companyId)params.set('companyId',companyId);if(branchId)params.set('branchId',branchId);
  const r=useResource<DocumentPage>(`/api/v1/documents?${params}`);
  return <Card className="shadow-none"><CardContent className="space-y-4"><Input aria-label="Buscar original de nota" value={q} onChange={e=>{setQ(e.target.value);setPage(1);}} placeholder="Número o cliente…" maxLength={100}/>{r.error?<ErrorState message={r.error}/>:!r.data?<Loading/>:<><div className="divide-y">{r.data.items.filter(d=>/^00\d{9}$/.test(d.issuerRuc)).map(d=><div key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="font-medium">{d.fullNumber} · {money(d.payableAmount,d.currencyCode)}</p><p className="text-xs text-muted-foreground">{d.issuerRuc} · {d.customerLegalName} · {d.branchName}</p></div><Button asChild variant="outline"><Link href={`/notes/${d.id}`}>Preparar nota</Link></Button></div>)}</div><p className="text-xs text-muted-foreground">Sólo identificadores ficticios 00…. Crea una operación de prueba en Terminal de pista si no hay uno.</p><div className="flex gap-2"><Button variant="outline" disabled={page===1} onClick={()=>setPage(page-1)}>Anterior</Button><Button variant="outline" disabled={page*r.data.pageSize>=r.data.total} onClick={()=>setPage(page+1)}>Siguiente</Button></div></>}</CardContent></Card>;
}
