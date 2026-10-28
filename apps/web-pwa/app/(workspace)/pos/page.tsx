"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Fuel, Plus, Trash2, CheckCircle2, LoaderCircle } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@factuez/ui/components/card";
import { Button } from "@factuez/ui/components/button";
import { Input } from "@factuez/ui/components/input";
import { Label } from "@factuez/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@factuez/ui/components/select";
import { ApiError, useWorkspace } from "../../../features/workspace/provider";
import { canRunLocalEmissionWorkflow, runLocalEmissionWorkflow } from "../../../features/workspace/local-emission-workflow";
import { initialPayment, paymentTermsFor, paymentDraftError, type PaymentDraft } from '../../../features/workspace/payment-input';
import {
  ErrorState,
  money,
  PageHeading,
  StatusBadge,
} from "../../../features/workspace/common";
type Line = {
  productId?: string;
  productCode?: string;
  description: string;
  unitCode: string;
  quantity: string;
  unitPriceWithTax: string;
  taxAffectationCode: string;
  igvRate: string;
};
type Totals = {
  totals: { taxableAmount: string; igvAmount: string; payableAmount: string };
};
type Result = {
  documentId: string;
  fullNumber: string;
  issuerRuc: string;
  sunatStatus: string;
};
const blankLine = (): Line => ({
  description: "",
  unitCode: "GLL",
  quantity: "1",
  unitPriceWithTax: "",
  taxAffectationCode: "10",
  igvRate: "18",
});
const decimal = /^\d{1,12}(\.\d{1,6})?$/;
export default function PosPage() {
  const { api, user, branchId, catalog, setDirty, setBranch } = useWorkspace();
  const intentKey = `factuez:pending:${user?.sub}`;
  const recovered = useRef(false);
  const points =
    catalog?.emissionPoints.filter((point) => point.branchId === branchId) ??
    [];
  const [pointId, setPointId] = useState(points[0]?.id ?? "");
  const [type, setType] = useState("SALES_RECEIPT");
  const [series, setSeries] = useState("");
  const [identity, setIdentity] = useState("");
  const [name, setName] = useState("");
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const [payment, setPayment] = useState<PaymentDraft>(initialPayment);
  const [totals, setTotals] = useState<Totals>();
  const [previewError, setPreviewError] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>();
  const [intent, setIntent] = useState<{ key: string; body: string; workflow?: boolean }>();
  const [workflowMessage, setWorkflowMessage] = useState<string>();
  const [workflowError, setWorkflowError] = useState<string>();
  const workflowAbort = useRef<AbortController | null>(null);
  useEffect(() => () => workflowAbort.current?.abort(), []);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const counters =
    points
      .find((point) => point.id === pointId)
      ?.series.filter((counter) => counter.documentType === type) ?? [];
  useEffect(() => {
    setSeries(
      intent ? JSON.parse(intent.body).series : (counters[0]?.series ?? ""),
    );
  }, [pointId, type, catalog, intent]);
  useEffect(() => {
    if (recovered.current || !user || !catalog) return;
    recovered.current = true;
    try {
      const raw = window.sessionStorage.getItem(intentKey);
      if (!raw) return;
      const pending = JSON.parse(raw) as { key: string; body: string; workflow?: boolean };
      const body = JSON.parse(pending.body);
      if (
        typeof pending.key !== "string" ||
        !body.customer ||
        !Array.isArray(body.lines)
      )
        throw new Error(
          "Solicitud pendiente no legible. Solicita revisión al administrador antes de volver a emitir.",
        );
      setIntent(pending);
      setPointId(body.emissionPointId);
      setType(body.documentType);
      setSeries(body.series);
      setIdentity(
        body.customer.identityNumber === "0"
          ? ""
          : body.customer.identityNumber,
      );
      setName(body.customer.legalName);
      setLines(body.lines);
      if (body.paymentTerms?.type === 'CREDITO') setPayment({ type: 'CREDITO', pendingAmount: body.paymentTerms.pendingAmount, installments: body.paymentTerms.installments });
      else setPayment(initialPayment());
      setDirty(true);
      const originalPoint = catalog.emissionPoints.find(
        (point) => point.id === body.emissionPointId,
      );
      if (originalPoint && originalPoint.branchId !== branchId)
        setBranch(originalPoint.branchId);
    } catch (reason) {
      setRecoveryBlocked(true);
      setError(
        reason instanceof Error
          ? reason.message
          : "No se pudo recuperar la solicitud pendiente",
      );
    }
  }, [user, catalog, intentKey, branchId, setBranch, setDirty]);
  useEffect(() => () => setDirty(false), [setDirty]);
  const encodedLines = JSON.stringify(lines);
  const validLines = lines.every(
    (line) =>
      line.description.trim() &&
      decimal.test(line.quantity) &&
      Number(line.quantity) > 0 &&
      decimal.test(line.unitPriceWithTax) &&
      Number(line.unitPriceWithTax) > 0,
  );
  useEffect(() => {
    setTotals(undefined);
    setPreviewError(undefined);
    if (!validLines) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<Totals>("/api/v1/documents/preview", {
        method: "POST",
        body: JSON.stringify({ lines: JSON.parse(encodedLines) }),
        signal: controller.signal,
      })
        .then((value) => {
          if (!controller.signal.aborted) setTotals(value);
        })
        .catch((reason) => {
          if (!controller.signal.aborted)
            setPreviewError(
              reason instanceof Error ? reason.message : "No se pudo calcular",
            );
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [api, encodedLines, validLines]);
  function updateLine(index: number, patch: Partial<Line>) {
    setDirty(true);
    setLines((current) =>
      current.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
  }
  async function issue(withWorkflow = false) {
    if (recoveryBlocked) return;
    const paymentError = paymentDraftError(payment, type, totals?.totals.payableAmount);
    if (!intent && paymentError) { setError(paymentError); return; }
    setError(undefined);
    setBusy(true);
    const pending = intent ?? {
      key: crypto.randomUUID(),
      workflow: withWorkflow,
      body: JSON.stringify({
        emissionPointId: pointId,
        documentType: type,
        series,
        currencyCode: "PEN",
        paymentTerms: paymentTermsFor(payment),
        customer: {
          identityType: type === "INVOICE" ? "6" : identity ? "1" : "0",
          identityNumber: identity || "0",
          legalName: name.trim() || "CONSUMIDOR FINAL",
        },
        lines,
      }),
    };
    try {
      window.sessionStorage.setItem(intentKey, JSON.stringify(pending));
    } catch {
      setError(
        "No se pudo conservar la solicitud en esta pestaña. No se envió ningún documento. Habilita el almacenamiento del navegador.",
      );
      setBusy(false);
      return;
    }
    setIntent(pending);
    setDirty(true);
    try {
      const issued = await api<Result>("/api/v1/documents", {
        method: "POST",
        headers: { "Idempotency-Key": pending.key },
        body: pending.body,
        signal: AbortSignal.timeout(15000),
      });
      setResult(issued);
      window.sessionStorage.removeItem(intentKey);
      setIntent(undefined);
      setDirty(false);
      if (pending.workflow || withWorkflow) await continueWorkflow(issued.documentId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo emitir");
      if (reason instanceof ApiError && [400, 422].includes(reason.status)) {
        window.sessionStorage.removeItem(intentKey);
        setIntent(undefined);
      }
    } finally {
      setBusy(false);
    }
  }
  async function continueWorkflow(documentId: string) {
    setWorkflowError(undefined);
    const controller = new AbortController(); workflowAbort.current?.abort(); workflowAbort.current = controller;
    try {
      const circuit = await runLocalEmissionWorkflow(api, documentId,
        AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]), setWorkflowMessage);
      if (!controller.signal.aborted) setWorkflowMessage(
        circuit.state === 'ACCEPTED' || circuit.state === 'ACCEPTED_WITH_OBSERVATIONS'
          ? 'Circuito terminado en el emulador local. XML firmado, ZIP y CDR simulado disponibles en el detalle; sin aceptación SUNAT.'
          : `Circuito local: ${circuit.state}. Revise el mismo comprobante; no vuelva a emitir.`,
      );
    } catch (reason) {
      if (!controller.signal.aborted) {
        setWorkflowMessage('El comprobante sigue registrado; el laboratorio no crea otra venta.');
        setWorkflowError(reason instanceof Error ? reason.message : 'Consulte el detalle del mismo comprobante.');
      }
    }
  }
  const canWorkflow = canRunLocalEmissionWorkflow(user, catalog, points.find(point => point.id === pointId)?.companyId);
  const locked = busy || !!intent || !!result;
  const customerValid =
    type === "INVOICE"
      ? /^\d{11}$/.test(identity) && name.trim().length > 0
      : !identity || /^\d{8}$/.test(identity);
  return (
    <>
      <PageHeading
        eyebrow="Caja / pista"
        title="Terminal de emisión"
        description="Factura o boleta de prueba · Precios con IGV incluido · Totales calculados en el servidor"
        action={
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Fuel className="size-5" />
            {catalog?.branches.find((branch) => branch.id === branchId)?.name ??
              "Selecciona una sede arriba"}
          </div>
        }
      />
      {!branchId && (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Selecciona una sede concreta en la barra superior para emitir. No se
          emite desde «Todas las sedes».
        </div>
      )}
      {result && (
        <div
          role="status"
          className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-900"
        >
          <CheckCircle2 className="size-5" />
          <div className="flex-1">
            <p className="font-semibold">
              {result.fullNumber} · RUC {result.issuerRuc} registrado localmente
            </p>
            <p className="text-xs">
              No es una aceptación fiscal. Consulta su procesamiento en
              Comprobantes.
            </p>
            {workflowMessage && <p className="mt-2 text-xs" role="status">{workflowMessage}</p>}
            {workflowError && <p className="mt-2 text-xs text-amber-900" role="alert">{workflowError}</p>}
          </div>
          <StatusBadge status={result.sunatStatus} />
          <Button variant="outline" asChild>
            <Link href={`/documents/${result.documentId}`}>
              Ver ticket / A4
            </Link>
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setResult(undefined);
              setLines([blankLine()]);
              setPayment(initialPayment());
              setName("");
              setIdentity("");
              setWorkflowMessage(undefined);
              setWorkflowError(undefined);
            }}
          >
            Nueva operación
          </Button>
        </div>
      )}
      <div className="grid items-start gap-6 xl:grid-cols-[1fr_340px]">
        <div className="space-y-5">
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle>Datos del comprobante</CardTitle>
            </CardHeader>
            <CardContent>
              <fieldset disabled={locked} className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label>Punto de emisión</Label>
                  <Select
                    value={pointId}
                    disabled={locked || !points.length}
                    onValueChange={(value) => {
                      setPointId(value);
                      setDirty(true);
                    }}
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label="Punto de emisión"
                    >
                      <SelectValue placeholder="Sin puntos asignados" />
                    </SelectTrigger>
                    <SelectContent>
                      {points.map((point) => (
                        <SelectItem key={point.id} value={point.id}>
                          {point.code} · {point.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Tipo</Label>
                  <Select
                    value={type}
                    disabled={locked}
                    onValueChange={(value) => {
                      setType(value);
                      setIdentity("");
                      setPayment(initialPayment());
                      setDirty(true);
                    }}
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label="Tipo de documento"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="SALES_RECEIPT">
                        Boleta de venta
                      </SelectItem>
                      <SelectItem value="INVOICE">Factura</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Serie autorizada</Label>
                  <Select
                    value={series}
                    disabled={locked || !counters.length}
                    onValueChange={(value) => {
                      setSeries(value);
                      setDirty(true);
                    }}
                  >
                    <SelectTrigger className="w-full" aria-label="Serie">
                      <SelectValue placeholder="Sin series asignadas" />
                    </SelectTrigger>
                    <SelectContent>
                      {counters.map((counter) => (
                        <SelectItem key={counter.series} value={counter.series}>
                          {counter.series}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="customer-id">
                    {type === "INVOICE" ? "RUC obligatorio" : "DNI (opcional)"}
                  </Label>
                  <Input
                    id="customer-id"
                    inputMode="numeric"
                    maxLength={type === "INVOICE" ? 11 : 8}
                    value={identity}
                    onChange={(event) => {
                      setIdentity(event.target.value.replace(/\D/g, ""));
                      setDirty(true);
                    }}
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="customer-name">
                    {type === "INVOICE"
                      ? "Razón social obligatoria"
                      : "Nombre del cliente (opcional)"}
                  </Label>
                  <Input
                    id="customer-name"
                    placeholder={
                      type === "INVOICE"
                        ? "Razón social del receptor"
                        : "Consumidor final"
                    }
                    maxLength={160}
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                      setDirty(true);
                    }}
                  />
                </div>
              </fieldset>
            </CardContent>
          </Card>
          <Card className="shadow-none">
            <CardHeader><CardTitle>Forma de pago</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <Select value={payment.type} disabled={locked} onValueChange={value => { setPayment(value === 'CONTADO' ? initialPayment() : { ...initialPayment(), type: 'CREDITO' }); setDirty(true); }}>
                <SelectTrigger aria-label="Forma de pago"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="CONTADO">Contado</SelectItem><SelectItem value="CREDITO" disabled={type !== 'INVOICE'}>Crédito · factura</SelectItem></SelectContent>
              </Select>
              {payment.type === 'CREDITO' && <div className="space-y-3">
                <Label htmlFor="payment-pending">Saldo pendiente · S/</Label>
                <Input id="payment-pending" inputMode="decimal" disabled={locked} value={payment.pendingAmount}
                  onChange={event => { setPayment({ ...payment, pendingAmount: event.target.value }); setDirty(true); }} />
                {payment.installments.map((row, index) => <div key={index} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                  <div className="space-y-1"><Label htmlFor={`payment-amount-${index}`}>Cuota {index + 1} · S/</Label>
                    <Input id={`payment-amount-${index}`} disabled={locked} inputMode="decimal" value={row.amount}
                      onChange={event => { setPayment({ ...payment, installments: payment.installments.map((item, at) => at === index ? { ...item, amount: event.target.value } : item) }); setDirty(true); }} /></div>
                  <div className="space-y-1"><Label htmlFor={`payment-due-${index}`}>Vencimiento</Label>
                    <Input id={`payment-due-${index}`} type="date" disabled={locked} value={row.dueDate}
                      onChange={event => { setPayment({ ...payment, installments: payment.installments.map((item, at) => at === index ? { ...item, dueDate: event.target.value } : item) }); setDirty(true); }} /></div>
                  <Button variant="ghost" size="icon" aria-label={`Quitar cuota ${index + 1}`} disabled={locked || payment.installments.length === 1}
                    onClick={() => { setPayment({ ...payment, installments: payment.installments.filter((_, at) => at !== index) }); setDirty(true); }}><Trash2 className="size-4" /></Button>
                </div>)}
                <Button variant="outline" disabled={locked || payment.installments.length >= 20} onClick={() => { setPayment({ ...payment, installments: [...payment.installments, { amount: '', dueDate: '' }] }); setDirty(true); }}><Plus className="size-4" />Añadir cuota</Button>
                <p className="text-xs text-muted-foreground">Las cuotas deben sumar exactamente el saldo pendiente y vencer después de la fecha de emisión. No cambia el total de la venta.</p>
                {paymentDraftError(payment, type, totals?.totals.payableAmount) && <ErrorState message={paymentDraftError(payment, type, totals?.totals.payableAmount)!} />}
              </div>}
            </CardContent>
          </Card>
          <Card className="shadow-none">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Combustibles e ítems</CardTitle>
              <Button
                variant="outline"
                size="sm"
                disabled={locked || lines.length >= 100}
                onClick={() => {
                  setLines([...lines, blankLine()]);
                  setDirty(true);
                }}
              >
                <Plus className="size-4" />
                Agregar
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              {lines.map((line, index) => (
                <fieldset
                  key={index}
                  disabled={locked}
                  className="rounded-lg border p-4"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <Label>Ítem {index + 1}</Label>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Eliminar ítem ${index + 1}`}
                      disabled={locked || lines.length === 1}
                      onClick={() => {
                        setLines(lines.filter((_, i) => i !== index));
                        setDirty(true);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                  <Select
                    value={line.productId ?? "manual"}
                    disabled={locked}
                    onValueChange={(value) => {
                      const product = catalog?.products.find(
                        (item) => item.id === value,
                      );
                      updateLine(
                        index,
                        product
                          ? {
                              productId: product.id,
                              productCode: product.sku,
                              description: product.description,
                              unitCode: product.unitCode,
                              unitPriceWithTax: product.defaultUnitPrice ?? "",
                              taxAffectationCode: product.taxAffectationCode,
                              igvRate:
                                product.taxAffectationCode === "10"
                                  ? "18"
                                  : "0",
                            }
                          : {
                              ...blankLine(),
                              productId: undefined,
                              productCode: undefined,
                              quantity: line.quantity,
                            },
                      );
                    }}
                  >
                    <SelectTrigger
                      className="mb-3 w-full"
                      aria-label={`Producto del ítem ${index + 1}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="manual">
                        Ítem libre / servicio
                      </SelectItem>
                      {catalog?.products.map((product) => (
                        <SelectItem value={product.id} key={product.id}>
                          {product.description}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    aria-label={`Descripción del ítem ${index + 1}`}
                    placeholder="Descripción"
                    maxLength={250}
                    value={line.description}
                    onChange={(event) =>
                      updateLine(index, { description: event.target.value })
                    }
                  />
                  <div className="mt-3 grid gap-3 sm:grid-cols-4">
                    <div className="space-y-2">
                      <Label>Cantidad</Label>
                      <Input
                        aria-label={`Cantidad del ítem ${index + 1}`}
                        inputMode="decimal"
                        value={line.quantity}
                        onChange={(event) =>
                          updateLine(index, { quantity: event.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Unidad</Label>
                      <Select
                        value={line.unitCode}
                        disabled={locked}
                        onValueChange={(value) =>
                          updateLine(index, { unitCode: value })
                        }
                      >
                        <SelectTrigger
                          className="w-full"
                          aria-label={`Unidad del ítem ${index + 1}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Array.from(
                            new Set([
                              "GLL",
                              "LTR",
                              "MTQ",
                              "NIU",
                              "ZZ",
                              line.unitCode,
                            ]),
                          ).map((unit) => (
                            <SelectItem value={unit} key={unit}>
                              {unit}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Precio con IGV · S/</Label>
                      <Input
                        aria-label={`Precio del ítem ${index + 1}`}
                        inputMode="decimal"
                        value={line.unitPriceWithTax}
                        onChange={(event) =>
                          updateLine(index, {
                            unitPriceWithTax: event.target.value,
                          })
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Afectación</Label>
                      <Select
                        value={line.taxAffectationCode}
                        disabled={locked}
                        onValueChange={(value) =>
                          updateLine(index, {
                            taxAffectationCode: value,
                            igvRate: value === "10" ? "18" : "0",
                          })
                        }
                      >
                        <SelectTrigger
                          className="w-full"
                          aria-label={`Afectación del ítem ${index + 1}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="10">Gravado</SelectItem>
                          <SelectItem value="20" disabled>Exonerado · pendiente de habilitación</SelectItem>
                          <SelectItem value="30" disabled>Inafecto · pendiente de habilitación</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </fieldset>
              ))}
            </CardContent>
          </Card>
        </div>
        <Card className="shadow-none xl:sticky xl:top-5">
          <CardHeader>
            <CardTitle>Resumen de emisión</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-3 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>Base de ítems sin IGV</span>
                <span>{totals ? money(totals.totals.taxableAmount) : "—"}</span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>IGV</span>
                <span>{totals ? money(totals.totals.igvAmount) : "—"}</span>
              </div>
              <div className="flex justify-between border-t pt-4 text-xl font-semibold">
                <span>Total</span>
                <span className="tabular-nums">
                  {totals ? money(totals.totals.payableAmount) : "—"}
                </span>
              </div>
            </div>
            {previewError && <ErrorState message={previewError} />}
            {error && <ErrorState message={error} />}
            {intent && !busy && (
              <p className="text-xs leading-relaxed text-amber-800">
                Hay una operación sin resultado confirmado. Se conserva en esta
                pestaña incluso al recargar o volver a iniciar sesión. Reintenta
                la misma solicitud; no cierres la pestaña ni abras otra emisión.
              </p>
            )}
            <Button
              className="h-12 w-full text-base"
              disabled={
                recoveryBlocked ||
                busy ||
                !!result ||
                (!intent &&
                  (!branchId ||
                    !pointId ||
                    !series ||
                    !totals ||
                    !customerValid))
              }
              onClick={() => void issue()}
            >
              {busy ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  Registrando…
                </>
              ) : intent ? (
                "Reintentar misma operación"
              ) : (
                "Emitir comprobante de prueba"
              )}
            </Button>
            {canWorkflow && <Button className="w-full" variant="outline"
              disabled={locked || recoveryBlocked || (!intent && (!branchId || !pointId || !series || !totals || !customerValid))}
              onClick={() => void issue(true)}>
              Emitir y ejecutar circuito QA
            </Button>}
            <p className="text-xs leading-relaxed text-muted-foreground">
              La numeración se asigna al confirmar. Esta etapa no firma ni envía
              a SUNAT, ni habilita emisión sin conexión al servidor local.
              {canWorkflow && ' El botón de circuito QA encadena firma ficticia, SOAP interno y CDR simulado sobre el mismo comprobante. Nunca usa certificados reales.'}
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
