import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Static contract tests only. Never import application/bootstrap/Prisma config,
// construct a DB client, execute SQL, load dotenv, or read credential files.
const root = fileURLToPath(new URL('../', import.meta.url));
const prismaRoot = 'services/billing-service/prisma';
const blueprintPath = `${prismaRoot}/blueprints/20261003_financial_ledger_candidate.sql`;
const models = ['FinancialLedgerCommit', 'FinancialLedgerStream', 'FinancialLedgerVersion', 'FinancialLedgerEntry'] as const;
const profile = 'FACTUEZ-BETA-FINANCIAL-LEDGER-v1';
const kinds = ['NOTE_CREDIT', 'NOTE_DEBIT', 'RC_REPLACE', 'VOID'];

function read(relative: string): string {
  const absolute = resolve(root, relative);
  if (!absolute.startsWith(root) || /(?:^|[\\/])(?:\.env[^\\/]*|secrets|credentials)(?:[\\/]|$)/i.test(relative)
      || (!['.ts', '.mts', '.prisma', '.sql', '.json', '.yml'].includes(extname(relative))
          && relative !== 'docker/Dockerfile.service')) {
    throw new Error('Static ledger tests only read allowlisted source/config files');
  }
  return readFileSync(absolute, 'utf8');
}

function files(relative: string, extension: string): string[] {
  if (!existsSync(resolve(root, relative))) return [];
  return readdirSync(resolve(root, relative), { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink() || /^(?:generated|node_modules|secrets|credentials|\.git|\.env.*)$/.test(entry.name)) return [];
    const path = `${relative}/${entry.name}`;
    return entry.isDirectory() ? files(path, extension) : entry.name.endsWith(extension) ? [path] : [];
  });
}

const schema = read(`${prismaRoot}/schema.prisma`);
const blueprint = read(blueprintPath);
const sql = blueprint.replace(/--[^\n]*/g, '');
const compact = (text: string) => text.replace(/\s+/g, ' ').trim();
const quotedColumns = (columns: string[]) => columns.map(column => `"${column}"`).join(', ');
const prismaColumns = (list: string) => list.split(',').map(column => column.trim());
const sqlColumns = (list: string) => [...list.matchAll(/"(\w+)"/g)].map(match => match[1]);

function model(name: string): string {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  expect(match, `missing Prisma model ${name}`).not.toBeNull();
  return match![1];
}

function table(name: string): string {
  const match = sql.match(new RegExp(`CREATE TABLE "${name}" \\(([\\s\\S]*?)\\n\\);`));
  expect(match, `missing candidate table ${name}`).not.toBeNull();
  return match![1];
}

function scalarFields(name: string) {
  return [...model(name).matchAll(/^\s*(\w+)\s+(String|Int|Boolean|SunatEnvironment|Json|DateTime)(\?)?(.*)$/gm)]
    .map(([, name, type, nullable, attributes]) => ({ name, type, nullable: Boolean(nullable), attributes }));
}

function check(name: string, suffix: string): string {
  const marker = `CONSTRAINT "${name}_${suffix}_check" CHECK (`;
  const start = table(name).indexOf(marker);
  expect(start, `missing ${name} ${suffix} constraint`).toBeGreaterThanOrEqual(0);
  const source = table(name).slice(start + marker.length);
  let depth = 1, quoted = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "'") {
      if (quoted && source[index + 1] === "'") { index++; continue; }
      quoted = !quoted;
    }
    if (quoted) continue;
    if (char === '(') depth++;
    if (char === ')' && --depth === 0) return compact(source.slice(0, index));
  }
  throw new Error(`Unbalanced CHECK ${name}_${suffix}`);
}

function literals(text: string): string[] {
  return [...text.matchAll(/'([^']*)'/g)].map(match => match[1]);
}

function source(relative: string): ts.SourceFile {
  return ts.createSourceFile(relative, read(relative), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node); ts.forEachChild(node, child => walk(child, visit));
}

