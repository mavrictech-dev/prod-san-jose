import { validB2bBinding, type B2bBinding } from '@factuez/contracts/b2b-security';
import { Phase8AdminOperation, adminDenied, adminDigest, adminResult, adminOwnerError, adminPick,
  type Phase8AdminAccess, type Phase8AdminAction, type Phase8AdminDependencies, type Phase8AdminBindingOwner
} from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import { StationAdminService } from '../application/station-admin.service';
import { PrintBrandingService } from '../application/print-branding.service';
import type { PrismaService } from '../infrastructure/prisma.service';

const masterActions = ['MASTERS_READ','ISSUER_CREATE','ISSUER_UPDATE','BRANCH_CREATE','BRANCH_UPDATE','POINT_CREATE','POINT_UPDATE','SERIES_CREATE','SERIES_UPDATE'];
const printActions = ['PRINT_READ','PRINT_SAVE','PRINT_PREVIEW'];
const issuerKeys = ['id','ruc','legalName','tradeName','taxAddress','ubigeo','phone','contactEmails','environment','active','revision'];
const branchKeys = ['id','companyId','code','name','address','active','effectiveActive','revision','pointCount','openShiftCount'];
const pointKeys = ['id','companyId','branchId','code','name','address','trackNumber','active','effectiveActive','revision','openShiftCount'];
const seriesKeys = ['id','companyId','emissionPointId','documentType','series','nextNumber','active','effectiveActive','revision','documentCount','canRename'];
const settingsKeys = ['template','logoMode','logoWidthMm','logoAlignment','showBranchAddress','footerNote'];

/** Real Billing catalogue adapter; no other service reads Billing tables. */
export class BillingPhase8AdminBindingOwner implements Phase8AdminBindingOwner {
  constructor(private readonly prisma: PrismaService) {}
  async revalidate(binding: B2bBinding) {
    if (!validB2bBinding(binding)) return adminDenied(400,'INVALID_ADMIN_BINDING');
    return this.prisma.$transaction(async tx => {
      const issuer = await tx.companySettings.findUnique({where:{id:binding.issuerId},select:{id:true,ruc:true,environment:true}});
      const branch = await tx.branch.findUnique({where:{id:binding.branchId},select:{id:true,companyId:true}});
      const point = await tx.emissionPoint.findUnique({where:{id:binding.pointId},select:{id:true,companyId:true,branchId:true}});
      const series = await tx.seriesCounter.findUnique({where:{id:binding.seriesId},select:{id:true,companyId:true,emissionPointId:true,documentType:true}});
      if (!issuer || issuer.ruc !== binding.issuerRuc || issuer.environment !== 'BETA' ||
        !branch || branch.companyId !== issuer.id || !point || point.companyId !== issuer.id || point.branchId !== branch.id ||
        !series || series.companyId !== issuer.id || series.emissionPointId !== point.id ||
        series.documentType !== (binding.documentType === '01' ? 'INVOICE' : 'SALES_RECEIPT'))
        return adminDenied(403,'ADMIN_OWNER_BINDING_CHANGED');
      return {binding:{...binding},revision:adminDigest({issuer,branch,point,series})};
    },{isolationLevel:'RepeatableRead'});
  }
}

