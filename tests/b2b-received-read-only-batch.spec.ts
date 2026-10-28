import {describe,expect,it,vi} from 'vitest';
import {readOnlyBatchSnapshot} from '../services/received-documents-service/src/b2b/automation-read-only.batch';
import type {ReadOnlyReceptionBatch} from '../services/received-documents-service/src/b2b/automation-read-only.types';
import {B2bSecurityError} from '../packages/contracts/src/b2b-security';
import {correctionEvidenceFreeze} from '../packages/service-access/src/b2b-correction-evidence-wire';

const MiB=1024*1024;
function batch(count=50,withArtifacts=false):ReadOnlyReceptionBatch{
 const contentBase64=Buffer.from('<Invoice>FICTIONAL ORIGINAL</Invoice>'.padEnd(48*1024,' ')).toString('base64');
 return {documents:Array.from({length:count},(_,index)=>({file:{fileName:`00000000002-01-FZ01-${index+1}.xml`,contentBase64},
  artifacts:withArtifacts?[{kind:'PROVIDER_PDF' as const,file:{fileName:`00000000002-01-FZ01-${index+1}.pdf`,
   contentBase64:Buffer.from('%PDF-FAKE'.padEnd(48*1024,' ')).toString('base64')}}]:[]})),
  purchases:[],incidents:[],cursor:{fingerprint:'a'.repeat(64),uidValidity:'7',lastUid:'50'}};
}
function invalid(value:unknown){
 expect(()=>readOnlyBatchSnapshot(value)).toThrow(B2bSecurityError);
 try{readOnlyBatchSnapshot(value);}catch(error){expect(error).toMatchObject({status:400,code:'INVALID_RECEIVED_READ_ONLY_BATCH'});}
}
function nested(depth:number):unknown{let value:unknown=null;for(let i=0;i<depth;i++)value={child:value};return value;}

describe('READ_ONLY batch detached snapshot with explicit 5 MiB JSON limit',()=>{
 it('accepts a batch above 3 MiB with 50 documents and small original files',()=>{
  const input=batch(),serialized=JSON.stringify(input);
  expect(Buffer.byteLength(serialized)).toBeGreaterThan(3*MiB);expect(Buffer.byteLength(serialized)).toBeLessThan(5*MiB);
  expect(input.documents).toHaveLength(50);
  for(const document of input.documents)expect(Buffer.from(document.file.contentBase64,'base64').length).toBeLessThanOrEqual(65536);
  const output=readOnlyBatchSnapshot(input);
  expect(output).toEqual(input);expect(JSON.stringify(output)).toBe(serialized);
  expect(output).not.toBe(input);expect(output.documents[0].file).not.toBe(input.documents[0].file);
  expect(Object.isFrozen(output)).toBe(true);expect(Object.isFrozen(output.documents)).toBe(true);expect(Object.isFrozen(output.documents[0].file)).toBe(true);
  input.documents[0].file.fileName='changed.xml';expect(output.documents[0].file.fileName).not.toBe('changed.xml');
 });
 it('does not widen the shared 2 MiB metadata helper',()=>{
  const input=batch();expect(()=>correctionEvidenceFreeze(input)).toThrow('INVALID_EVIDENCE_REQUEST');
  expect(readOnlyBatchSnapshot(input).documents).toHaveLength(50);
 });
 it('rejects batch JSON above 5 MiB even when each file remains below 64 KiB',()=>{
  const input=batch(50,true);expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(5*MiB);
  expect(()=>readOnlyBatchSnapshot(input)).toThrow('RECEIVED_READ_ONLY_BATCH_TOO_LARGE');
  try{readOnlyBatchSnapshot(input);}catch(error){expect(error).toMatchObject({status:409,code:'RECEIVED_READ_ONLY_BATCH_TOO_LARGE'});}
 });
 it('counts keys, quotes, colons, commas and delimiters at the exact 5 MiB boundary',()=>{
  const input={payload:''},overhead=Buffer.byteLength(JSON.stringify(input));input.payload='x'.repeat(5*MiB-overhead);
  expect(Buffer.byteLength(JSON.stringify(input))).toBe(5*MiB);expect(readOnlyBatchSnapshot(input)).toEqual(input);
  input.payload+='x';expect(()=>readOnlyBatchSnapshot(input)).toThrow('RECEIVED_READ_ONLY_BATCH_TOO_LARGE');
 });
 it('counts UTF-8 bytes and escaped JSON rather than only JS string length',()=>{
  expect(()=>readOnlyBatchSnapshot({payload:'é'.repeat(3*MiB)})).toThrow('RECEIVED_READ_ONLY_BATCH_TOO_LARGE');
  expect(()=>readOnlyBatchSnapshot({payload:'\u0000'.repeat(MiB)})).toThrow('RECEIVED_READ_ONLY_BATCH_TOO_LARGE');
  const input={'quoted"key':['a\nb','é','😺','\uD800'],numeric:-0};
  const output=readOnlyBatchSnapshot(input);expect(JSON.stringify(output)).toBe(JSON.stringify(input));expect(Object.is(output.numeric,-0)).toBe(false);
 });
 it('rejects an individual string above 5 MiB before serialization',()=>{
  expect(()=>readOnlyBatchSnapshot('x'.repeat(5*MiB+1))).toThrow('RECEIVED_READ_ONLY_BATCH_TOO_LARGE');
 });
 it('detaches repeated references separately, permitting shared data without permitting cycles',()=>{
  const shared={amount:'1.00'},input={a:shared,b:shared};const output=readOnlyBatchSnapshot(input);
  expect(output.a).toEqual(output.b);expect(output.a).not.toBe(output.b);expect(output.a).not.toBe(shared);
 });
 it('supports plain null-prototype records and frozen non-writable data properties',()=>{
  const input=Object.create(null);Object.defineProperty(input,'record',{value:Object.freeze({amount:'1.00'}),enumerable:true});
  const output=readOnlyBatchSnapshot(input);expect(output).toEqual({record:{amount:'1.00'}});expect(Object.isFrozen(output.record)).toBe(true);
 });
});

