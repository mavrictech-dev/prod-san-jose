import { B2bSecurityError, validB2bCorrectionBinding, b2bCorrectionBindingKey, type B2bCorrectionBinding } from '@factuez/contracts/b2b-security';
import type { PrismaService } from '../infrastructure/prisma.service';
export interface CorrectionPairRepository { valid(binding: B2bCorrectionBinding): Promise<boolean> }
export class B2bCorrectionCatalogue {
  constructor(private readonly repository: CorrectionPairRepository) {}
  async validate(bindings: unknown) {
    if (!Array.isArray(bindings) || !bindings.length || bindings.length > 500 || !bindings.every(validB2bCorrectionBinding) ||
      new Set(bindings.map(b2bCorrectionBindingKey)).size !== bindings.length) throw new B2bSecurityError(400,'INVALID_CORRECTION_BINDINGS');
    for (const b of bindings) if (!await this.repository.valid(b)) throw new B2bSecurityError(400,'INVALID_CORRECTION_BINDINGS');
    return {valid:true};
  }
}
/** One hierarchy per pair. Note types never pass through the old 01/03 ternary. */
export class PrismaB2bCorrectionPairRepository implements CorrectionPairRepository {
  constructor(private readonly db: PrismaService) {}
  async valid(b: B2bCorrectionBinding) {
    if (!validB2bCorrectionBinding(b)) return false;
    const r = b.reference;
    const rows = await this.db.seriesCounter.findMany({where:{companyId:r.issuerId,emissionPointId:r.pointId,active:true,
      company:{ruc:r.issuerRuc,environment:'BETA',active:true},
      emissionPoint:{id:r.pointId,companyId:r.issuerId,branchId:r.branchId,active:true,branch:{id:r.branchId,companyId:r.issuerId,active:true}},
      OR:[{id:r.seriesId,documentType:r.documentType==='01'?'INVOICE':'SALES_RECEIPT'},
        {id:b.noteSeriesId,documentType:b.noteType==='07'?'CREDIT_NOTE':'DEBIT_NOTE'}]},select:{id:true,series:true}});
    const original = rows.find(s=>s.id===r.seriesId), note = rows.find(s=>s.id===b.noteSeriesId);
    const pattern = r.documentType==='01'?/^F[A-Z0-9]{3}$/:/^B[A-Z0-9]{3}$/;
    return rows.length===2 && !!original && !!note && pattern.test(original.series) && pattern.test(note.series);
  }
}
