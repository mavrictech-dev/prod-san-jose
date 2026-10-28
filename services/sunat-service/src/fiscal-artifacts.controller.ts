import { FiscalOriginalsService } from './application/fiscal-originals.service';
import {
  Controller,
  Get,
  Header,
  Headers,
  Param,
  StreamableFile,
} from "@nestjs/common";
import { ArtifactDeliveryService } from "./application/artifact-delivery.service";

@Controller("api/v1/fiscal-artifacts")
export class FiscalArtifactsController {
  constructor(private readonly delivery: ArtifactDeliveryService, private readonly originals: FiscalOriginalsService) {}
  @Get(':documentId/original/:kind')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', "default-src 'none'; sandbox")
  async original(@Param('documentId') documentId:string,@Param('kind') kind:string,@Headers('authorization') authorization?:string){
    const result=await this.originals.download(documentId,kind,authorization);
    return new StreamableFile(result.bytes,{type:result.mediaType,disposition:`attachment; filename="${result.fileName}"`,length:result.bytes.length});
  }
  @Get(":documentId/:format")
  @Header("Cache-Control", "private, no-store")
  @Header("X-Content-Type-Options", "nosniff")
  async download(
    @Param("documentId") documentId: string,
    @Param("format") format: string,
    @Headers("authorization") authorization?: string,
  ) {
    const result = await this.delivery.download(
      documentId,
      format,
      authorization,
    );
    return new StreamableFile(result.bytes, {
      type: "application/pdf",
      disposition: `attachment; filename="${result.fileName}"`,
      length: result.bytes.length,
    });
  }
}
