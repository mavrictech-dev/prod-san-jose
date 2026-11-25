import {BadRequestException} from '@nestjs/common';
/** Wrap only pure input validators, never database, secret, network or signing calls. */
export function inputField<T>(field:string,code:string,validate:()=>T):T {
 try{return validate();}catch(error){
  const messages:Record<string,string>={GRE_INVALID_FIELDS:'La guía contiene campos faltantes o no admitidos por el perfil seleccionado.',GRE_INVALID_UUID:'Seleccione los identificadores del catálogo autorizado.',GRE_PROFILE_UNSUPPORTED:'Seleccione un perfil GRE implementado para este tipo de guía.',GRE_ESTABLISHMENT_MISMATCH:'El establecimiento de origen debe coincidir con el de la sede emisora.'};
  const detail=error instanceof Error?error.message.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,500):'Revise los datos del documento.';
  const message=messages[detail]??('Revise '+field+': '+detail);
  throw new BadRequestException({code,message,errors:[{field,code,message}],fieldErrors:{[field]:message}});
 }
}