describe('batch snapshot rejects executable or non-JSON input without executing it',()=>{
 it.each(['root','nested','array','revoked'])('rejects a %s proxy without triggering traps',kind=>{
  const trap=vi.fn(()=>{throw new Error('PROXY_TRAP_EXECUTED');});
  const proxy=new Proxy(kind==='array'?[]:{},{get:trap,ownKeys:trap,getOwnPropertyDescriptor:trap,getPrototypeOf:trap});
  let input:unknown=kind==='nested'?{documents:[{file:proxy}]}:proxy;
  if(kind==='revoked'){const revocable=Proxy.revocable({},{get:trap,ownKeys:trap,getOwnPropertyDescriptor:trap,getPrototypeOf:trap});revocable.revoke();input=revocable.proxy;}
  invalid(input);expect(trap).not.toHaveBeenCalled();
 });
 it.each(['object','array','toJSON','hidden'])('rejects a %s getter without invoking it',kind=>{
  const getter=vi.fn(()=>{throw new Error('GETTER_EXECUTED');});let input:object={};
  if(kind==='array'){input=[null];Object.defineProperty(input,'0',{get:getter,enumerable:true});}
  else Object.defineProperty(input,kind==='toJSON'?'toJSON':'value',{get:getter,enumerable:kind!=='hidden'});
  invalid(input);expect(getter).not.toHaveBeenCalled();
 });
 it('rejects a setter-only descriptor without invoking it',()=>{
  const setter=vi.fn(),input={};Object.defineProperty(input,'value',{set:setter,enumerable:true});invalid(input);expect(setter).not.toHaveBeenCalled();
 });
 it('rejects an own toJSON function without invoking it',()=>{
  const hook=vi.fn(()=>({documents:[]}));invalid({documents:[],toJSON:hook});expect(hook).not.toHaveBeenCalled();
 });
 it('rejects an inherited hook/custom prototype without invoking it',()=>{
  const hook=vi.fn();invalid(Object.create({toJSON:hook}));expect(hook).not.toHaveBeenCalled();
 });
 it.each(['object','array'])('rejects %s symbol keys',kind=>{
  const input=kind==='array'?[]:{};Object.defineProperty(input,Symbol('private'),{value:'FAKE',enumerable:true});invalid(input);
 });
 it.each(['__proto__','constructor','prototype'])('rejects dangerous data key %s at any depth',key=>{
  const record=JSON.parse(`{"${key}":{"FAKE":true}}`);invalid({purchases:[{rawRecord:record}]});
 });
 it.each([NaN,Infinity,-Infinity,undefined,1n,Symbol('value'),()=>0])('rejects non-JSON/non-finite value %s',value=>{
  invalid({documents:[{value}]});
 });
 it.each([new Date(),new Map(),new Set(),new Uint8Array([1]),Buffer.from('FAKE'),new Number(1),/fake/])('rejects non-plain value %s',value=>{
  invalid({value});
 });
 it('rejects class instances and arrays with a custom prototype',()=>{
  class Fake{value='FAKE';}invalid(new Fake());const array=[];Object.setPrototypeOf(array,null);invalid(array);
 });
 it('rejects hidden properties and sparse/extended/non-enumerable-index arrays',()=>{
  const hidden={};Object.defineProperty(hidden,'private',{value:1});invalid(hidden);
  invalid(new Array(1));invalid([,1]);const extended=[1];Object.defineProperty(extended,'extra',{value:2,enumerable:true});invalid(extended);
  const nonEnumerable=[1];Object.defineProperty(nonEnumerable,'0',{value:1,enumerable:false});invalid(nonEnumerable);
 });
 it('rejects object, array and indirect cycles',()=>{
  const object:Record<string,unknown>={};object.self=object;invalid(object);
  const array:unknown[]=[];array.push(array);invalid(array);
  const first:Record<string,unknown>={},second={first};first.second=second;invalid(first);
 });
});

describe('batch snapshot structural resource limits',()=>{
 it('accepts depth 32 and rejects depth 33',()=>{
  expect(readOnlyBatchSnapshot(nested(32))).toEqual(nested(32));invalid(nested(33));
 });
 it('accepts exactly 100000 visited nodes and rejects one additional node',()=>{
  expect(readOnlyBatchSnapshot(Array.from({length:99999},()=>null))).toHaveLength(99999);
  invalid(Array.from({length:100000},()=>null));
 });
 it('limits property counts and array declarations before traversing them',()=>{
  invalid(Object.fromEntries(Array.from({length:100001},(_,i)=>[String(i),null])));invalid(new Array(100001));
 });
});
