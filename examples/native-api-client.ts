/** Native user-authorized API client. OAuth B2B has a separate contract; no hidden fallback. */
export class NativeApiError extends Error {
 constructor(public readonly status:number,public readonly indeterminate=false){super(indeterminate?'Resultado sin confirmar: consulte usando la misma Idempotency-Key antes de reenviar.':'La API rechazó o no pudo completar la solicitud.');this.name='NativeApiError';}
}
export type NativeIssueResponse={documentId:string;companyId:number;issuerRuc:string;fullNumber:string;sunatStatus:string};
export type NativeOriginalKind='xml'|'submission-zip'|'cdr-xml'|'cdr-zip';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export class NativeApiClient {
 #token?:string;#origin:string;#fetch:typeof fetch;
 constructor(origin:string,options:{fetch?:typeof fetch;allowLocalDevelopment?:boolean}={}){
  const u=new URL(origin),local=options.allowLocalDevelopment===true&&u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname);
  if(u.origin!==origin||u.username||u.password||u.protocol!=='https:'&&!local)throw new Error('Se requiere el origen HTTPS exacto autorizado por TI.');
  this.#origin=origin;this.#fetch=options.fetch??fetch;
 }
 clearSession(){this.#token=undefined;}
 async #call(path:string,options:{method?:'GET'|'POST';body?:unknown;key?:string;binary?:boolean;uncertain?:boolean}={}){
  const method=options.method??'GET';
  if(!path.startsWith('/api/v1/')||path.includes('://')||/[\r\n]/.test(path))throw new Error('Ruta nativa inválida.');
  const headers:Record<string,string>={Accept:options.binary?'application/xml, application/zip, application/pdf':'application/json','Cache-Control':'no-store'};
  if(this.#token)headers.Authorization='Bearer '+this.#token;
  if(options.body!==undefined)headers['Content-Type']='application/json';
  if(options.key)headers['Idempotency-Key']=options.key;
  let response:Response;
  try{response=await this.#fetch(this.#origin+path,{method,headers,body:options.body===undefined?undefined:JSON.stringify(options.body),redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(options.binary?30000:20000)});}
  catch{throw new NativeApiError(0,options.uncertain===true);}
  if(!response.ok){await response.body?.cancel();if(response.status===401)this.clearSession();throw new NativeApiError(response.status,options.uncertain===true&&response.status>=500);}
  const max=options.binary?10*1024*1024:2*1024*1024,reader=response.body?.getReader();if(!reader)throw new NativeApiError(502,options.uncertain===true);
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max)throw new Error();chunks.push(value);}}
  catch{await reader.cancel().catch(()=>{});throw new NativeApiError(502,options.uncertain===true);}
  const bytes=new Uint8Array(size);let offset=0;for(const b of chunks){bytes.set(b,offset);offset+=b.length;}
  if(options.binary){const mediaType=response.headers.get('content-type')?.split(';')[0].trim();
   const name=/^attachment; filename="([A-Za-z0-9_-]+\.(?:pdf|xml|zip))"$/.exec(response.headers.get('content-disposition')??'')?.[1];
   if(!name||!['application/xml','application/zip','application/pdf'].includes(mediaType??''))throw new NativeApiError(502);
   return {bytes,filename:name,mediaType};
  }
  try{if(response.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw Error();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch{throw new NativeApiError(502,options.uncertain===true);}
 }
 async login(username:string,password:string){
  this.clearSession();
  if(typeof username!=='string'||!username.trim()||username.length>80||typeof password!=='string'||!password||password.length>256)throw new Error('Credenciales requeridas.');
  const result=await this.#call('/api/v1/auth/login',{method:'POST',body:{username,password}});
  if(result.tokenType!=='Bearer'||typeof result.accessToken!=='string'||!/^[-A-Za-z0-9_.]{1,8192}$/.test(result.accessToken)||!Number.isSafeInteger(result.expiresIn)||result.expiresIn<1)throw new NativeApiError(502);
  this.#token=result.accessToken;return{tokenType:'Bearer',expiresIn:result.expiresIn};
 }
 #authenticated(){if(!this.#token)throw new Error('Inicie sesión con un usuario autorizado.');}
 catalog(){this.#authenticated();return this.#call('/api/v1/documents/catalog/issuance');}
 me(){this.#authenticated();return this.#call('/api/v1/auth/me');}
 list(filters:{companyId?:number;branchId?:string;query?:string}={}){
  this.#authenticated();const q=new URLSearchParams();
  if(filters.companyId!==undefined){if(!Number.isSafeInteger(filters.companyId)||filters.companyId<1)throw Error('Emisor inválido.');q.set('companyId',String(filters.companyId));}
  if(filters.branchId!==undefined){if(!uuid.test(filters.branchId))throw Error('Sede inválida.');q.set('branchId',filters.branchId);}
  if(filters.query!==undefined){if(typeof filters.query!=='string'||filters.query.length>200)throw Error('Búsqueda inválida.');q.set('query',filters.query);}
  return this.#call('/api/v1/documents'+(q.size?'?'+q.toString():''));
 }
 detail(id:string){this.#authenticated();if(!uuid.test(id))throw Error('Comprobante inválido.');return this.#call('/api/v1/documents/'+id);}
 async issue(body:Record<string,unknown>,idempotencyKey:string):Promise<NativeIssueResponse>{
  this.#authenticated();if(!body||!['INVOICE','SALES_RECEIPT'].includes(String(body.documentType))||!/^[-a-zA-Z0-9_]{1,100}$/.test(idempotencyKey))throw Error('Perfil o Idempotency-Key inválidos.');
  // Caller persists this key with the sale before calling. Never retries POST or obtains a fresh key automatically.
  const result=await this.#call('/api/v1/documents',{method:'POST',body,key:idempotencyKey,uncertain:true});
  if(!uuid.test(result?.documentId)||!Number.isSafeInteger(result.companyId)||!/^\d{11}$/.test(result.issuerRuc)||typeof result.fullNumber!=='string'||typeof result.sunatStatus!=='string')throw new NativeApiError(502,true);
  return result;
 }
 original(id:string,kind:NativeOriginalKind){this.#authenticated();if(!uuid.test(id)||!['xml','submission-zip','cdr-xml','cdr-zip'].includes(kind))throw Error('Original inválido.');return this.#call('/api/v1/fiscal-artifacts/'+id+'/original/'+kind,{binary:true});}
 pdf(id:string,format:'a4'|'ticket'='a4'){this.#authenticated();if(!uuid.test(id)||!['a4','ticket'].includes(format))throw Error('PDF inválido.');return this.#call('/api/v1/fiscal-artifacts/'+id+'/'+format,{binary:true});}
}
