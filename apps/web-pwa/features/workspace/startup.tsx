"use client";
import { useEffect, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { CollaborationLogos, DevelopmentCredits, SanJoseLogo } from "./brand";

// Presentación breve, una vez por carga completa, no en cada navegación.
export const STARTUP_DISPLAY_MS = 1800;

export function StartupScreen() {
  return (
    <main
      role="status"
      aria-live="polite"
      aria-label="Iniciando FactuEz con Mavric Tecnologies"
      className="flex min-h-dvh items-center justify-center bg-background px-6 py-10"
    >
      <div className="flex w-full max-w-lg flex-col items-center text-center">
        <SanJoseLogo className="mb-10 w-48" />
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Sistema de facturación
        </p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Grifo San José</h1>
        <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
          Facturación y control para tu estación.
        </p>
        <CollaborationLogos className="my-8" priority />
        <DevelopmentCredits />
        <div className="mt-10 flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
          Preparando tu espacio de trabajo…
        </div>
      </div>
    </main>
  );
}

export function InitialExperience({ children }: { children: ReactNode }) {
  const [starting, setStarting] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setStarting(false), STARTUP_DISPLAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <>
      <div inert={starting} aria-hidden={starting ? true : undefined}>{children}</div>
      {starting && (
        <div className="fixed inset-0 z-[100] overflow-y-auto" data-testid="initial-collaboration-screen">
          <StartupScreen />
        </div>
      )}
    </>
  );
}