function hardClosed(relative: string, name: string): void {
  const ast = source(relative);
  const guard = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  expect(guard, `missing ${name}`).toBeDefined();
  if (!guard || !ts.isFunctionDeclaration(guard)) throw new Error(`Missing ${name}`);
  expect(guard.type?.kind).toBe(ts.SyntaxKind.NeverKeyword);
  expect(guard.parameters).toHaveLength(0);
  expect(guard.body?.statements).toHaveLength(1);
  const statement = guard.body!.statements[0];
  expect(ts.isThrowStatement(statement)).toBe(true);
  if (!ts.isThrowStatement(statement)) throw new Error(`${name} must unconditionally throw`);
  expect(ts.isNewExpression(statement.expression)).toBe(true);
  if (!ts.isNewExpression(statement.expression)) throw new Error(`${name} must throw 503`);
  // ServiceUnavailableException is Nest's HTTP 503, independent of any flags.
  expect(statement.expression.expression.getText(ast)).toBe('ServiceUnavailableException');
  const imports = ast.statements.filter(ts.isImportDeclaration);
  expect(imports.some(declaration => ts.isStringLiteral(declaration.moduleSpecifier)
    && declaration.moduleSpecifier.text === '@nestjs/common'
    && declaration.importClause?.namedBindings?.getText(ast).includes('ServiceUnavailableException'))).toBe(true);
}

