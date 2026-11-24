import {describe,it,expect} from 'vitest';
import {guideFormItems} from '../apps/web-pwa/features/workspace/production-guides-form';
import {snapshot09} from './production-guides.fixture';
import {validateProductionGuidesSnapshot} from '../packages/sunat-core/src/production-guides';
describe('guide form fiscal request',()=>{
 it('projects reviewed catalogue goods into the exact fiscal contract without review-only metadata',()=>{
  const snapshot=snapshot09(),body=snapshot.body as any,original=body.items[0];
  const catalog=[{code:original.code,description:original.description,unitCode:original.unitCode,classification:'NON_REGULATED'}];
  const items=guideFormItems(catalog,[{code:original.code,quantity:original.quantity}]);
  expect(items[0]).not.toHaveProperty('classification');
  expect(validateProductionGuidesSnapshot({...snapshot,body:{...body,items}}).body).toMatchObject({items});
 });
 it('rejects a missing product and nonpositive quantities before any reservation',()=>{
  expect(()=>guideFormItems([], [{code:'MISSING',quantity:'1'}])).toThrow();
  expect(()=>guideFormItems([{code:'A',description:'A',unitCode:'NIU'}],[{code:'A',quantity:'0'}])).toThrow();
 });
});
