import type {CreditObservation,OriginalReference} from './commercial-model';
const SHA=/^[a-f0-9]{64}$/;
const cents=(value:unknown):bigint|null=>typeof value==='string'&&/^\d{1,16}\.\d{2}$/.test(value)?BigInt(value.replace('.','')):null;
const money=(n:bigint)=>`${n/100n}.${String(n%100n).padStart(2,'0')}`;
/** Local diagnostic only: no forged acceptance, reservation, release or spendable balance. */
export function assessCorrectionDeclarations(original:OriginalReference,rows:CreditObservation[]){
  const problems:string[]=[],amount=cents(original.payableAmount);
  if(amount===null||amount<=0n||!['PEN','USD'].includes(original.currency)||!SHA.test(original.snapshotSha256))problems.push('ORIGINAL_DECLARATION_INCONSISTENT');
  if(!Array.isArray(rows)||rows.length>100)return {
    observedCreditCount:Math.min(Array.isArray(rows)?rows.length:0,101),observedCreditTotal:null,illustrativeRemainingAmount:null,
    currency:original.currency,withinLimit:false,historyCompleteness:'NOT_VERIFIED' as const,problems:['LOCAL_CREDIT_HISTORY_LIMIT_EXCEEDED'],spendableBalance:false as const,
    trust:'LOCAL_DECLARATIONS_NOT_FISCAL_EVIDENCE' as const,rejectedProjectionsReleaseBalance:false as const,
  };
  let total=0n;
  for(const row of rows){
    const declared=cents(row.declaredAmount),snapshot=cents(row.snapshotAmount);
    if(declared===null||declared<=0n||snapshot===null||declared!==snapshot)problems.push('CREDIT_DECLARATION_INCONSISTENT');
    if(row.currency!==original.currency)problems.push('CREDIT_CURRENCY_MISMATCH');
    if(row.referenceDocumentId!==original.id||row.referenceSha256!==original.snapshotSha256)problems.push('CREDIT_REFERENCE_NOT_BOUND');
    if(declared!==null)total+=declared;
  }
  if(amount!==null&&total>amount)problems.push('OBSERVED_CREDITS_EXCEED_ORIGINAL');
  const unique=[...new Set(problems)];
  return {observedCreditCount:rows.length,observedCreditTotal:unique.length?null:money(total),
    illustrativeRemainingAmount:unique.length||amount===null?null:money(amount-total),currency:original.currency,
    withinLimit:true,historyCompleteness:'NOT_VERIFIED' as const,problems:unique,spendableBalance:false as const,trust:'LOCAL_DECLARATIONS_NOT_FISCAL_EVIDENCE' as const,rejectedProjectionsReleaseBalance:false as const};
}
