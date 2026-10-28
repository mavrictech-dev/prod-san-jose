"use client";
import Link from "next/link";
import { CollaborationLogos, DevelopmentCredits, SanJoseLogo } from "../../../features/workspace/brand";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ArrowUpRight,
  ReceiptText,
  Wallet,
  Landmark,
  RefreshCw,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@factuez/ui/components/card";
import { Button } from "@factuez/ui/components/button";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@factuez/ui/components/chart";
import {
  useResource,
  useWorkspace,
} from "../../../features/workspace/provider";
import {
  Empty,
  ErrorState,
  Loading,
  money,
  PageHeading,
  StatusBadge,
} from "../../../features/workspace/common";
import { DocumentTable } from "../../../features/workspace/document-table";
import type {
  DashboardData,
  DocumentPage,
} from "../../../features/workspace/types";
export default function DashboardPage() {
  const { branchId, companyId, catalog, catalogSource, can, liveStatus } = useWorkspace();
  const params = new URLSearchParams({ dataSource: catalogSource });
  if (branchId) params.set("branchId", branchId);
  if (companyId) params.set("companyId", companyId);
  const filter = `?${params}`;
  const summary = useResource<DashboardData>(
    `/api/v1/documents/dashboard${filter}`,
    true,
  );
  const recent = useResource<DocumentPage>(`/api/v1/documents${filter}`, true);
  const data = summary.data;
  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-5 border-b pb-5">
        <SanJoseLogo className="w-44 sm:w-48" />
        <section aria-label="Marcas y créditos de desarrollo" className="space-y-3">
          <CollaborationLogos />
          <DevelopmentCredits />
        </section>
      </div>
      <PageHeading
        eyebrow="Control de estación"
        title="Resumen de operaciones"
        description={`Consolidado del contexto seleccionado · Información del día en soles · Lima · ${liveStatus === 'connected' ? 'Socket.io conectado: actualización por eventos' : 'Socket.io no conectado'} · Respaldo REST cada 15 segundos`}
        action={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="icon"
              aria-label="Actualizar resumen"
              onClick={() => {
                summary.reload();
                recent.reload();
              }}
            >
              <RefreshCw className="size-4" />
            </Button>
            {can("document.issue") && (
              <Button asChild>
                <Link href="/pos">
                  Nueva emisión <ArrowUpRight className="size-4" />
                </Link>
              </Button>
            )}
          </div>
        }
      />
      {summary.error ? (
        <ErrorState message={summary.error} retry={summary.reload} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-3">
            {[
              {
                title: "Importe emitido hoy",
                value: money(data.amount),
                icon: Wallet,
                note: "Incluye documentos de prueba y pendientes",
              },
              {
                title: "Comprobantes del día",
                value: String(data.count),
                icon: ReceiptText,
                note: `Fecha operativa: ${data.date}`,
              },
              {
                title: "IGV registrado",
                value: money(data.igv),
                icon: Landmark,
                note: "No equivale a IGV declarado ante SUNAT",
              },
            ].map((stat) => (
              <Card className="gap-3 py-5 shadow-none" key={stat.title}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                  <CardDescription>{stat.title}</CardDescription>
                  <stat.icon className="size-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <p className="text-3xl font-semibold tracking-tight tabular-nums">
                    {stat.value}
                  </p>
                  <p className="mt-3 text-xs text-muted-foreground">
                    {stat.note}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="mb-6 grid gap-6 xl:grid-cols-[1.65fr_1fr]">
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Emisión por punto</CardTitle>
                <CardDescription>
                  Importe acumulado del día · S/
                </CardDescription>
              </CardHeader>
              <CardContent>
                {data.points.length ? (
                  <ChartContainer
                    className="h-64 w-full"
                    config={{ amount: { label: "Importe", color: "#c8202c" } }}
                  >
                    <BarChart
                      accessibilityLayer
                      data={data.points.map((point) => ({
                        name:
                          catalog?.emissionPoints.find(
                            (item) => item.id === point.pointId,
                          )?.code ?? "Punto histórico",
                        amount: Number(point.amount),
                      }))}
                    >
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="name" tickLine={false} axisLine={false} />
                      <YAxis tickLine={false} axisLine={false} width={65} />
                      <ChartTooltip
                        content={
                          <ChartTooltipContent
                            formatter={(value) => money(String(value))}
                          />
                        }
                      />
                      <Bar
                        dataKey="amount"
                        fill="var(--color-amount)"
                        radius={[4, 4, 0, 0]}
                        maxBarSize={56}
                      />
                    </BarChart>
                  </ChartContainer>
                ) : (
                  <Empty
                    title="Aún no hay actividad hoy"
                    description="El gráfico se alimentará de las emisiones reales del sistema, sin cifras simuladas."
                  />
                )}
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Seguimiento de documentos</CardTitle>
                <CardDescription>
                  Estado registrado en el sistema
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {data.states.length ? (
                  data.states.map((state) => (
                    <div
                      key={state.status}
                      className="flex items-center justify-between gap-3 border-b pb-4 last:border-0"
                    >
                      <StatusBadge status={state.status} />
                      <span className="text-lg font-semibold tabular-nums">
                        {state.count}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="py-4 text-sm text-muted-foreground">
                    Sin documentos para este día.
                  </p>
                )}
                <div className="rounded-lg bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
                  Un documento procesado localmente no implica aceptación SUNAT.
                  La integración fiscal está pendiente.
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}
      <Card className="shadow-none">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Últimos comprobantes</CardTitle>
            <CardDescription className="mt-1">
              Todas las fechas · Alcance autorizado
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/documents">
              Ver todos <ArrowUpRight className="size-4" />
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          {recent.error ? (
            <ErrorState message={recent.error} retry={recent.reload} />
          ) : recent.data ? (
            <DocumentTable items={recent.data.items.slice(0, 6)} />
          ) : (
            <Loading />
          )}
        </CardContent>
      </Card>
      {data && (
        <p className="mt-4 text-right text-xs text-muted-foreground">
          Última consulta:{" "}
          {new Date(data.updatedAt).toLocaleTimeString("es-PE", {
            timeZone: "America/Lima",
          })}
        </p>
      )}
    </>
  );
}
