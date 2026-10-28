import {describe,it,expect} from 'vitest';
import {mailerHealth} from '../services/mailer-worker/src/health';
describe('Mailer liveness without fictitious transport readiness',()=>{
 it('no enabled transport reports disabled',()=>expect(mailerHealth({})).toEqual({status:'ok',transport:'DISABLED',transports:{corporateSmtp:false,corporateDocuments:false,localCapture:false},readiness:'NOT_PROBED',deliveredToClient:false}));
 it('local capture is explicit',()=>expect(mailerHealth({LOCAL_MAIL_QA_ENABLED:'true'}).transport).toBe('LOCAL_MAILPIT'));
 it('production does not pretend to use Mailpit',()=>{const r=mailerHealth({SERVER_SMTP_ENABLED:'true',SERVER_SMTP_DOCUMENTS_ENABLED:'true'});expect(r.transport).toBe('CORPORATE_SMTP');expect(r.transports).toEqual({corporateSmtp:true,corporateDocuments:true,localCapture:false});expect(r.readiness).toBe('NOT_PROBED');expect(r.deliveredToClient).toBe(false);});
 it('document flag alone cannot enable SMTP',()=>expect(mailerHealth({SERVER_SMTP_DOCUMENTS_ENABLED:'true'}).transports.corporateDocuments).toBe(false));
 it('reports both enabled modes without hiding local capture',()=>{const r=mailerHealth({SERVER_SMTP_ENABLED:'true',LOCAL_MAIL_QA_ENABLED:'true'});expect(r.transport).toBe('CORPORATE_SMTP');expect(r.transports.localCapture).toBe(true);});
 it('does not serialize secret environment values',()=>{const r=JSON.stringify(mailerHealth({SMTP_PASSWORD:'do-not-print',SMTP_SETTINGS_KEY_FILE:'/private/path',SERVER_SMTP_ENABLED:'TRUE'}));expect(r).not.toContain('do-not-print');expect(r).not.toContain('/private/path');expect(JSON.parse(r).transport).toBe('DISABLED');});
});
