import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  // Next.js conserva JSX para su compilador; las pruebas SSR sí lo transforman.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: { alias: [
    { find: /^@factuez\/service-access\/dist\/b2b-billing-authority-wire$/, replacement: fileURLToPath(new URL("./packages/service-access/src/b2b-billing-authority-wire.ts", import.meta.url)) },
    { find: /^@factuez\/service-access\/dist\/b2b-email-actor$/, replacement: fileURLToPath(new URL("./packages/service-access/src/b2b-email-actor.ts", import.meta.url)) },
    { find: /^@factuez\/service-access\/dist\/b2b-owner-administration$/, replacement: fileURLToPath(new URL("./packages/service-access/src/b2b-owner-administration.ts", import.meta.url)) },
    { find: /^@factuez\/service-access\/dist\/b2b-phase8-admin-wire$/, replacement: fileURLToPath(new URL("./packages/service-access/src/b2b-phase8-admin-wire.ts", import.meta.url)) },
    { find: /^@factuez\/service-access\/dist\/b2b-received-wire$/, replacement: fileURLToPath(new URL("./packages/service-access/src/b2b-received-wire.ts", import.meta.url)) },
    { find: /^@factuez\/service-access\/dist\/b2b-guide-preparation-wire$/, replacement: fileURLToPath(new URL("./packages/service-access/src/b2b-guide-preparation-wire.ts", import.meta.url)) },
    { find: /^@factuez\/contracts\/b2b-guide-security$/, replacement: fileURLToPath(new URL("./packages/contracts/src/b2b-guide-security.ts", import.meta.url)) },
    { find: /^@factuez\/service-access\/dist\/b2b-correction-evidence-wire$/, replacement: fileURLToPath(new URL("./packages/service-access/src/b2b-correction-evidence-wire.ts", import.meta.url)) },
    { find: /^@factuez\/contracts\/b2b-security$/, replacement: fileURLToPath(new URL("./packages/contracts/src/b2b-security.ts", import.meta.url)) },
    { find: /^@factuez\/contracts\/b2b-read-query$/, replacement: fileURLToPath(new URL("./packages/contracts/src/b2b-read-query.ts", import.meta.url)) },
    { find: /^@factuez\/service-access\/dist\/b2b-read-adapter$/, replacement: fileURLToPath(new URL("./packages/service-access/src/b2b-read-adapter.ts", import.meta.url)) },
    { find: /^@factuez\/service-access\/dist\/b2b$/, replacement: fileURLToPath(new URL("./packages/service-access/src/b2b.ts", import.meta.url)) },
    { find: /^@factuez\/service-access\/dist\/integration-change-query$/, replacement: fileURLToPath(new URL("./packages/service-access/src/integration-change-query.ts", import.meta.url)) },
    { find: /^@factuez\/service-access\/dist\/integration-owner-changes$/, replacement: fileURLToPath(new URL("./packages/service-access/src/integration-owner-changes.ts", import.meta.url)) },
    { find: /^@factuez\/service-access\/dist\/integration-journal$/, replacement: fileURLToPath(new URL("./packages/service-access/src/integration-journal.ts", import.meta.url)) },
    { find: /^@factuez\/service-access\/dist\/integration$/, replacement: fileURLToPath(new URL("./packages/service-access/src/integration.ts", import.meta.url)) },
    { find: /^@factuez\/service-access\/dist\/integration-http$/, replacement: fileURLToPath(new URL("./packages/service-access/src/integration-http.ts", import.meta.url)) },
    { find: /^@factuez\/service-access$/, replacement: fileURLToPath(new URL("./packages/service-access/src/index.ts", import.meta.url)) },
  ] },
  test: {
    include: ["tests/**/*.spec.ts", "src/**/*.{test,spec}.ts", "packages/*/src/**/*.{test,spec}.ts"],
    environment: "node",
  },
});