describe('review-only financial ledger blueprint matches the current Prisma contract', () => {
  it('defines exactly four candidate tables, with no destructive or hidden idempotent DDL', () => {
    expect([...sql.matchAll(/CREATE TABLE "(\w+)"/g)].map(match => match[1])).toEqual(models);
    expect(blueprint).toContain('REVIEW-ONLY');
    expect(blueprint).toContain('NOT an applied migration');
    expect(sql).not.toMatch(/\b(?:ALTER|DROP|TRUNCATE|GRANT|REVOKE|INSERT|COPY|DO)\b|\bIF NOT EXISTS\b|CREATE OR REPLACE/i);
    const indexes = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX "(\w+)"\s+ON "(\w+)"\(([^)]+)\)/g)];
    expect(indexes).toHaveLength(9);
    expect(indexes.filter(match => !models.includes(match[2] as typeof models[number]))
      .map(match => [match[1], match[2], sqlColumns(match[3])]))
      .toEqual([['Document_id_companyId_key', 'Document', ['id', 'companyId']]]);
    expect(sql).not.toMatch(/^\s*(?:UPDATE|DELETE|SELECT|BEGIN|COMMIT)\s+(?:"|FROM|INTO|;)/m);
  });

  it.each(models)('%s has exactly the schema fields, PostgreSQL types, nullability and defaults', name => {
    const columns = [...table(name).matchAll(/^    "(\w+)" ([^\n]+),$/gm)];
    const fields = scalarFields(name);
    expect(columns.map(match => match[1])).toEqual(fields.map(field => field.name));
    for (const field of fields) {
      const native = field.attributes.match(/@db\.(Uuid|Char|VarChar)(?:\((\d+)\))?/);
      const type = native ? native[1] === 'Uuid' ? 'UUID'
        : `${native[1] === 'Char' ? 'CHAR' : 'VARCHAR'}(${native[2]})`
        : ({ Int: 'INTEGER', Boolean: 'BOOLEAN', SunatEnvironment: '"SunatEnvironment"', Json: 'JSONB', DateTime: 'TIMESTAMP(3)' } as Record<string, string>)[field.type];
      expect(type, `unsupported type for ${name}.${field.name}`).toBeDefined();
      const defaultValue = field.attributes.includes('@default(now())') ? ' DEFAULT CURRENT_TIMESTAMP'
        : field.attributes.includes('@default(BETA)') ? " DEFAULT 'BETA'"
        : field.attributes.includes('@default(true)') ? ' DEFAULT true' : '';
      const column = columns.find(match => match[1] === field.name)![2];
      expect(column).toBe(`${type}${field.nullable ? '' : ' NOT NULL'}${defaultValue}`);
    }
  });

  it.each(models)('%s preserves PKs, all unique keys and ordinary indexes', name => {
    const fields = scalarFields(name);
    const compoundId = model(name).match(/@@id\(\[([^\]]+)\]\)/);
    const primaryKey = compoundId ? prismaColumns(compoundId[1]) : fields.filter(field => /@id\b/.test(field.attributes)).map(field => field.name);
    expect(table(name)).toContain(`CONSTRAINT "${name}_pkey" PRIMARY KEY (${quotedColumns(primaryKey)})`);
    for (const [, kind, list] of model(name).matchAll(/@@(unique|index)\(\[([^\]]+)\]\)/g)) {
      const columns = prismaColumns(list);
      const indexName = `${name}_${columns.join('_')}_${kind === 'unique' ? 'key' : 'idx'}`;
      expect(compact(sql)).toContain(`CREATE ${kind === 'unique' ? 'UNIQUE ' : ''}INDEX "${indexName}" ON "${name}"(${quotedColumns(columns)});`);
    }
  });

  it.each(models)('%s retains every schema FK, column order and referential action', name => {
    const relations = [...model(name).matchAll(/^\s*\w+\s+(\w+)\??\s+@relation\(([^\n]+)\)\s*$/gm)];
    const foreignKeys = [...table(name).matchAll(/CONSTRAINT "(\w+)"\s+FOREIGN KEY \(([^)]+)\)\s+REFERENCES "(\w+)"\(([^)]+)\) ON DELETE (\w+) ON UPDATE (\w+)/g)];
    expect(foreignKeys).toHaveLength(relations.length);
    for (const [, target, attributes] of relations) {
      const columns = prismaColumns(attributes.match(/fields: \[([^\]]+)\]/)![1]);
      const references = prismaColumns(attributes.match(/references: \[([^\]]+)\]/)![1]);
      const foreignKey = foreignKeys.find(match => match[1] === `${name}_${columns.join('_')}_fkey`);
      expect(foreignKey, `missing scoped FK ${name}.${columns.join('/')}`).toBeDefined();
      const onDelete = attributes.match(/onDelete: (\w+)/)![1].toUpperCase();
      const onUpdate = (attributes.match(/onUpdate: (\w+)/)?.[1] ?? 'Cascade').toUpperCase();
      expect([sqlColumns(foreignKey![2]), foreignKey![3], sqlColumns(foreignKey![4]), foreignKey![5], foreignKey![6]])
        .toEqual([columns, target, references, onDelete, onUpdate]);
      if (columns.length > 1) expect([onDelete, onUpdate]).toEqual(['RESTRICT', 'RESTRICT']);
    }
  });

  it('keeps both Stream uniques and the existing scope prerequisites/reverse relations', () => {
    expect(model('FinancialLedgerStream')).toContain('@@unique([documentId, companyId])');
    expect(model('FinancialLedgerStream')).toContain('@@unique([documentId, companyId, branchId])');
    expect(model('Document')).toContain('@@unique([id, companyId])');
    expect(model('Branch')).toContain('@@unique([id, companyId])');
    expect(model('Document')).toMatch(/financialLedgerStream\s+FinancialLedgerStream\?/);
    for (const name of ['CompanySettings', 'Branch']) {
      expect(model(name)).toMatch(/financialLedgerStreams\s+FinancialLedgerStream\[\]/);
      expect(model(name)).toMatch(/financialLedgerCommits\s+FinancialLedgerCommit\[\]/);
    }
  });

  it.each(models)('%s forces candidateOnly and validates every stored scalar hash', name => {
    expect(check(name, 'candidate')).toBe('"candidateOnly" = true');
    for (const field of scalarFields(name).filter(field => field.name.endsWith('Sha256'))) {
      expect(check(name, 'hashes')).toContain(`"${field.name}" ~ '^[0-9a-f]{64}$'`);
      if (field.nullable) expect(check(name, 'hashes')).toContain(`"${field.name}" IS NULL OR`);
    }
  });

  it.each(['FinancialLedgerCommit', 'FinancialLedgerStream'])('%s forces BETA and only the published candidate profile', name => {
    expect(check(name, 'beta')).toBe('"environment" = \'BETA\'');
    expect(literals(check(name, 'profile'))).toEqual([profile]);
    const reducer = read('packages/sunat-core/src/fiscal-financial-ledger.ts');
    expect(reducer).toContain(`FISCAL_FINANCIAL_LEDGER_PROFILE = '${profile}' as const`);
  });

  it('bounds counters, states and stored kinds/outcomes without ever persisting DUPLICATE', () => {
    expect(check('FinancialLedgerStream', 'counters')).toBe('"revision" >= 0 AND "sequence" >= 0');
    expect(check('FinancialLedgerVersion', 'revision')).toBe('"revision" >= 0');
    expect(check('FinancialLedgerEntry', 'counters')).toBe('"sequence" > 0 AND "revision" >= 0');
    expect(literals(check('FinancialLedgerStream', 'state'))).toEqual(['ACTIVE', 'VOIDED']);
    expect(literals(check('FinancialLedgerEntry', 'kind'))).toEqual(kinds);
    expect(literals(check('FinancialLedgerEntry', 'outcome'))).toEqual(['APPLIED', 'REJECTED', 'EVIDENCE_UNVERIFIED']);
    expect(sql).not.toContain("'DUPLICATE'");
  });

  it.each([
    ['FinancialLedgerStream', 'currentVersion', 'currentVersion'],
    ['FinancialLedgerVersion', 'payload', 'versionPayload'],
  ])('%s fails closed on JSON null/missing keys and binds BASE/effects to revision/state/hash', (name, suffix, field) => {
    const expression = check(name, suffix);
    expect(expression).toMatch(/^COALESCE\(.*false\)$/);
    expect(expression).toContain(`jsonb_typeof("${field}") = 'object'`);
    expect(expression).toContain(`"${field}"->'revision' = to_jsonb("revision")`);
    expect(expression).toContain(`"${field}"->>'sha256' = "versionSha256"::text`);
    expect(expression).toContain(`"revision" = 0`);
    expect(expression).toContain(`"revision" > 0`);
    expect(expression).toContain(`"${field}"->>'kind' = 'BASE'`);
    expect(expression).toContain(`"${field}"->'previousSha256' = 'null'::jsonb`);
    expect(expression).toContain(`"${field}"->>'kind' IN (${kinds.map(kind => `'${kind}'`).join(', ')})`);
    expect(expression).toContain(`"${field}"->>'kind' = 'VOID'`);
    expect(literals(expression)).toEqual(expect.arrayContaining(['ACTIVE', 'VOIDED']));
  });

  it('uses dedicated append-only triggers on only the candidate tables', () => {
    const functions = [...sql.matchAll(/CREATE FUNCTION "(\w+)"\(\)/g)].map(match => match[1]);
    expect(functions).toEqual(['FinancialLedgerCandidate_append_only_guard', 'FinancialLedgerCandidate_stream_guard']);
    const triggers = [...sql.matchAll(/CREATE TRIGGER "(\w+)"\s+BEFORE UPDATE OR DELETE ON "(\w+)"\s+FOR EACH ROW EXECUTE FUNCTION "(\w+)"\(\);/g)];
    expect(triggers).toHaveLength(4);
    for (const name of ['FinancialLedgerCommit', 'FinancialLedgerVersion', 'FinancialLedgerEntry']) {
      expect(triggers.find(match => match[2] === name)?.[3]).toBe('FinancialLedgerCandidate_append_only_guard');
    }
    expect(triggers.find(match => match[2] === 'FinancialLedgerStream')?.[3]).toBe('FinancialLedgerCandidate_stream_guard');
    const immutable = sql.split('$financial_ledger_append_only$')[1];
    expect(immutable).toContain('RAISE EXCEPTION');
    expect(immutable).toContain("ERRCODE = '55000'");
    expect(immutable).not.toMatch(/RETURN NEW|IF\s/i);
  });

  it('allows stream head/CAS updates while freezing scope, originals and candidate identity', () => {
    const guard = sql.split('$financial_ledger_stream$')[1];
    expect(guard).toContain("IF TG_OP = 'DELETE' THEN");
    const rows = [...guard.matchAll(/ROW\(([\s\S]*?)\)/g)];
    const frozen = ['documentId', 'companyId', 'branchId', 'issuerRuc', 'environment', 'candidateOnly', 'profile', 'originalSnapshot', 'originalSha256', 'createdAt'];
    expect(rows).toHaveLength(2);
    expect(sqlColumns(rows[0][1])).toEqual(frozen);
    expect(sqlColumns(rows[1][1])).toEqual(frozen);
    expect(guard).toContain('IS DISTINCT FROM');
    expect(guard).toContain('NEW."revision" < OLD."revision"');
    expect(guard).toContain('NEW."sequence" < OLD."sequence"');
    expect(guard).toContain('RETURN NEW;');
    for (const mutable of ['revision', 'sequence', 'versionSha256', 'financialSnapshot', 'historyPayload', 'historySha256', 'currentVersion', 'lastCommitId', 'updatedAt']) {
      expect(frozen).not.toContain(mutable);
    }
  });

  it('stays outside migrations and out of configured deployment paths', () => {
    expect(blueprintPath).not.toContain('/migrations/');
    const migrationFiles = files(`${prismaRoot}/migrations`, '.sql');
    for (const path of migrationFiles) {
      expect(path).not.toMatch(/financial.?ledger/i);
      expect(read(path)).not.toMatch(/FinancialLedger(?:Commit|Stream|Version|Entry)|FACTUEZ-BETA-FINANCIAL-LEDGER-v1/);
    }
    expect(read('packages/database/prisma-config.ts')).toContain("migrations: { path: 'prisma/migrations' }");
    expect(read('services/billing-service/prisma.config.ts')).not.toMatch(/blueprints|financial.?ledger/i);
    for (const path of ['package.json', 'services/billing-service/package.json', 'docker/Dockerfile.service', 'docker-compose.yml', 'docker-compose.demo.yml', 'tests/compose.stage2.qa.yml']) {
      expect(read(path)).not.toMatch(/20261003_financial_ledger_candidate|prisma[\\/]blueprints/);
    }
  });
});

