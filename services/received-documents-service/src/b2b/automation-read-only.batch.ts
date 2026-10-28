import {isProxy} from 'node:util/types';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';

// This allowance belongs only to the reception READ_ONLY batch boundary.
// Metadata, admission and other wire contracts retain their shared 2 MiB cap.
const MAX_BYTES=5*1024*1024,MAX_NODES=100000,MAX_DEPTH=32;
const invalid:()=>never=()=>{throw new B2bSecurityError(400,'INVALID_RECEIVED_READ_ONLY_BATCH');};
const tooLarge:()=>never=()=>{throw new B2bSecurityError(409,'RECEIVED_READ_ONLY_BATCH_TOO_LARGE');};

/** Detached, recursively frozen JSON for an untrusted source batch. Inspect
 * descriptors before reading values: no proxy trap, accessor or toJSON hook
 * executes. The owner still validates the batch schema and per-file limits. */
export function readOnlyBatchSnapshot<T>(value:T):T{
 let nodes=0,bytes=0;
 const ancestors=new Set<object>();
 const charge=(size:number)=>{bytes+=size;if(bytes>MAX_BYTES)tooLarge();};
 const quoted=(text:string)=>{
  if(text.length>MAX_BYTES)tooLarge();
  charge(Buffer.byteLength(JSON.stringify(text),'utf8'));
 };
 const visit=(item:unknown,depth:number):unknown=>{
  if(++nodes>MAX_NODES||depth>MAX_DEPTH)invalid();
  if(item===null){charge(4);return null;}
  if(typeof item==='boolean'){charge(item?4:5);return item;}
  if(typeof item==='string'){quoted(item);return item;}
  if(typeof item==='number'){
   if(!Number.isFinite(item))invalid();
   charge(JSON.stringify(item).length);return item===0?0:item;
  }
  if(!item||typeof item!=='object'||isProxy(item)||ancestors.has(item))invalid();
  const array=Array.isArray(item),prototype=Object.getPrototypeOf(item);
  if(prototype!==(array?Array.prototype:Object.prototype)&&!(prototype===null&&!array))invalid();
  const keys=Reflect.ownKeys(item);
  if(keys.length>MAX_NODES)invalid();
  for(const key of keys)if(typeof key!=='string'||['__proto__','constructor','prototype'].includes(key))invalid();
  const descriptors=Object.getOwnPropertyDescriptors(item);
  ancestors.add(item);charge(2);
  if(array){
   // Genuine arrays have an own, non-accessor length. Reject holes, symbols,
   // hidden/extra properties and non-data indices rather than JSON coercion.
   const length=descriptors.length.value as number;
   if(length>MAX_NODES||keys.length!==length+1)invalid();
   const output:unknown[]=[];
   for(let index=0;index<length;index++){
    const descriptor=descriptors[String(index)];
    if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))invalid();
    if(index)charge(1);
    output.push(visit(descriptor.value,depth+1));
   }
   ancestors.delete(item);return Object.freeze(output);
  }
  const output:Record<string,unknown>={};
  for(let index=0;index<keys.length;index++){
   const key=keys[index] as string,descriptor=descriptors[key];
   if(!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))invalid();
   if(index)charge(1);
   quoted(key);charge(1);
   Object.defineProperty(output,key,{value:visit(descriptor.value,depth+1),enumerable:true});
  }
  ancestors.delete(item);return Object.freeze(output);
 };
 return visit(value,0) as T;
}
