import type {GreAdministrationDraft} from '@factuez/contracts';
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const sameGreValue=(a:unknown,b:unknown)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const equal=sameGreValue;
export function mergeGreAdministration(base:GreAdministrationDraft,local:GreAdministrationDraft,remote:GreAdministrationDraft,choices:Record<string,'local'|'remote'>={}){
 const value=structuredClone(remote),conflicts:{key:string;label:string}[]=[];
 for(const group of ['vehicles','drivers','routes','approvals']as const){
  const ids=new Set([...local[group],...remote[group]].map(r=>r.id)),rows:any[]=[];
  for(const id of ids){const a=base[group].find(r=>r.id===id),l=local[group].find(r=>r.id===id),r=remote[group].find(r=>r.id===id),key=group+':'+id;
   const conflict=!equal(l,a)&&!equal(r,a)&&!equal(l,r);if(conflict&&!choices[key])conflicts.push({key,label:(l as any)?.plate??(l as any)?.name??(l as any)?.firstName??'Habilitación revisada'});
   const selected=conflict?(choices[key]==='local'?l:r):!equal(l,a)?l:r;if(selected)rows.push(selected);
  }(value as any)[group]=rows;
 }
 const conflict=!equal(local.goodsCodes,base.goodsCodes)&&!equal(remote.goodsCodes,base.goodsCodes)&&!equal(local.goodsCodes,remote.goodsCodes);if(conflict&&!choices.goods)conflicts.push({key:'goods',label:'Selección de bienes'});value.goodsCodes=conflict?(choices.goods==='local'?local.goodsCodes:remote.goodsCodes):!equal(local.goodsCodes,base.goodsCodes)?local.goodsCodes:remote.goodsCodes;
 return {value,conflicts};
}
