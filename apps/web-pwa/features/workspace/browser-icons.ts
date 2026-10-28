import type { Metadata } from "next";

// Isotipos existentes: no usar los recursos «completo», que incluyen el nombre.
// La versión en la URL evita reutilizar una entrada anterior del caché PWA.
export const factuezBrowserIcons = {
  icon: [
    {
      url: "/brand/factuez-modo-claro.webp?v=tab-20261005",
      type: "image/webp",
      sizes: "512x512",
    },
    {
      url: "/brand/factuez-modo-oscuro.webp?v=tab-20261005",
      type: "image/webp",
      sizes: "512x512",
      media: "(prefers-color-scheme: dark)",
    },
  ],
  shortcut: "/brand/factuez-modo-claro.webp?v=tab-20261005",
} satisfies NonNullable<Metadata["icons"]>;
