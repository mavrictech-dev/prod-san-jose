import {types} from 'node:util';
import {validB2bBinding,b2bBindingKey,type B2bBinding} from './b2b-security';

/** Independent draft-guide permission; an anchor is a catalogue context, NOT
 * an invoice reference or an implicit 09/31 grant. Never widen the 01/03 reader. */
export type B2bGuideBinding={anchor:B2bBinding;guideSeriesId:string;guideType:'09'|'31'};
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export function validB2bGuideBinding(value:unknown):value is B2bGuideBinding{
  if(!value||typeof value!=='object'||types.isProxy(value)||Array.isArray(value))return false;
  const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null)return false;
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);
  if(keys.length!==3||keys.some(k=>typeof k!=='string'||!['anchor','guideSeriesId','guideType'].includes(k)||!descriptors[k].enumerable||!Object.hasOwn(descriptors[k],'value')))return false;
  const anchor=descriptors.anchor?.value;
  if(!anchor||typeof anchor!=='object'||types.isProxy(anchor)||Array.isArray(anchor))return false;
  if(![Object.prototype,null].includes(Object.getPrototypeOf(anchor)))return false;
  if(Reflect.ownKeys(anchor).some(k=>typeof k!=='string'||!Object.hasOwn(Object.getOwnPropertyDescriptor(anchor,k)!,'value')))return false;
  if(typeof Object.getOwnPropertyDescriptor(anchor,'documentType')?.value!=='string')return false;
  return validB2bBinding(anchor)&&uuid(descriptors.guideSeriesId.value)&&descriptors.guideSeriesId.value!==anchor.seriesId&&['09','31'].includes(descriptors.guideType.value);
}
export function b2bGuideBindingKey(value:B2bGuideBinding){return JSON.stringify([b2bBindingKey(value.anchor),value.guideSeriesId,value.guideType]);}

/** A third, explicitly enrolled series is required to reserve a guide number.
 * Draft WRITE never implies this grant. It does not widen the 01/03 principal. */
export type B2bGuideIssueBinding={draft:B2bGuideBinding;fiscalSeriesId:string};
export type B2bGuideIssueAction='ISSUE'|'READ';
export const b2bGuideIssueScopes=['b2b:documents:read','b2b:guides:issue'] as const;
export const b2bGuideIssueReadScopes=['b2b:documents:read','b2b:guides:read','b2b:guide-operations:read'] as const;
export function validB2bGuideIssueBinding(value:unknown):value is B2bGuideIssueBinding{
  if(!value||typeof value!=='object'||types.isProxy(value)||Array.isArray(value))return false;
  const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null)return false;
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);
  if(keys.length!==2||keys.some(k=>typeof k!=='string'||!['draft','fiscalSeriesId'].includes(k)||
    !descriptors[k].enumerable||!Object.hasOwn(descriptors[k],'value')))return false;
  const draft=descriptors.draft.value,id=descriptors.fiscalSeriesId.value;
  return validB2bGuideBinding(draft)&&uuid(id)&&new Set([draft.anchor.seriesId,draft.guideSeriesId,id]).size===3;
}
export function b2bGuideIssueBindingKey(value:B2bGuideIssueBinding){return JSON.stringify([b2bGuideBindingKey(value.draft),value.fiscalSeriesId]);}
