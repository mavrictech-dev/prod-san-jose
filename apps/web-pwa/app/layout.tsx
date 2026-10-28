import type { Metadata, Viewport } from "next";
import "./globals.css";
import "@fontsource-variable/inter";
import { WorkspaceProvider } from "../features/workspace/provider";
import { PwaRegistration } from "../features/workspace/pwa";
import { InitialExperience } from "../features/workspace/startup";
import { factuezBrowserIcons } from "../features/workspace/browser-icons";

export const metadata: Metadata = {
  title: "FactuEz | Grifo San José",
  description: "Sistema de facturación electrónica para Grifo San José S.R.L.",
  manifest: "/manifest.webmanifest",
  applicationName: "FactuEz",
  icons: factuezBrowserIcons,
  appleWebApp: { capable: true, statusBarStyle: "default", title: "FactuEz" },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  colorScheme: "light dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>
        <PwaRegistration />
        <WorkspaceProvider>
          <InitialExperience>{children}</InitialExperience>
        </WorkspaceProvider>
      </body>
    </html>
  );
}
