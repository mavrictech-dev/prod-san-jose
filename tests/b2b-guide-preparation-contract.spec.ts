import {describe,it,expect} from 'vitest';
import {b2bCandidateOpenApiV1} from '../packages/contracts/src/b2b-read-openapi';

describe('B2B07 guide preparation contract is read/preflight only',()=>{
  it('documents the actual POST without claiming issuance or requiring an idempotency receipt',()=>{
    const api=b2bCandidateOpenApiV1(),route:any=api.paths['/b2b/v1/guide-drafts/{id}/preparation'].post;
    expect(route).toMatchObject({operationId:'b2bPrepareGuideDraft','x-source-implemented':true,'x-runtime-enabled':false,'x-read-only':true});
    expect(route['x-required-scopes']).toEqual(['b2b:documents:read','b2b:guides:read']);
    expect(route.parameters.map((p:any)=>p.name)).toEqual(['id','X-FactuEz-Actor-Kind','If-Match']);
    expect(route.responses['201']).toBeUndefined();expect(route.responses['202']).toBeUndefined();
    expect(route.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/GuideDraftFreeze');
  });
  it('defines no fiscal number, XML or acceptance in the response',()=>{
    const api=b2bCandidateOpenApiV1(),s:any=api.components.schemas;
    expect(s.GuidePreparationPlan.properties.numberReserved.const).toBe(false);
    expect(s.GuidePreparationPlan.properties.signatureVerified.const).toBe(false);
    expect(s.GuidePreparationPlan.properties.officialRulesValidated.const).toBe(false);
    for(const schema of [s.GuidePreparation,s.GuidePreparationPlan]){
      expect(schema.additionalProperties).toBe(false);expect(schema.properties.transmissionAuthorized.const).toBe(false);
      expect(schema.properties.authorizedForTransfer.const).toBe(false);expect(schema.properties.fiscalExecutionEnabled.const).toBe(false);
      for(const field of ['number','series','xml','cdr','accepted','certificate','password'])expect(schema.properties[field]).toBeUndefined();
    }
  });
  it('explicitly restricts the profile and declares missing fiscal gates',()=>{
    const s:any=b2bCandidateOpenApiV1().components.schemas,body=s.GuidePreparationBody.properties;
    expect(body.reasonCode.const).toBe('04');expect(body.regulatedGoods.const).toBe(false);expect(body.references.maxItems).toBe(0);
    expect(body.transport.properties.mode.const).toBe('02');expect(s.GuidePreparationPlan.properties.profile.const).toContain('GRE09-PRIVATE04');
    expect(s.GuidePreparation.properties.gates.const).toContain('ESTABLISHMENT_MAPPING');
    expect(s.GuidePreparation.properties.gates.const).toContain('OFFICIAL_XSL_RULES');
    expect(s.GuidePreparation.properties.gates.const).toContain('SUNAT_TRANSPORT_AND_CDR');
  });
});
