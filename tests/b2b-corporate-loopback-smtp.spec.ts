import {createRequire} from 'node:module';
import {createServer,type TLSSocket} from 'node:tls';
import {describe,it,expect,vi} from 'vitest';
import {corporateEmailFixture} from './b2b-email-deliveries-corporate.fixture';
import {createCorporateEmailWithSource} from '../services/mailer-worker/src/b2b/corporate-source-assembly';
import {OwnerEmailDeliveryDocumentSource} from '../services/mailer-worker/src/b2b/email-deliveries.source';
import {corporateEmailPki} from './b2b-email-deliveries-corporate-tls.fixture';
const {createTransport}=createRequire(new URL('../services/mailer-worker/package.json',import.meta.url))('nodemailer');

describe('SMTP corporativo B2B contra capturador TLS local ficticio',()=>{
 it('entrega un mensaje con tres adjuntos al servidor local sin salida externa',async()=>{
  const pki=corporateEmailPki(),messages:string[]=[];let authenticated=false;
  const server=createServer({key:pki.server.key,cert:pki.server.cert,minVersion:'TLSv1.2'},(socket:TLSSocket)=>{
   let pending='',dataMode=false,body='',login=0,username='';
   socket.write('220 local-test ESMTP\r\n');
   socket.on('data',(chunk:Buffer)=>{pending+=chunk.toString('utf8');let n:number;
    while((n=pending.indexOf('\r\n'))>=0){const line=pending.slice(0,n);pending=pending.slice(n+2);
     if(dataMode){if(line==='.') {messages.push(body);dataMode=false;socket.write('250 2.0.0 captured\r\n');}else body+=line+'\r\n';continue;}
     if(login){if(login++===1){username=Buffer.from(line,'base64').toString('utf8');socket.write('334 UGFzc3dvcmQ6\r\n');}else{login=0;authenticated=username==='synthetic-user'&&Buffer.from(line,'base64').toString('utf8')==='fictional-password';socket.write(authenticated?'235 2.7.0 authenticated\r\n':'535 5.7.8 rejected\r\n');}continue;}
     if(/^EHLO /i.test(line))socket.write('250-local-test\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10485760\r\n');
     else if(/^AUTH PLAIN /i.test(line)){authenticated=Buffer.from(line.split(' ')[2],'base64').toString('utf8')==='\0synthetic-user\0fictional-password';socket.write(authenticated?'235 2.7.0 authenticated\r\n':'535 5.7.8 rejected\r\n');}
     else if(/^AUTH LOGIN/i.test(line)){login=1;socket.write('334 VXNlcm5hbWU6\r\n');}
     else if(/^MAIL FROM:|^RCPT TO:/i.test(line))socket.write('250 2.1.0 ok\r\n');
     else if(line==='DATA'){body='';dataMode=true;socket.write('354 end with dot\r\n');}
     else if(line==='QUIT'){socket.write('221 bye\r\n');socket.end();}
     else socket.write('250 ok\r\n');
    }
   });
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try{
   const port=(server.address() as {port:number}).port;
   const f=corporateEmailFixture();f.configuration.port=465;f.configuration.tlsMode='TLS';
   f.network.createTransport=vi.fn((opts:any)=>{
    expect(opts.tls.rejectUnauthorized).toBe(true);expect(opts.auth.user).toBe('synthetic-user');
    // Redirect only this fixture to its loopback-only ephemeral TLS server.
    return createTransport({...opts,host:'127.0.0.1',port,secure:true,tls:{...opts.tls,servername:'127.0.0.1',ca:pki.ca}});
   });
   const app=createCorporateEmailWithSource({store:f.store,identity:f.identity,source:new OwnerEmailDeliveryDocumentSource(f.artifacts),
    execution:f.execution,owner:f.owner,network:f.network,options:{enabled:true,realSendEnabled:true,profile:'CORPORATE',approvedHosts:['smtp.corporate.example.org']}});
   const created=await app.engine.execute({token:'synthetic-token',kind:'SERVICE'},'CREATE',f.input);
   expect(await app.run(created.id)).toMatchObject({state:'SMTP_ACCEPTED',deliveredToClient:false});
   expect(authenticated).toBe(true);expect(messages).toHaveLength(1);
   expect(messages[0]).toContain('sender@example.invalid');expect(messages[0]).toContain('recipient@example.invalid');
   expect(messages[0]).toContain('filename=original.xml');expect(messages[0]).toContain('filename=original.zip');expect(messages[0]).toContain('application/pdf');
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
 },60000);
});
