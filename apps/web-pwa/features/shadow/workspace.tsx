"use client";
import {useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useWorkspace} from '../workspace/provider';
import {ShadowPanel} from './panel';
import type {ShadowPanelData} from './model';
export function ShadowLabWorkspace({data}:{data:ShadowPanelData}){
  const {user,can,setDirty}=useWorkspace(),router=useRouter(),[pending,startTransition]=useTransition();
  if(!can('sunat.configure')||user?.scope.kind!=='GLOBAL'||!user.roles.includes('ADMIN'))return <p role="alert" className="rounded-lg border p-6 text-sm">El modo sombra requiere un administrador general. Sólo contiene datos ficticios.</p>;
  return <ShadowPanel key={`${user.sub}:${data.report.inputSha256}`} data={data} reviewerId={user.sub} onDirtyChange={setDirty} busy={pending} onRefresh={()=>startTransition(()=>router.refresh())}/>;
}
