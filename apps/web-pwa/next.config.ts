import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Windows sin privilegios de symlink compila con next start; Docker/Linux
  // conserva el empaquetado standalone sin cambiar la configuración del equipo.
  output: process.platform === "win32" ? undefined : "standalone",
  transpilePackages: ["@factuez/ui"],
  serverExternalPackages: ["swagger-ui-dist"],
  images: { formats: ["image/avif", "image/webp"] },
};

export default nextConfig;
