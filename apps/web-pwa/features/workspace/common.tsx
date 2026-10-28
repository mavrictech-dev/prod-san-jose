import { AlertCircle, Inbox, LoaderCircle } from "lucide-react";
import { Badge } from "@factuez/ui/components/badge";
import { Button } from "@factuez/ui/components/button";
export const money = (value: string | number, currency = "PEN") =>
  new Intl.NumberFormat("es-PE", { style: "currency", currency }).format(
    Number(value),
  );
export const rolesText: Record<string, string> = {
  ADMIN: "Administrador general",
  STATION_MANAGER: "Administrador de sede",
  CASHIER: "Cajero",
  TRACK_OPERATOR: "Operador de pista",
  AUDITOR: "Auditor",
};
export const statusInfo: Record<string, { label: string; className: string }> =
  {
    ACCEPTED: {
      label: "Aceptado",
      className: "bg-emerald-50 text-emerald-800 border-emerald-200",
    },
    ACCEPTED_WITH_OBSERVATIONS: {
      label: "Aceptado con observaciones",
      className: "bg-amber-50 text-amber-900 border-amber-200",
    },
    REJECTED: {
      label: "Rechazado",
      className: "bg-red-50 text-red-800 border-red-200",
    },
    PERMANENT_ERROR: {
      label: "Requiere revisión",
      className: "bg-red-50 text-red-800 border-red-200",
    },
    RETRYABLE_ERROR: {
      label: "Error de conexión",
      className: "bg-amber-50 text-amber-900 border-amber-200",
    },
    QUEUED: {
      label: "En cola local",
      className: "bg-amber-50 text-amber-900 border-amber-200",
    },
    PENDING: {
      label: "Pendiente",
      className: "bg-amber-50 text-amber-900 border-amber-200",
    },
    PROCESSING: {
      label: "Procesando localmente",
      className: "bg-blue-50 text-blue-800 border-blue-200",
    },
    VOIDED: {
      label: "Dado de baja",
      className: "bg-slate-100 text-slate-700 border-slate-200",
    },
  };
export function StatusBadge({ status }: { status: string }) {
  const info = statusInfo[status] ?? {
    label: status,
    className: "bg-slate-50 text-slate-700",
  };
  return (
    <Badge
      variant="outline"
      className={`gap-1.5 rounded-md py-1 text-xs font-medium ${info.className}`}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {info.label}
    </Badge>
  );
}
export function Loading() {
  return (
    <div
      role="status"
      className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"
    >
      <LoaderCircle className="size-4 animate-spin" />
      Cargando información…
    </div>
  );
}
export function ErrorState({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900"
    >
      <AlertCircle className="size-5 shrink-0" />
      <span className="flex-1">{message}</span>
      {retry && (
        <Button variant="outline" size="sm" onClick={retry}>
          Reintentar
        </Button>
      )}
    </div>
  );
}
export function Empty({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center">
      <div className="mb-3 rounded-xl bg-muted p-3">
        <Inbox className="size-6 text-muted-foreground" />
      </div>
      <p className="font-medium">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {description}
      </p>
    </div>
  );
}
export function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {eyebrow}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {title}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}
