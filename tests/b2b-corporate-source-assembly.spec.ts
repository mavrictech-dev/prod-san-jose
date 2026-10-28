import {describe,it,expect,vi} from 'vitest';
import {createCorporateEmailWithSource} from '../services/mailer-worker/src/b2b/corporate-source-assembly';
import {OwnerEmailDeliveryDocumentSource} from '../services/mailer-worker/src/b2b/email-deliveries.source';
import {corporateEmailFixture} from './b2b-email-deliveries-corporate.fixture';

const options={enabled:true,realSendEnabled:true,profile:'CORPORATE' as const,approvedHosts:['smtp.corporate.example.org']};
function setup(){
 const h=corporateEmailFixture();
 const concrete=new OwnerEmailDeliveryDocumentSource(h.artifacts);
 const source={authorizeDocumentCurrent:vi.fn(concrete.authorizeDocumentCurrent.bind(concrete))};
 const assemble=(o=options)=>createCorporateEmailWithSource({store:h.store,identity:h.identity,source,execution:h.execution,owner:h.owner,network:h.network,options:o});
 return {...h,source,assemble};
}
describe('isolated corporate composition with explicit document source',()=>{
 it('is inert until invoked and rejects a missing source',()=>{
  const h=setup();h.assemble();
  expect(h.source.authorizeDocumentCurrent).not.toHaveBeenCalled();expect(h.network.resolve).not.toHaveBeenCalled();expect(h.configurations.read).not.toHaveBeenCalled();
  expect(()=>createCorporateEmailWithSource({store:h.store,identity:h.identity,source:null as any,execution:h.execution,owner:h.owner})).toThrow('B2B_MAILER_EMAIL_SOURCE_REQUIRED');
 });
 it('uses the supplied source for synthetic attachment creation and dispatch',async()=>{
  const h=setup(),app=h.assemble();
  const job=await app.engine.execute({token:'synthetic-token',kind:'SERVICE'},'CREATE',h.input);
  expect(h.sendMail).not.toHaveBeenCalled();
  expect(await app.run(job.id)).toMatchObject({state:'SMTP_ACCEPTED',deliveredToClient:false});
  expect(h.source.authorizeDocumentCurrent.mock.calls.length).toBeGreaterThan(1);
  const message=h.sendMail.mock.calls[0][0];expect(message.attachments).toHaveLength(3);
  for(const original of h.originals)expect(message.attachments.find((a:any)=>a.filename===original.fileName).content).toEqual(original.bytes);
  expect(h.network.createTransport).toHaveBeenCalledWith(expect.objectContaining({requireTLS:true,tls:expect.objectContaining({rejectUnauthorized:true,minVersion:'TLSv1.2'})}));
 });
 it('fails closed when the source is revoked before dispatch',async()=>{
  const h=setup(),app=h.assemble(),job=await app.engine.execute({token:'synthetic-token',kind:'SERVICE'},'CREATE',h.input);
  h.source.authorizeDocumentCurrent.mockRejectedValue(new Error('synthetic revocation'));
  await expect(app.run(job.id)).rejects.toThrow();
  expect(h.sendMail).not.toHaveBeenCalled();expect(h.network.resolve).not.toHaveBeenCalled();
 });
 it('requires the independent real-send switch',async()=>{
  const h=setup(),app=h.assemble({...options,realSendEnabled:false});
  await expect(app.engine.execute({token:'synthetic-token',kind:'SERVICE'},'CREATE',h.input)).rejects.toMatchObject({code:'EMAIL_CORPORATE_DISABLED'});
  expect(h.network.resolve).not.toHaveBeenCalled();expect(h.sendMail).not.toHaveBeenCalled();
 });
});