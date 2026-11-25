import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const local=createRequire(new URL('../services/billing-service/package.json',import.meta.url));
it('publishes the native GET/POST contract with current request schemas, OAuth and uncertainty semantics',()=>{
 const spec=JSON.parse(readFileSync(new URL('../apps/web-pwa/public/b2b-production.openapi.json',import.meta.url),'utf8'));
 const operations=Object.values(spec.paths).flatMap((path:any)=>Object.values(path)) as any[];
 expect(new Set(operations.map(op=>op.operationId)).size).toBe(operations.length);
 expect(Object.keys(spec.paths).some(p=>p.startsWith('/internal'))).toBe(false);
 expect(spec.paths['/b2b/oauth/token'].post.requestBody.content['application/x-www-form-urlencoded']).toBeTruthy();
 for(const path of ['issuers','branches','points','series','products','product-categories','product-units','customers','reference','documents','guides/capabilities']){
  const get=spec.paths['/b2b/v1/'+path].get;expect(get).toBeTruthy();expect(get.requestBody).toBeUndefined();
 }
 for(const path of ['documents','documents/{id}/notes','guides'])expect(spec.paths['/b2b/v1/'+path].post.parameters.some((p:any)=>p.name==='Idempotency-Key'&&p.required)).toBe(true);
 expect(spec.components.schemas.IssueInput.properties.lines.items.properties.taxAffectationCode.enum).toEqual(['10','20','30']);
 expect(spec.components.schemas.ApiProblem.properties.operationState.enum).toContain('UNCERTAIN');
 expect(spec.paths['/b2b/v1/documents/{id}/artifacts/{kind}'].get.parameters.find((p:any)=>p.name==='kind').schema.enum).toEqual(['xml','pdf','cdr']);
});
it('delivers original binary bytes only after scope and SHA-256 verification',async()=>{
 const {NativeB2bWriteController}=local('./dist/native-b2b-write.controller');
 const bytes=Buffer.from('<?xml version="1.0"?><Invoice>synthetic-original</Invoice>'),sha=createHash('sha256').update(bytes).digest('hex');let wrong=false,calls=0,allowed=true;
 const authority={actor:async()=>({kind:'SERVICE'}),rpc:()=>({post:async()=>{calls++;return {name:'synthetic.xml',mediaType:'application/xml',bytes:bytes.toString('base64'),sha256:wrong?'0'.repeat(64):sha};}})};
 const controller=new NativeB2bWriteController(authority,{document:async()=>{if(!allowed)throw Error('SCOPE_DENIED');return {document:{type:'INVOICE'},actorScope:{kind:'ASSIGNED'}};}},null,null,null);
 let delivered:Buffer|undefined,headers:any;
 const response={set:(value:any)=>{headers=value;},send:(value:Buffer)=>{delivered=value;}};
 await controller.artifact('Bearer synthetic','00000000-0000-4000-8000-000000000001','xml',{},response);
 expect(delivered?.equals(bytes)).toBe(true);expect(headers['X-Content-SHA256']).toBe(sha);
 wrong=true;delivered=undefined;await expect(controller.artifact('Bearer synthetic','00000000-0000-4000-8000-000000000001','xml',{},response)).rejects.toMatchObject({code:'ARTIFACT_HASH_MISMATCH'});expect(delivered).toBeUndefined();
 allowed=false;const before=calls;await expect(controller.artifact('Bearer synthetic','00000000-0000-4000-8000-000000000001','xml',{},response)).rejects.toThrow('SCOPE_DENIED');expect(calls).toBe(before);
});
