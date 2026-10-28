"use client";
import { useEffect, useState, type FormEvent } from "react";
import { CollaborationLogos, DevelopmentCredits, SanJoseLogo } from "../../features/workspace/brand";
import { useRouter } from "next/navigation";
import { ArrowRight, Fuel, LoaderCircle, ShieldCheck } from "lucide-react";
import { Button } from "@factuez/ui/components/button";
import { Input } from "@factuez/ui/components/input";
import { Label } from "@factuez/ui/components/label";
import { landing, useWorkspace } from "../../features/workspace/provider";
import { ErrorState } from "../../features/workspace/common";

export default function LoginPage() {
  const { login, user, sessionNotice, restoring, restoreError, retryRestore } = useWorkspace();
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (user) router.replace(landing(user));
  }, [user, router]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const current = await login(username, password);
      setPassword("");
      router.replace(landing(current));
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "No se pudo iniciar sesión",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden bg-[#101827] p-12 text-white lg:flex">
        <SanJoseLogo className="w-52 self-start" />
        <div className="max-w-lg">
          <div className="mb-8 inline-flex rounded-2xl border border-white/10 bg-white/5 p-4">
            <Fuel className="size-8 text-red-400" />
          </div>
          <p className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
            Operación de estaciones
          </p>
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">
            Tu estación.
            <br />
            Cada operación,
            <br />
            bajo control.
          </h1>
          <p className="mt-6 max-w-sm text-base leading-relaxed text-slate-400">
            Facturación, sedes y accesos en un espacio de trabajo para Grifo San
            José.
          </p>
        </div>
        <div className="space-y-4 border-t border-white/10 pt-7">
          <CollaborationLogos dark />
          <DevelopmentCredits dark />
          <p className="text-xs text-slate-400">
            Sistema privado · Emisores RUC y sedes
          </p>
        </div>
      </section>
      <section className="flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-sm">
          <SanJoseLogo className="mb-10 w-44 lg:hidden" />
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
            Bienvenido a San José
          </p>
          <h2 className="text-3xl font-semibold tracking-tight">
            Ingresar al sistema
          </h2>
          <p className="mb-8 mt-3 leading-relaxed text-muted-foreground">
            Usa tu cuenta asignada para acceder a tu sede y terminal.
          </p>
          {sessionNotice && (
            <p
              role="status"
              className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
            >
              {sessionNotice}
            </p>
          )}
          {restoring && <p role="status" className="mb-4 text-sm text-muted-foreground">Recuperando sesión…</p>}
          {restoreError && <div className="mb-4"><ErrorState message={restoreError} /><Button type="button" variant="outline" onClick={retryRestore}>Reintentar sesión</Button></div>}
          <form onSubmit={submit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="username">Usuario</Label>
              <Input
                id="username"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
                className="h-12 bg-card"
                placeholder="usuario.asignado"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Contraseña</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                className="h-12 bg-card"
              />
            </div>
            {error && <ErrorState message={error} />}
            <Button type="submit" disabled={busy || restoring} className="h-12 w-full">
              {busy ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <ArrowRight className="size-4" />
              )}
              Ingresar
            </Button>
          </form>
          <p className="mt-8 flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="size-4" />
            Acceso restringido al personal autorizado.
          </p>
          <div className="mt-8 space-y-4 border-t pt-6 lg:hidden">
            <CollaborationLogos />
            <DevelopmentCredits />
          </div>
        </div>
      </section>
    </main>
  );
}
