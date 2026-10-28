import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { factuezBrowserIcons } from "../apps/web-pwa/features/workspace/browser-icons";

const webRequire = createRequire(new URL("../apps/web-pwa/package.json", import.meta.url));
const sharp = webRequire("sharp");

describe("pestaña: isotipo FactuEz sin cambiar el título", () => {
  it("conserva texto de la pestaña y registra las variantes existentes", () => {
    const layout = readFileSync(new URL("../apps/web-pwa/app/layout.tsx", import.meta.url), "utf8");
    expect(layout).toContain('title: "FactuEz | Grifo San José"');
    expect(layout).toContain("icons: factuezBrowserIcons");
    expect(factuezBrowserIcons.shortcut).toContain("factuez-modo-claro.webp");
    expect(factuezBrowserIcons.icon[1].media).toBe("(prefers-color-scheme: dark)");
  });

  it.each(factuezBrowserIcons.icon)("usa el recurso cuadrado, no el logo con nombre: $url", async (icon) => {
    expect(icon.type).toBe("image/webp");
    expect(icon.sizes).toBe("512x512");
    expect(icon.url).not.toContain("completo");
    expect(icon.url).toContain("?v=tab-20261005");
    const bytes = readFileSync(new URL(`../apps/web-pwa/public${icon.url.split("?")[0]}`, import.meta.url));
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
  });
});
