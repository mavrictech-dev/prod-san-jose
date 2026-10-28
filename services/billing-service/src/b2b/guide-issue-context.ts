import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {b2bGuideBindingKey,validB2bGuideBinding} from '@factuez/contracts/b2b-guide-security';
import {boundedSupplementJson} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {fiscalSnapshotSha256} from '@factuez/sunat-core/dist/fiscal-note';
import {prepareGuide09,GuidePreparationError} from '@factuez/sunat-core/dist/fiscal-guide-preparation';
import {GuideEstablishments,type EstablishmentSnapshot,type EstablishmentAdminAuthority} from './guide-establishments';
import {GuideGoods} from './guide-goods';
import type {GuideGoodsSnapshot} from './guide-goods-types';
import {transactionBoundGuideEstablishmentStore,type GuideEstablishmentSql} from './guide-establishment-store';
import {transactionBoundGuideGoodsStore} from './guide-goods-store';
import type {GuideDraft} from './guide-model';
import type {GuideIssueBinding,GuideIssueContext,GuideIssueContextResolver} from './guide-issue-model';

const fail=(status:number,code:string):never=>{throw new B2bSecurityError(status,code);};
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=1&&v<=2147483647;
const unavailable=()=>new B2bSecurityError(503,'GUIDE_ISSUE_CONTEXT_UNAVAILABLE');
const rejectAdmin:EstablishmentAdminAuthority={verify:async()=>fail(403,'GUIDE_ISSUE_VALIDATION_ONLY')};
type Company={id:number;ruc:string;legalName:string;environment:string;configVersion:number;active:boolean};
type Branch={id:string;companyId:number;masterRevision:number;active:boolean};
type Point=Branch&{branchId:string};
type Anchor={id:string;companyId:number;emissionPointId:string;documentType:string;series:string;masterRevision:number;active:boolean};
type Counter=Anchor&{nextNumber:bigint|string};
type DraftSeries={id:string;companyId:number;pointId:string;guideType:string;label:string;revision:number;active:boolean;purpose:string};
type Mapping={draftSeriesId:string;fiscalSeriesId:string;companyId:number;revision:number;active:boolean;purpose:string};

/** Candidate-only resolver. The producer owns transaction lifetime and performs
 * one prepare BEFORE its counter CAS. This class never allocates a number,
 * opens a transaction, retries SQL, connects a client or queries at construction.
 * The producer must enforce its explicit issuer allowlist before calling this
 * port. Construction needs no database, configuration or credentials. */
export class PostgresGuideIssueContext implements GuideIssueContextResolver {

