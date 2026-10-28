import { Body, Controller, Inject, Module, Post, Req, Res, type DynamicModule } from '@nestjs/common';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { b2bPrivatePeer } from '@factuez/service-access/dist/b2b';
import { B2bCorrectionCatalogue } from './correction-catalogue';
const CORE=Symbol('B2B correction canonical catalogue'),PEERS=Symbol('B2B correction registrar peers');
@Controller('internal/b2b')
export class B2bCorrectionCatalogueController {
  constructor(@Inject(CORE)private readonly core:B2bCorrectionCatalogue,@Inject(PEERS)private readonly peers:string[]) {}
  @Post('validate-correction-bindings') async validate(@Req()req:any,@Res()res:any,@Body()body:unknown) {
    b2bPrivatePeer(req,this.peers);res.setHeader('Cache-Control','private, no-store');
    if (!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).join(',')!=='bindings') throw new B2bSecurityError(400,'INVALID_REQUEST');
    res.status(200).json(await this.core.validate((body as any).bindings));
  }
}
@Module({})
export class B2bCorrectionCatalogueModule {
  static isolated(core:B2bCorrectionCatalogue,peers:string[]):DynamicModule {
    if (!peers.length||peers.length>100||new Set(peers).size!==peers.length||peers.some(id=>!/^[a-f0-9]{64}$/.test(id))) throw new Error('Explicit correction catalogue mTLS peers required');
    return {module:B2bCorrectionCatalogueModule,controllers:[B2bCorrectionCatalogueController],providers:[{provide:CORE,useValue:core},{provide:PEERS,useValue:peers}]};
  }
}
