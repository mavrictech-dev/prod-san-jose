import { Module } from '@nestjs/common';
import { GreQaController } from './gre-qa.controller';
import { GreQaService } from './application/gre-qa.service';
import { GreQaSigningService } from './application/gre-qa-sign.service';
import { PrismaService } from './infrastructure/prisma.service';
import { ArtifactStore } from './infrastructure/artifact-store';
import { SecretVault } from './infrastructure/crypto/secret-vault';
import { XsdValidationService } from './infrastructure/sunat/xsd-validation.service';
/** Integrar AppModule.imports=[GreQaModule]. No registra el adaptador oficial. */
@Module({controllers:[GreQaController],providers:[GreQaService,GreQaSigningService,PrismaService,ArtifactStore,SecretVault,XsdValidationService]})
export class GreQaModule {}
