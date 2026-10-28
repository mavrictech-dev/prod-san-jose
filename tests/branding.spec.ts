import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollaborationLogos, DevelopmentCredits } from "../apps/web-pwa/features/workspace/brand";
import { InitialExperience, STARTUP_DISPLAY_MS, StartupScreen } from "../apps/web-pwa/features/workspace/startup";

// Usa la misma instalación React de la PWA, sin añadir dependencias ni una API falsa.
const webRequire = createRequire(new URL("../apps/web-pwa/package.json", import.meta.url));
const React = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");
beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => vi.unstubAllGlobals());
const render = (component: unknown, props = {}) => renderToStaticMarkup(React.createElement(component, props));
const plainText = (html: string) => html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ");

describe("marcas FactuEz y Mavric", () => {
  it("coloca Mavric al costado de FactuEz en el bloque compacto del sidebar", () => {
    const html = render(CollaborationLogos, { compact: true, dark: true });
    expect(html).toContain('aria-label="FactuEz y Mavric Tecnologies"');
    expect(html).toContain('alt="Mavric Tecnologies"');
    expect(html.indexOf('alt="Basado en FactuEz"')).toBeLessThan(html.indexOf('alt="Mavric Tecnologies"'));
    expect(html).toContain("w-28 shrink-0");
    expect(html).toContain("size-8");
  });
  it("conserva el crédito de implementación sin nombre personal ni colaboración", () => {
    const html = render(DevelopmentCredits);
    expect(plainText(html)).toContain("Desarrollado e implementado por www.mavrictec.com");
    expect(plainText(html)).not.toMatch(/colaboraci[oó]n|Max Garc[ií]a/i);
    expect(html).toContain('href="https://www.mavrictec.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
  it("ofrece las dos variantes de FactuEz para el tema de la página", () => {
    const html = render(CollaborationLogos);
    expect(html).toContain("brand-light");
    expect(html).toContain("brand-dark");
  });
  it("muestra San José, ambas marcas y el crédito durante el inicio", () => {
    const html = render(StartupScreen);
    expect(html).toContain('role="status"');
    expect(html).toContain('alt="Estaciones San José"');
    expect(html).toContain('alt="Basado en FactuEz"');
    expect(html).toContain('alt="Mavric Tecnologies"');
    expect(plainText(html)).toContain("Desarrollado e implementado por www.mavrictec.com");
    expect(plainText(html)).not.toMatch(/colaboraci[oó]n|Max Garc[ií]a/i);
    expect(html).toContain("motion-reduce:animate-none");
  });
  it("impide interactuar con el formulario mientras la presentación inicial es visible", () => {
    const html = render(InitialExperience, { children: React.createElement("input", { name: "username" }) });
    expect(html).toContain('inert=""');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-testid="initial-collaboration-screen"');
    expect(STARTUP_DISPLAY_MS).toBe(1800);
  });
});
