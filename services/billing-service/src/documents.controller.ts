import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Header,
  HttpCode,
  Post,
  Param,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { PermissionCodes } from "@factuez/contracts";
import { randomUUID } from "node:crypto";
import {
  IssueDocumentService,
  type IssueDocumentInput,
} from "./application/issue-document.service";
import {
  JwtPermissionGuard,
  RequiredPermissions,
  type AuthenticatedRequest,
} from "./auth/jwt-permission.guard";
import { IssuanceQueryService } from "./application/issuance-query.service";
import { calculateDocumentTotals } from "./application/totals";

@Controller("api/v1/documents")
@UseGuards(JwtPermissionGuard)
export class DocumentsController {
  constructor(
    private readonly issueDocument: IssueDocumentService,
    private readonly issuanceQuery: IssuanceQueryService,
  ) {}

  @Get("catalog/issuance")
  @Header("Cache-Control", "private, no-store")
  @RequiredPermissions(PermissionCodes.DOCUMENT_VIEW)
  async catalog(@Req() request: AuthenticatedRequest) {
    return this.issuanceQuery.catalog(request.user!.scope);
  }

  @Get("dashboard")
  @Header("Cache-Control", "private, no-store")
  @RequiredPermissions(PermissionCodes.REPORT_VIEW)
  dashboard(
    @Req() request: AuthenticatedRequest,
    @Query("branchId") branchId?: string,
    @Query("companyId") companyId?: string,
    @Query("dataSource") dataSource?: string,
  ) {
    return this.issuanceQuery.dashboard(
      request.user!.scope,
      branchId,
      companyId,
      dataSource,
    );
  }

  @Post("preview")
  @RequiredPermissions(PermissionCodes.DOCUMENT_ISSUE)
  preview(@Body() body: Pick<IssueDocumentInput, "lines">) {
    if (
      !Array.isArray(body?.lines) ||
      !body.lines.length ||
      body.lines.length > 100
    )
      throw new BadRequestException("Ítems inválidos");
    try {
      return calculateDocumentTotals(body.lines);
    } catch {
      throw new BadRequestException(
        "Revise cantidades, precios y afectación de los ítems",
      );
    }
  }

  @Get()
  @Header("Cache-Control", "private, no-store")
  @RequiredPermissions(PermissionCodes.DOCUMENT_VIEW)
  async recent(
    @Req() request: AuthenticatedRequest,
    @Query("branchId") branchId?: string,
    @Query("companyId") companyId?: string,
    @Query("page") page?: string,
    @Query("q") query?: string,
    @Query("dataSource") dataSource?: string,
  ) {
    return this.issuanceQuery.recentDocuments(
      request.user!.scope,
      branchId,
      Number(page ?? 1),
      query ?? "",
      companyId,
      dataSource,
    );
  }

  @Post()
  @HttpCode(202)
  @RequiredPermissions(PermissionCodes.DOCUMENT_ISSUE)
  async issue(
    @Body() body: IssueDocumentInput,
    @Headers("idempotency-key") idempotencyKey: string,
    @Req() request: AuthenticatedRequest,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    const user = request.user;
    if (!user)
      throw new Error("El guard de autenticación no agregó la identidad");
    if (!idempotencyKey || !/^[a-zA-Z0-9_-]{1,100}$/.test(idempotencyKey))
      throw new BadRequestException("Idempotency-Key inválida");
    const result = await this.issueDocument.execute(body, {
      idempotencyKey: `${user.sub}:${idempotencyKey}`,
      scope: user.scope,
      authorization: typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined,
      userId: user.sub,
      correlationId: correlationId ?? randomUUID(),
    });
    return {
      documentId: result.id,
      companyId: result.companyId,
      issuerRuc: (
        result.immutableSnapshot as { issuer?: { identityNumber?: string } }
      ).issuer?.identityNumber,
      fullNumber: result.fullNumber,
      sunatStatus: result.sunatStatus,
    };
  }

  @Get(":documentId")
  @Header("Cache-Control", "private, no-store")
  @RequiredPermissions(PermissionCodes.DOCUMENT_VIEW)
  detail(
    @Req() request: AuthenticatedRequest,
    @Param("documentId") documentId: string,
  ) {
    return this.issuanceQuery.documentDetail(request.user!.scope, documentId);
  }
}