/** Closed action map over actual business service instances. Constructors perform no I/O. */
export class B2bPhase8BillingAdmin {
  constructor(private readonly deps: Phase8AdminDependencies,
    private readonly owners: {masters?: StationAdminService; branding?: PrintBrandingService} = {}) {}
  async execute(access: Phase8AdminAccess, action: Phase8AdminAction, input: unknown) {
    let op: Phase8AdminOperation | undefined;
    try {
      if (![...masterActions,...printActions].includes(action)) return adminDenied(400,'INVALID_ADMIN_ACTION');
      op = await Phase8AdminOperation.open(this.deps,access,action,input);
      const {binding:b,payload:p,id} = op.input;
      const actor = await op.revalidate(), req = {headers:{},user:actor};
      let data: unknown;
      if (masterActions.includes(action)) {
        const owner = this.owners.masters;
        if (!owner) return adminDenied(503,'ADMIN_OWNER_UNAVAILABLE');
        const expectedId = action === 'ISSUER_UPDATE' ? String(b.issuerId) :
          action === 'BRANCH_UPDATE' || action === 'POINT_CREATE' ? b.branchId :
          action === 'POINT_UPDATE' || action === 'SERIES_CREATE' ? b.pointId :
          action === 'SERIES_UPDATE' ? b.seriesId : undefined;
        if (id !== expectedId) return adminDenied(400,'ADMIN_TARGET_MISMATCH');
        if (action === 'BRANCH_CREATE' && p.companyId !== b.issuerId) return adminDenied(403,'ADMIN_TARGET_MISMATCH');
        // Series renames and historical/counter mutations are deliberately absent in delegated administration.
        if (action === 'SERIES_UPDATE' && Object.hasOwn(p,'series')) return adminDenied(400,'ADMIN_SERIES_RENAME_BLOCKED');
        switch (action) {
          case 'MASTERS_READ': {
            if (Object.keys(p).length) return adminDenied(400,'INVALID_ADMIN_PAYLOAD');
            const r = await owner.catalog(req);
            data = {version:r.version,capabilities:{betaOnly:true,softDelete:true,counterEditing:false},
              companies:r.companies.filter(v=>v.id===b.issuerId).map(v=>adminPick(v,issuerKeys)),
              branches:r.branches.filter(v=>v.id===b.branchId).map(v=>adminPick(v,branchKeys)),
              emissionPoints:r.emissionPoints.filter(v=>v.id===b.pointId).map(v=>adminPick(v,pointKeys)),
              series:r.series.filter(v=>v.id===b.seriesId).map(v=>adminPick(v,seriesKeys))}; break;
          }
          case 'ISSUER_CREATE': data = adminPick(await owner.createIssuer(p,req),issuerKeys); break;
          case 'ISSUER_UPDATE': data = adminPick(await owner.updateIssuer(id!,p,req),issuerKeys); break;
          case 'BRANCH_CREATE': data = adminPick(await owner.createBranch(p,req),branchKeys); break;
          case 'BRANCH_UPDATE': data = adminPick(await owner.updateBranch(id!,p,req),branchKeys); break;
          case 'POINT_CREATE': {
            const r = await owner.createPoint(id!,p,req);
            data = {...adminPick(r,pointKeys),series:r.series.map(v=>adminPick(v,seriesKeys))}; break;
          }
          case 'POINT_UPDATE': data = adminPick(await owner.updatePoint(id!,p,req),pointKeys); break;
          case 'SERIES_CREATE': data = adminPick(await owner.createSeries(id!,p,req),seriesKeys); break;
          case 'SERIES_UPDATE': data = adminPick(await owner.updateSeries(id!,p,req),seriesKeys); break;
          default: return adminDenied(400,'INVALID_ADMIN_ACTION');
        }
      } else {
        const owner = this.owners.branding;
        if (!owner) return adminDenied(503,'ADMIN_OWNER_UNAVAILABLE');
        if (id !== undefined) return adminDenied(400,'ADMIN_TARGET_MISMATCH');
        if (action === 'PRINT_PREVIEW') {
          const r = await owner.preview(String(b.issuerId),b.branchId,p,actor);
          // Base64 plus metadata must fit the shared 2 MiB owner response envelope.
          if (!Buffer.isBuffer(r.bytes) || r.bytes.length > 1_500_000) return adminDenied(503,'INVALID_ADMIN_OWNER_RESPONSE');
          data = {base64:r.bytes.toString('base64'),contentType:'application/pdf',fileName:r.fileName};
        } else {
          if (action === 'PRINT_READ' && Object.keys(p).length) return adminDenied(400,'INVALID_ADMIN_PAYLOAD');
          const r = action === 'PRINT_READ' ? await owner.settings(String(b.issuerId),b.branchId,actor)
            : await owner.save(String(b.issuerId),b.branchId,p,actor);
          data = {...adminPick(r,['version','companyId','ruc','branchId','revision','updatedAt','source','storageReady','fiscalTransmission']),
            override:r.override ? adminPick(r.override,settingsKeys) : null,effective:adminPick(r.effective,settingsKeys),
            logoConfigured:!!r.logoPreviewDataUrl};
        }
      }
      await op.revalidate();
      return adminResult(data);
    } catch (error) { throw adminOwnerError(error); }
    finally { op?.close(); }
  }
}

