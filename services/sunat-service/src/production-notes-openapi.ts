/** Matches the native owner's discriminated adjustment contract. No original totals or client snapshots. */
export function productionNoteAdjustmentSchema() {
 const text={type:'string',minLength:1,maxLength:250},amount={type:'string',pattern:'^(?:0|[1-9][0-9]{0,11})\\.[0-9]{2}$'},quantity={type:'string',pattern:'^(?:0|[1-9][0-9]{0,11})(?:\\.[0-9]{1,6})?$'};
 const line=(fields:Record<string,unknown>)=>({type:'array',minItems:1,maxItems:100,items:{type:'object',additionalProperties:false,required:['originalLineNumber',...Object.keys(fields)],properties:{originalLineNumber:{type:'integer',minimum:1},...fields}}});
 const variant=(type:string,reason:string,extra:Record<string,unknown>={})=>({type:'object',additionalProperties:false,required:['documentTypeCode','reasonCode','reasonDescription',...Object.keys(extra)],properties:{documentTypeCode:{const:type},reasonCode:{const:reason},reasonDescription:text,...extra}});
 return {oneOf:[
 ...['01','02','06'].map(reason=>variant('07',reason)),
 variant('07','03',{lines:line({correctedDescription:text})}),
 variant('07','04',{amountWithTax:amount,lines:line({amountWithTax:amount})}),
 ...['05','09'].map(reason=>variant('07',reason,{lines:line({unitPriceAdjustmentWithTax:quantity})})),
 variant('07','07',{lines:line({quantity})}),
 variant('07','08',{lines:line({bonusAmountWithTax:amount,description:text})}),
 variant('07','10',{lines:line({quantity,unitPriceAdjustmentWithTax:quantity,description:text})}),
 variant('08','01',{interestNature:{const:'MORATORIO'},interestBasis:text,lines:line({interestAmount:amount})}),
 variant('08','02',{lines:line({unitPriceAdjustmentWithTax:quantity})}),
 variant('08','03',{lines:line({quantity,unitPriceAdjustmentWithTax:quantity,description:text})})
 ]};
}
export const productionNotesProfiles=['07-08-ON-01-PEN-0101-IGV18-v1','07-08-ON-01-03-PEN-0101-IGV18-v2'];
