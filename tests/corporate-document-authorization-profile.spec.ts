import {describe,it,expect} from 'vitest';
import {activeDocumentGrant,documentConfigurationDigest,DOCUMENT_AUTHORIZATION_PROFILE} from '../services/mailer-worker/src/corporate-document-policy';
import {configurationDigest,activeGrant} from '../services/mailer-worker/src/corporate-mail.policy';
const row={companyId:1,ruc:'00000000001',revision:3,keyVersion:1,configurationCipher:'encrypted-synthetic-only',updatedAt:new Date()};
const grant={companyId:1,issuerRuc:row.ruc,enabled:true,revision:2,configurationRevision:3,configurationDigest:configurationDigest(row),updatedBy:'synthetic',updatedAt:new Date()};
describe('DOCUMENT scope upgrade requires a new human activation',()=>{
 it('legacy 01/03 grant is not automatically widened to notes',()=>{expect(activeGrant(grant,row)).toBe(true);expect(activeDocumentGrant(grant,row)).toBe(false);});
 it('new document grant cannot activate TEST and requires same issuer/revision',()=>{const g={...grant,configurationDigest:documentConfigurationDigest(row)};expect(activeDocumentGrant(g,row)).toBe(true);expect(activeGrant(g,row)).toBe(false);expect(activeDocumentGrant(g,{...row,revision:4})).toBe(false);expect(activeDocumentGrant(g,{...row,companyId:2})).toBe(false);expect(activeDocumentGrant(g,{...row,ruc:'00000000002'})).toBe(false);expect(activeDocumentGrant({...g,enabled:false},row)).toBe(false);});
 it('new proof is scoped while preserving the existing encrypted configuration',()=>{const before=JSON.stringify(row);expect(documentConfigurationDigest(row)).toMatch(/^[a-f0-9]{64}$/);expect(documentConfigurationDigest(row)).not.toBe(configurationDigest(row));expect(JSON.stringify(row)).toBe(before);expect(DOCUMENT_AUTHORIZATION_PROFILE).toContain('01-03-07-08.v2');});
});
