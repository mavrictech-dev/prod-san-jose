import 'reflect-metadata';

export async function bootstrapIdentity() {
  if (process.env.B2B_IDENTITY_ENABLED === 'true') {
    const { bootstrapB2bIdentity } = await import('./b2b/main');
    await bootstrapB2bIdentity();
    return;
  }
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
}

if (require.main === module) void bootstrapIdentity().catch(() => {
  process.stderr.write('IDENTITY_STARTUP_BLOCKED\n');
  process.exitCode = 1;
});