describe('application activation and routing remain hard closed (source/config only)', () => {
  it.each([
    ['services/billing-service/src/application/financial-ledger-candidate.service.ts', 'assertFinancialLedgerCandidateActivation'],
    ['services/billing-service/src/application/beta-supplement-command.service.ts', 'assertBillingSupplementActivation'],
    ['services/sunat-service/src/application/fiscal-readiness.service.ts', 'assertOfficialFiscalActivation'],
  ])('%s throws HTTP 503 unconditionally, even if APP/workflow flags are set', (path, name) => {
    hardClosed(path, name);
  });

  it('FinancialLedgerCandidateService guards before validation or any repository access', () => {
    const ast = source('services/billing-service/src/application/financial-ledger-candidate.service.ts');
    const candidate = ast.statements.find(statement => ts.isClassDeclaration(statement) && statement.name?.text === 'FinancialLedgerCandidateService');
    expect(candidate).toBeDefined();
    if (!candidate || !ts.isClassDeclaration(candidate)) throw new Error('Missing candidate service');
    const methods = candidate.members.filter(ts.isMethodDeclaration);
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      expect(method.body?.statements[0]?.getText(ast)).toBe('assertFinancialLedgerCandidateActivation();');
    }
    expect(ast.getText()).not.toMatch(/process\.env|ConfigService|@(?:Controller|Cron|Interval)|onModuleInit|onApplicationBootstrap/);
  });

  it('candidate constructors have no side effects when registered as internal providers', () => {
    for (const file of ['service', 'repository']) {
      const ast = source(`services/billing-service/src/application/financial-ledger-candidate.${file}.ts`);
      const name = file === 'service' ? 'FinancialLedgerCandidateService' : 'FinancialLedgerCandidateRepository';
      const candidate = ast.statements.find(statement => ts.isClassDeclaration(statement) && statement.name?.text === name);
      expect(candidate).toBeDefined();
      if (!candidate || !ts.isClassDeclaration(candidate)) throw new Error(`Missing ${name}`);
      const constructor = candidate.members.find(ts.isConstructorDeclaration);
      expect(constructor?.body?.statements).toHaveLength(0);
      expect(candidate.members.filter(ts.isPropertyDeclaration).filter(member => member.initializer)).toHaveLength(0);
      const methods = candidate.members.filter(ts.isMethodDeclaration).map(method => method.name.getText(ast));
      expect(methods).not.toContain('onModuleInit');
      expect(methods).not.toContain('onApplicationBootstrap');
    }
  });

  it('no controller/bootstrap/worker calls candidates; modules only register inert providers', () => {
    const excluded = new Set([
      'services/billing-service/src/application/financial-ledger-candidate.service.ts',
      'services/billing-service/src/application/financial-ledger-candidate.repository.ts',
    ]);
    expect(existsSync(resolve(root, [...excluded][1]))).toBe(true);
    const paths = ['billing-service', 'sunat-service'].flatMap(service => files(`services/${service}/src`, '.ts'));
    for (const path of paths.filter(path => !excluded.has(path))) {
      const ast = source(path);
      const references: string[] = [];
      walk(ast, node => {
        if (!ts.isIdentifier(node) && !ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return;
        if (!/FinancialLedgerCandidate(?:Service|Repository)|assertFinancialLedgerCandidateActivation|financial-ledger-candidate\.(?:service|repository)/.test(node.text)) return;
        // The isolated composition depends only on the repository's TS port.
        // Permit erased type references, not runtime construction/registration.
        if(path==='services/billing-service/src/application/verified-financial-commit.ts'){
          for(let p:ts.Node|undefined=node.parent;p;p=p.parent){
            if(ts.isTypeNode(p))return;
            if(ts.isImportDeclaration(p)&&p.importClause?.isTypeOnly)return;
            if(ts.isStatement(p))break;
          }
        }
        // Internal DI registration is safe only because the separately checked
        // constructors are inert and the service's first statement is the gate.
        if (path === 'services/billing-service/src/app.module.ts') {
          const parent = node.parent;
          if (ts.isImportSpecifier(parent) || ts.isImportDeclaration(parent)) return;
          if (ts.isIdentifier(node) && node.text === 'FinancialLedgerCandidateService'
              && ts.isArrayLiteralExpression(parent) && ts.isPropertyAssignment(parent.parent)
              && parent.parent.name.getText(ast) === 'providers') return;
          if (ts.isIdentifier(node) && node.text === 'FinancialLedgerCandidateRepository') {
            if (ts.isPropertyAssignment(parent) && parent.name.getText(ast) === 'provide') return;
            if (ts.isNewExpression(parent) && parent.expression === node
                && parent.arguments?.length === 1 && parent.arguments[0].getText(ast) === 'prisma'
                && ts.isArrowFunction(parent.parent) && parent.parent.body === parent
                && ts.isPropertyAssignment(parent.parent.parent)
                && parent.parent.parent.name.getText(ast) === 'useFactory') return;
          }
        }
        references.push(node.text);
      });
      expect(references, path).toEqual([]);
    }
    for(const path of ['services/billing-service/src/app.module.ts','services/sunat-service/src/app.module.ts']){
      expect(read(path)).not.toMatch(/VerifiedFinancialCommit|VerifiedSyntheticCorrectionReservations|createBetaCorrectionOwnerAssembly/);
    }
  });

  it('QA configuration keeps demo seeding and official workflow/transmission disabled', () => {
    const qa = read('tests/compose.stage2.qa.yml');
    const billing = qa.split('  billing-service:')[1].split('  sunat-service:')[0];
    const sunat = qa.split('  sunat-service:')[1].split('  sunat-emulator:')[0];
    expect(billing).toContain('FACTUEZ_DEMO_SEED: "false"');
    expect(sunat).toContain('SUNAT_BETA_WORKFLOW_ENABLED: "false"');
    expect(sunat).toContain('SUNAT_BETA_TRANSMISSION_ENABLED: "false"');
  });
});