  private async masters(sql:GuideEstablishmentSql,binding:GuideIssueBinding){
    const a=binding.draft.anchor;
    const one=async<T>(text:string,values:unknown[],code:string):Promise<T>=>{
      const rows=await sql.$queryRawUnsafe<T[]>(text,...values);
      if(!Array.isArray(rows)||rows.length!==1)fail(409,code);
      return rows[0];
    };
    const company=await one<Company>(`SELECT "id","ruc","legalName","environment","configVersion","active"
      FROM "CompanySettings" WHERE "id"=$1 FOR UPDATE`,[a.issuerId],'GUIDE_ISSUE_ISSUER_INVALID');
    if(company.id!==a.issuerId||company.ruc!==a.issuerRuc||company.environment!=='BETA'||company.active!==true||
      !integer(company.configVersion)||typeof company.legalName!=='string'||!company.legalName||
      company.legalName!==company.legalName.trim()||company.legalName.length>200||
      /[\x00-\x1f\x7f-\x9f\ud800-\udfff\ufffe\uffff]/u.test(company.legalName))fail(409,'GUIDE_ISSUE_ISSUER_INVALID');
    const branch=await one<Branch>(`SELECT "id","companyId","masterRevision","active"
      FROM "Branch" WHERE "id"=$1::uuid AND "companyId"=$2 FOR SHARE`,[a.branchId,a.issuerId],'GUIDE_ISSUE_BRANCH_INVALID');
    if(branch.id!==a.branchId||branch.companyId!==a.issuerId||branch.active!==true||!integer(branch.masterRevision))
      fail(409,'GUIDE_ISSUE_BRANCH_INVALID');
    const point=await one<Point>(`SELECT "id","companyId","branchId","masterRevision","active"
      FROM "EmissionPoint" WHERE "id"=$1::uuid AND "companyId"=$2 FOR SHARE`,[a.pointId,a.issuerId],'GUIDE_ISSUE_POINT_INVALID');
    if(point.id!==a.pointId||point.companyId!==a.issuerId||point.branchId!==a.branchId||point.active!==true||!integer(point.masterRevision))
      fail(409,'GUIDE_ISSUE_POINT_INVALID');
    const anchor=await one<Anchor>(`SELECT "id","companyId","emissionPointId","documentType","series","masterRevision","active"
      FROM "SeriesCounter" WHERE "id"=$1::uuid AND "companyId"=$2 FOR SHARE`,[a.seriesId,a.issuerId],'GUIDE_ISSUE_ANCHOR_INVALID');
    if(anchor.id!==a.seriesId||anchor.companyId!==a.issuerId||anchor.emissionPointId!==a.pointId||anchor.active!==true||
      !integer(anchor.masterRevision)||anchor.documentType!==(a.documentType==='01'?'INVOICE':'SALES_RECEIPT')||
      typeof anchor.series!=='string'||!/^[A-Z0-9]{4}$/.test(anchor.series))fail(409,'GUIDE_ISSUE_ANCHOR_INVALID');
    const draftSeries=await one<DraftSeries>(`SELECT "id","companyId","pointId","guideType","label","revision","active","purpose"
      FROM "B2bGuideDraftSeries" WHERE "id"=$1::uuid AND "companyId"=$2 FOR SHARE`,
    [binding.draft.guideSeriesId,a.issuerId],'GUIDE_ISSUE_DRAFT_SERIES_INVALID');
    if(draftSeries.id!==binding.draft.guideSeriesId||draftSeries.companyId!==a.issuerId||draftSeries.pointId!==a.pointId||
      draftSeries.guideType!=='09'||draftSeries.active!==true||draftSeries.purpose!=='DRAFT_ONLY'||!integer(draftSeries.revision)||
      typeof draftSeries.label!=='string'||!/^T[A-Z0-9]{3}$/.test(draftSeries.label))fail(409,'GUIDE_ISSUE_DRAFT_SERIES_INVALID');
    const mapping=await one<Mapping>(`SELECT "draftSeriesId","fiscalSeriesId","companyId","revision","active","purpose"
      FROM "B2bGuideIssueSeries" WHERE "draftSeriesId"=$1::uuid AND "companyId"=$2 FOR SHARE`,
    [binding.draft.guideSeriesId,a.issuerId],'GUIDE_ISSUE_SERIES_MAPPING_INVALID');
    if(mapping.draftSeriesId!==binding.draft.guideSeriesId||mapping.fiscalSeriesId!==binding.fiscalSeriesId||
      mapping.companyId!==a.issuerId||mapping.active!==true||mapping.purpose!=='LOCAL_CANDIDATE'||!integer(mapping.revision))
      fail(409,'GUIDE_ISSUE_SERIES_MAPPING_INVALID');
    const fiscal=await one<Counter>(`SELECT "id","companyId","emissionPointId","documentType","series","nextNumber","masterRevision","active"
      FROM "SeriesCounter" WHERE "id"=$1::uuid AND "companyId"=$2 FOR UPDATE`,
    [binding.fiscalSeriesId,a.issuerId],'GUIDE_ISSUE_COUNTER_INVALID');
    if(fiscal.id!==binding.fiscalSeriesId||fiscal.companyId!==a.issuerId||fiscal.emissionPointId!==a.pointId||fiscal.active!==true||
      fiscal.documentType!=='DESPATCH_ADVICE'||!integer(fiscal.masterRevision)||typeof fiscal.series!=='string'||
      !/^T[A-Z0-9]{3}$/.test(fiscal.series)||fiscal.series!==draftSeries.label)fail(409,'GUIDE_ISSUE_COUNTER_INVALID');
    // pg BigInt or a canonical decimal string only: never coerce JS numbers.
    if(typeof fiscal.nextNumber!=='bigint'&&typeof fiscal.nextNumber!=='string')fail(409,'GUIDE_ISSUE_COUNTER_INVALID');
    const nextNumber=String(fiscal.nextNumber);
    if(!/^[1-9][0-9]{0,7}$/.test(nextNumber)||BigInt(nextNumber)>99999999n)fail(409,'GUIDE_ISSUE_COUNTER_INVALID');
    return {company,branch,point,anchor,draftSeries,mapping,fiscal:{...fiscal,nextNumber}};
  }

