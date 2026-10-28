import {createRequire} from 'node:module';
import {describe,expect,it,vi} from 'vitest';
import {annotateShadowReview,compareShadowCase} from '../packages/shadow-core/src';
const require=createRequire(import.meta.url),fixture=require('../migration/fixtures/shadow-development.cjs'),f=require('./helpers/history-full-fixtures.cjs');
function example(){
  const c=fixture.run().cases[1],r=compareShadowCase(c);
  return {c,review:{schemaVersion:'factuez.shadow-review.v1',environment:'BETA',datasetClass:'SYNTHETIC',mode:'SHADOW',
    caseId:r.caseId,inputSha256:r.inputSha256,reviewerId:f.uuid(900),decisions:[{differenceId:r.differences[0].id,category:'LEGACY_BUG_PENDING_APPROVAL',reason:'Hipotesis ficticia que requiere validacion del cliente'}]}};
}
describe('fase 4: clasificación registrada sin aprobación ni efectos',()=>{
  it('cuarta categoría no se convierte en bug aceptado o diferencia resuelta',()=>{
    const {c,review}=example(),before=JSON.stringify({c,review}),r=annotateShadowReview(c,review);
    expect(r).toMatchObject({accountingApproved:false,reviewRequired:true,reviewerIdentityAuthenticated:false,annotationsOnly:true,
      transmission:false,countersChanged:false,annotatedDifferenceCount:1});
    expect(r.annotations[0]).toMatchObject({originalCategory:'CORRECTION_REQUIRED',proposedCategory:'LEGACY_BUG_PENDING_APPROVAL'});
    expect(r.unresolvedDifferenceCount).toBe(r.report.differenceCount);expect(JSON.stringify({c,review})).toBe(before);
    expect(Object.isFrozen(r.annotations[0])).toBe(true);
  });
  it.each(['CORRECTION_REQUIRED','COSMETIC','DATA_MISSING'])('anotación %s conserva la gravedad original',category=>{
    const {c,review}=example();review.decisions[0].category=category;
    const r=annotateShadowReview(c,review);expect(r.report.counts.CORRECTION_REQUIRED).toBeGreaterThan(0);
    expect(r.annotations[0].originalCategory).toBe('CORRECTION_REQUIRED');expect(r.report.comparativeMatch).toBe(false);
  });
  it('hash obsoleto tras cambiar XML/snapshot no se reutiliza',()=>{
    const {c,review}=example();c.factuez.snapshot.customer.legalName='CAMBIADO QA';expect(()=>annotateShadowReview(c,review)).toThrow(/SHADOW_REVIEW_STALE/);
  });
  it('otra identidad de caso se rechaza',()=>{
    const {c,review}=example();review.caseId=f.uuid(123);expect(()=>annotateShadowReview(c,review)).toThrow(/SHADOW_REVIEW_STALE/);
  });
  it('otra diferencia, duplicado o categoría aprobada se rechaza',()=>{
    const {c,review}=example();review.decisions[0].differenceId='f'.repeat(64);expect(()=>annotateShadowReview(c,review)).toThrow(/SHADOW_REVIEW_DIFFERENCE_UNKNOWN/);
    const other=example();other.review.decisions.push(other.review.decisions[0]);expect(()=>annotateShadowReview(other.c,other.review)).toThrow(/SHADOW_REVIEW_DIFFERENCE_UNKNOWN/);
    const third=example();third.review.decisions[0].category='APPROVED';expect(()=>annotateShadowReview(third.c,third.review)).toThrow(/SHADOW_REVIEW_CATEGORY_INVALID/);
  });
  it.each(['environment','datasetClass','mode','schemaVersion'])('rechaza perfil de anotación inválido: %s',field=>{
    const {c,review}=example();(review as any)[field]='PRODUCTION';expect(()=>annotateShadowReview(c,review)).toThrow(/SHADOW_PROFILE_BLOCKED/);
  });
  it('no admite un flag de cierre o una identidad autenticada enviada por el caller',()=>{
    const {c,review}=example();(review as any).approved=true;expect(()=>annotateShadowReview(c,review)).toThrow(/INVALID_FIELDS/);
  });
  it('no ejecuta getter para decisiones',()=>{
    const {c,review}=example(),getter=vi.fn();Object.defineProperty(review,'decisions',{enumerable:true,get:getter});
    expect(()=>annotateShadowReview(c,review)).toThrow();expect(getter).not.toHaveBeenCalled();
  });
});
