type Good={code:string;description:string;unitCode:string};
/** Catalogue review metadata stays on the server; the fiscal body is closed. */
export function guideFormItems(approved:readonly Good[]|undefined,selection:readonly {code:string;quantity:string}[]){
 return selection.map(row=>{
  const good=approved?.find(candidate=>candidate.code===row.code);
  if(!good||!/^\d{1,12}(\.\d{1,6})?$/.test(row.quantity)||Number(row.quantity)<=0)throw Error('Seleccione bienes y cantidades mayores que cero');
  return {code:good.code,description:good.description,unitCode:good.unitCode,quantity:row.quantity};
 });
}