  async prepare(sql:GuideEstablishmentSql,bindingInput:GuideIssueBinding,draftInput:GuideDraft):Promise<GuideIssueContext>{
    try{
      const binding=boundedSupplementJson(bindingInput) as GuideIssueBinding;
      const draft=boundedSupplementJson(draftInput) as GuideDraft;
      if(!binding||Object.keys(binding).sort().join(',')!=='draft,fiscalSeriesId'||!validB2bGuideBinding(binding.draft)||
        !b2bUuid(binding.fiscalSeriesId)||[binding.draft.anchor.seriesId,binding.draft.guideSeriesId].includes(binding.fiscalSeriesId))
        fail(400,'INVALID_GUIDE_ISSUE_BINDING');
      if(binding.draft.guideType!=='09')fail(409,'GUIDE_ISSUE_PROFILE_NOT_ENABLED');
      if(!draft||!validB2bGuideBinding(draft.binding)||b2bGuideBindingKey(draft.binding)!==b2bGuideBindingKey(binding.draft)||
        !b2bUuid(draft.id)||!integer(draft.revision)||draft.revision>999999999||draft.state!=='READY')
        fail(409,'GUIDE_ISSUE_DRAFT_INVALID');
      // Admin registry transactions lock their registry before CompanySettings.
      // Use that same order, establishments then goods, before any master lock.
      for(const registry of ['guide-establishments','guide-goods'])
        await sql.$queryRawUnsafe(`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))`,
          `factuez:${registry}:${binding.draft.anchor.issuerId}`);
      const current=await this.masters(sql,binding);
      const issuer={ruc:current.company.ruc,legalName:current.company.legalName};
      try{prepareGuide09({schemaVersion:'factuez.guide09-preparation-input.v1',draftId:draft.id,
        draftRevision:`"v${draft.revision}"`,draftBodySha256:draft.bodySha256,issuer,body:draft.body});}
      catch(error){
        // Only fixed, bounded local validation codes; no raw driver detail.
        if(error instanceof GuidePreparationError)fail(409,'GUIDE_ISSUE_PROFILE_INVALID');
        throw error;
      }
      let establishments:EstablishmentSnapshot|null=null,goods:GuideGoodsSnapshot|null=null;
      const localStore=transactionBoundGuideEstablishmentStore(sql,current.company.id,head=>{establishments=head;});
      const goodsStore=transactionBoundGuideGoodsStore(sql,current.company.id,head=>{goods=head;});
      const local=await new GuideEstablishments(localStore,rejectAdmin).assertLocalMapping(binding.draft,draft.body);
      const eligible=await new GuideGoods(goodsStore,rejectAdmin).assertLocalGoods(binding.draft,draft.body);
      const registryStamp=()=>{
        if(!establishments||!goods)return fail(409,'GUIDE_ISSUE_REGISTRIES_REQUIRED');
        return {establishments:{revision:establishments.revision,sha256:establishments.sha256},
          goods:{revision:goods.revision,sha256:goods.sha256}};
      };
      const registries=registryStamp();
      // Re-read the locked masters and run the real guards fresh before returning.
      // The producer must not call prepare again after its own counter increment.
      if(fiscalSnapshotSha256(await this.masters(sql,binding))!==fiscalSnapshotSha256(current))
        fail(409,'GUIDE_ISSUE_CONTEXT_CHANGED');
      await local.fresh();
      await eligible.fresh();
      if(fiscalSnapshotSha256(registryStamp())!==fiscalSnapshotSha256(registries))fail(409,'GUIDE_ISSUE_CONTEXT_CHANGED');
      return {issuer,counter:{id:current.fiscal.id,series:current.fiscal.series,nextNumber:current.fiscal.nextNumber,
        masterRevision:current.fiscal.masterRevision},
      contextSha256:fiscalSnapshotSha256({schemaVersion:'factuez.guide-issue-context-local.v1',binding,masters:current,registries})};
    }catch(error){
      if(error instanceof B2bSecurityError)throw error;
      throw unavailable();
    }
  }
}
