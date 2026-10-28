import { createServer, request } from 'node:https';
import { createServer as tlsServer, type TLSSocket } from 'node:tls';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { expect } from 'vitest';
import { b2bCertificates } from './b2b-tls.fixture';
import { visitMailbox, mailboxOptions } from '../services/received-documents-service/src/automation/mailbox';
import { SireReadClient } from '../services/received-documents-service/src/automation/sire-client';
import { fixtureSirePurchases } from '../services/received-documents-service/src/automation/sire-fixture';
import { SIRE_RCE_HEADERS } from '../services/received-documents-service/src/automation/sire-parser';
import type { ReceptionConnectors } from '../services/received-documents-service/src/automation/connectors';
const local=createRequire(new URL('../packages/received-core/package.json',import.meta.url));
const AdmZip=local('adm-zip');
export async function syntheticTransports(raw:Buffer, ruc:string, period:string){
  const pki=b2bCertificates(), sockets=new Set<TLSSocket>();
  const commands:string[]=[], paths:string[]=[]; let exports=0, failTicket=false, nextUid=2;
  const track=(socket:TLSSocket)=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));};
  const zip=new AdmZip(); zip.addFile('purchases.txt',Buffer.from(SIRE_RCE_HEADERS.join('|')+'|\r\n'+Object.values(fixtureSirePurchases(ruc,period)[0].rawRecord).join('|')+'|\r\n'));
  const ticket='20261000000001';
  const https=createServer({key:pki.key,cert:pki.server},(req,res)=>{
    const url=new URL(req.url!,'https://localhost'); paths.push(url.pathname);
    req.resume();req.on('end',()=>{
      res.setHeader('content-type','application/json');
      if(url.pathname.endsWith('/token/'))return res.end(JSON.stringify({access_token:'SYNTHETIC-TOKEN',token_type:'bearer'}));
      if(url.pathname.includes('exportacioncomprobantepropuesta')){exports++;return res.end(JSON.stringify({numTicket:ticket}));}
      if(url.pathname.endsWith('consultaestadotickets')){
        if(failTicket){res.statusCode=503;return res.end('{}');}
        const page=url.searchParams.get('page');
        return res.end(JSON.stringify({paginacion:{page:Number(page),perPage:20,totalRegistros:2},registros:page==='1'?[{numTicket:'20261000000999',perTributario:period}]:[{numTicket:ticket,perTributario:period,codProceso:'10',codEstadoProceso:'06',detalleTicket:{numTicket:ticket},archivoReporte:[{nomArchivoReporte:'report.zip',codTipoArchivoReporte:'01'}]}]}));
      }
      if(url.pathname.endsWith('archivoreporte')){res.setHeader('content-type','application/octet-stream');return res.end(zip.toBuffer());}
      res.statusCode=404;res.end('{}');
    });
  });
  const imap=tlsServer({key:pki.key,cert:pki.server},socket=>{
    track(socket);socket.write('* OK synthetic IMAP ready\r\n');let pending='';
    socket.on('data',bytes=>{pending+=bytes.toString();let e:number;while((e=pending.indexOf('\r\n'))>=0){
      const line=pending.slice(0,e);pending=pending.slice(e+2);const [tag,verb]=line.split(' '),upper=line.toUpperCase();commands.push(verb.toUpperCase());
      if(upper.includes(' CAPABILITY'))socket.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR\r\n'+tag+' OK capability\r\n');
      else if(upper.includes(' AUTHENTICATE PLAIN')||upper.includes(' LOGIN '))socket.write(tag+' OK authenticated\r\n');
      else if(upper.includes(' LIST ')||upper.includes(' LSUB '))socket.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n'+tag+' OK listed\r\n');
      else if(upper.includes(' EXAMINE '))socket.write('* FLAGS (\\Seen)\r\n* '+(nextUid-1)+' EXISTS\r\n* OK [UIDVALIDITY 91] valid\r\n* OK [UIDNEXT '+nextUid+'] next\r\n'+tag+' OK [READ-ONLY] examined\r\n');
      else if(upper.includes(' UID FETCH ')){
        if(upper.includes('RFC822.SIZE') && !upper.includes('BODY.PEEK[')){
          for(let uid=1;uid<nextUid;uid++)socket.write('* '+uid+' FETCH (UID '+uid+' RFC822.SIZE '+raw.length+')\r\n');
          socket.write(tag+' OK fetched\r\n');
        }else if(upper.includes('BODY.PEEK[')){
          const uid=Number(line.match(/UID FETCH (\d+)/i)?.[1]??1),offset=Number(line.match(/<(\d+)\.\d+>/)?.[1]??0),data=raw.subarray(offset);
          socket.write('* '+uid+' FETCH (UID '+uid+' RFC822.SIZE '+raw.length+' BODY[]<'+offset+'> {'+data.length+'}\r\n');socket.write(data);socket.write(')\r\n'+tag+' OK fetched\r\n');
        }else socket.write(tag+' BAD forbidden fetch\r\n');
      }else if(upper.includes(' LOGOUT'))socket.end('* BYE closed\r\n'+tag+' OK logout\r\n');
      else if(upper.includes(' NOOP'))socket.write(tag+' OK noop\r\n');
      else socket.write(tag+' BAD forbidden command\r\n');
    }});
  });
  https.on('connection',socket=>track(socket as TLSSocket));imap.on('connection',socket=>track(socket as TLSSocket));https.on('secureConnection',track);https.on('tlsClientError',()=>{});imap.on('tlsClientError',()=>{});
  await Promise.all([https,imap].map(server=>new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);}))); 
  const fakeFetch:typeof fetch=async(input,init={})=>{
    const original=new URL(String(input));expect(['api-seguridad.sunat.gob.pe','api-sire.sunat.gob.pe']).toContain(original.hostname);
    return new Promise<Response>((resolve,reject)=>{
      const req=request({host:'127.0.0.1',port:(https.address() as any).port,path:original.pathname+original.search,method:init.method,headers:Object.fromEntries(new Headers(init.headers).entries()),ca:pki.ca,servername:'localhost',rejectUnauthorized:true,minVersion:'TLSv1.2',signal:init.signal??undefined},res=>{const chunks:Buffer[]=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode})));});
      req.on('error',reject);req.end(init.body);
    });
  };
  const {ImapFlow}=createRequire(new URL('../services/received-documents-service/package.json',import.meta.url))('imapflow');
  const factory=(options:ReturnType<typeof mailboxOptions>)=>{
    expect(options.secure).toBe(true);expect(options.tls.rejectUnauthorized).toBe(true);expect(options.port).toBe(993);expect(options.tls.lookup).toBeTypeOf('function');
    return new ImapFlow({...options,host:'127.0.0.1',port:(imap.address() as any).port,servername:'localhost',tls:{...options.tls,servername:'localhost',ca:pki.ca}});
  };
  const connectors:ReceptionConnectors={
    sire:credentials=>new SireReadClient(credentials,{fetch:fakeFetch,liveAllowed:true}),
    mailbox:(m,p,c,consume,allowed)=>visitMailbox(m,p,c,consume,allowed,factory),
    validateMailbox:async(m,p)=>{const client=factory(mailboxOptions(m,p,true));client.on('error',()=>{});try{await client.connect();const lock=await client.getMailboxLock(m.folder,{readOnly:true});lock.release();}finally{client.close();}},
  };
  return {connectors,commands,paths,get exports(){return exports;},replaceMessage(value:Buffer){raw=value;},failTicket(value:boolean){failTicket=value;},addDuplicate(){nextUid++;},async close(){https.closeAllConnections();for(const socket of sockets)socket.destroy();await Promise.all([https,imap].map(s=>new Promise<void>(r=>s.close(()=>r()))));}};
}
