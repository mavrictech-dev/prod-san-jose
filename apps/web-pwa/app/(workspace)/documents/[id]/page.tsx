"use client";
import Link from "next/link";
import { FiscalDocumentMail } from '../../../../features/workspace/corporate-document-mail';
import { ProductionNotesPanel } from '../../../../features/workspace/production-notes';
import { FiscalOriginals } from '../../../../features/workspace/fiscal-originals';
import { CircuitQa } from '../../../../features/workspace/circuit-qa';
import { PdfPrintButton } from '../../../../features/workspace/pdf-print';
import { SupplementTracking } from '../../../../features/workspace/supplement-tracking';
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Download,
  FileText,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@factuez/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@factuez/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@factuez/ui/components/table";
import {
  useResource,
  useWorkspace,
} from "../../../../features/workspace/provider";
import {
  ErrorState,
  Loading,
  money,
  PageHeading,
  StatusBadge,
} from "../../../../features/workspace/common";
type Detail = {
  id: string;
  fullNumber: string;
  companyId: number;
  sunatStatus: string;
  sunatResponseDescription?: string;
  immutableSnapshot: {
    issuer: { identityNumber: string; legalName: string; address?: string };
    customer: { identityNumber: string; legalName: string };
    environment: string;
    documentTypeCode?: string;
    reference?: {documentId:string;fullNumber:string};
    reasonCode?: string;
    reasonDescription?: string;
    currencyCode: string;
    issueDate: string;
    lines: {
      lineNumber: number;
      description: string;
      quantity: string;
      unitCode: string;
      unitPriceWithTax: string;
      totalAmount: string;
    }[];
    totals: { taxableAmount: string; igvAmount: string; payableAmount: string };
  };
};
type LocalValidation = { ready: boolean; signatureVerified: boolean; certificateFingerprint: string | null; zipSha256: string | null; profile: string };
export default function DocumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { apiBlob, api, user, can } = useWorkspace();
  const resource = useResource<Detail>(`/api/v1/documents/${id}`, true);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [validation, setValidation] = useState<LocalValidation>();
  const abort = useRef<AbortController | undefined>(undefined);
  const doc = resource.data;
  const production = doc?.immutableSnapshot.environment === "PRODUCTION";
  const canValidate = user?.roles.includes("ADMIN") && user.scope.kind === "GLOBAL" && can("sunat.configure") &&
    doc?.immutableSnapshot.environment === "BETA" && /^00\d{9}$/.test(doc.immutableSnapshot.issuer.identityNumber);
  useEffect(() => {
    setValidation(undefined); setError(undefined); setBusy(undefined);
    return () => abort.current?.abort();
  }, [id]);
  async function validateAndDownload() {
    if (!doc || busy || !canValidate) return;
    setBusy("xml"); setError(undefined);
    const controller = new AbortController(); abort.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
    try {
      const result = await api<LocalValidation>(`/api/v1/local-xml-validation/${id}`, { method: "POST", signal });
      if (controller.signal.aborted) return;
      setValidation(result);
      const blob = await apiBlob(`/api/v1/local-xml-validation/${id}/zip`, signal, "application/zip");
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob); const link = document.createElement("a");
      link.href = url; link.download = `${doc.immutableSnapshot.issuer.identityNumber}-${doc.fullNumber}-PRUEBA-LOCAL.zip`;
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "No se pudo ejecutar la prueba local");
    } finally { if (!controller.signal.aborted) setBusy(undefined); }
  }
  async function download(format: "ticket" | "a4") {
    if (!doc || busy) return;
    setError(undefined);
    setBusy(format);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const blob = await apiBlob(
        `/api/v1/fiscal-artifacts/${id}/${format}`,
        AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
      );
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${doc.immutableSnapshot.issuer.identityNumber}-${doc.fullNumber}-${format}-${production ? "PRODUCCION" : "PRUEBA"}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "No se pudo descargar el archivo",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(undefined);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="Comprobantes"
        title={doc?.fullNumber ?? "Detalle del documento"}
        description="Datos congelados al registrar la operación · Las descargas respetan su alcance autorizado"
        action={
          <Button variant="outline" asChild>
            <Link href="/documents">
              <ArrowLeft className="size-4" /> Volver
            </Link>
          </Button>
        }
      />
      {resource.error ? (
        <ErrorState message={resource.error} retry={resource.reload} />
      ) : !doc ? (
        <Loading />
      ) : (
        <>
          {production && doc.immutableSnapshot.reference && <Card className="mb-6 shadow-none"><CardHeader><CardTitle>{doc.immutableSnapshot.documentTypeCode === '07' ? 'Nota de crédito' : 'Nota de débito'}</CardTitle><CardDescription>Referencia: <Link className="underline" href={`/documents/${doc.immutableSnapshot.reference.documentId}`}>{doc.immutableSnapshot.reference.fullNumber}</Link></CardDescription></CardHeader><CardContent><p className="text-sm">{doc.immutableSnapshot.reasonCode} · {doc.immutableSnapshot.reasonDescription}</p></CardContent></Card>}
          <div className="mb-6 grid gap-5 lg:grid-cols-[1fr_340px]">
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>{doc.immutableSnapshot.issuer.legalName}</CardTitle>
                <CardDescription>
                  RUC {doc.immutableSnapshot.issuer.identityNumber} ·{" "}
                  {doc.immutableSnapshot.environment}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p>{doc.immutableSnapshot.issuer.address}</p>
                <div className="border-t pt-4">
                  <p className="text-xs text-muted-foreground">Cliente</p>
                  <p className="mt-1 font-medium">
                    {doc.immutableSnapshot.customer.legalName}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    Documento: {doc.immutableSnapshot.customer.identityNumber}
                  </p>
                </div>
                <p className="text-muted-foreground">
                  {new Intl.DateTimeFormat("es-PE", {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: "America/Lima",
                  }).format(new Date(doc.immutableSnapshot.issueDate))}{" "}
                  · Lima
                </p>
                <StatusBadge status={doc.sunatStatus} />
                <p className="text-xs text-muted-foreground">
                  {doc.sunatResponseDescription}
                </p>
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>{production ? "Representación del comprobante" : "Representaciones de prueba"}</CardTitle>
                <CardDescription>
                  {production ? "PDF generado desde el XML firmado; el estado fiscal figura en el documento." : "PDF local, sin validez tributaria."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Button
                  className="w-full justify-start"
                  disabled={!!busy}
                  onClick={() => void download("ticket")}
                >
                  <ReceiptText className="size-4" />{" "}
                  {busy === "ticket" ? "Preparando…" : "Descargar ticket 80 mm"}
                  <Download className="ml-auto size-4" />
                </Button>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  disabled={!!busy}
                  onClick={() => void download("a4")}
                >
                  <FileText className="size-4" />{" "}
                  {busy === "a4" ? "Preparando…" : "Descargar PDF A4"}
                  <Download className="ml-auto size-4" />
                </Button>
                {error && <ErrorState message={error} />}
                <div className="flex flex-col gap-2">
                  <PdfPrintButton path={`/api/v1/fiscal-artifacts/${id}/ticket`} format="ticket" mode={production ? "FISCAL" : "LOCAL"} label={production ? "Imprimir ticket 80 mm" : "Imprimir ticket local sin firma"} disabled={!!busy} />
                  <PdfPrintButton path={`/api/v1/fiscal-artifacts/${id}/a4`} format="a4" mode={production ? "FISCAL" : "LOCAL"} label={production ? "Imprimir A4" : "Imprimir A4 local sin firma"} disabled={!!busy} />
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Cualquier marca con controlador instalado: térmica de 80 mm
                  o impresora de oficina con papel A4. Seleccione su equipo
                  USB, de red o compartido en el diálogo de impresión.
                  {production ? " Imprima a tamaño real y compruebe que el QR sea legible." : " Si está en preparación, reintente en unos segundos. Firma, QR, CDR y validación fiscal pendientes en estos PDF locales de prueba."}

                </p>
                <Button variant="ghost" size="sm" onClick={resource.reload}>
                  <RefreshCw className="size-4" /> Consultar estado
                </Button>
              </CardContent>
            </Card>
          </div>
          {production && <FiscalOriginals documentId={id} fileNumber={`${doc.immutableSnapshot.issuer.identityNumber}-${doc.immutableSnapshot.documentTypeCode ?? "01"}-${doc.fullNumber}`} />}
          {production && can('document.email') && user?.scope.kind === 'GLOBAL' && user.roles.includes('ADMIN') && ['01','03','07','08'].includes(doc.immutableSnapshot.documentTypeCode ?? '') && ['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS'].includes(doc.sunatStatus) && <FiscalDocumentMail key={`mail:${id}`} documentId={id} companyId={doc.companyId} ruc={doc.immutableSnapshot.issuer.identityNumber}/> }
          {production && ['01','03'].includes(doc.immutableSnapshot.documentTypeCode??'') && ['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS'].includes(doc.sunatStatus) && <ProductionNotesPanel documentId={id}/> }
          {canValidate && <Card className="mb-6 shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5" /> Laboratorio XML · Sólo prueba local</CardTitle>
              <CardDescription>Emisor ficticio · BETA · Sin transmisión ni validez tributaria</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">Comprueba importes de ventas con IGV 18%, firma con el certificado ficticio configurado para este RUC, verifica la firma y prepara un ZIP. No valida todavía los XSD ni todas las reglas SUNAT. No genera CDR ni consume otro correlativo.</p>
              <Button variant="outline" disabled={!!busy} onClick={() => void validateAndDownload()}>
                <ShieldCheck className="size-4" /> {busy === "xml" ? "Verificando firma…" : "Validar firma y descargar ZIP de prueba"}
              </Button>
              {validation?.signatureVerified && <div role="status" className="rounded-lg border p-3 text-sm">
                <p className="font-medium">Firma local verificada · ZIP preparado</p>
                <p className="mt-1 text-muted-foreground">Esto no significa aceptación SUNAT. Perfil {validation.profile}.</p>
                <p className="mt-2 break-all font-mono text-xs">Certificado: {validation.certificateFingerprint}</p>
                <p className="mt-1 break-all font-mono text-xs">SHA-256 ZIP: {validation.zipSha256}</p>
              </div>}
            </CardContent>
          </Card>}
          {canValidate && <CircuitQa key={id} documentId={id} fileNumber={doc.fullNumber} />}
          {canValidate && <div className="mb-6 flex flex-wrap gap-3"><Button variant="outline" asChild><Link href={`/notes/${id}`}>Preparar nota de crédito/débito de prueba</Link></Button><Button variant="outline" asChild><Link href="/batches">Resúmenes múltiples y bajas de prueba</Link></Button></div>}
          {doc.immutableSnapshot.environment === 'BETA' && <SupplementTracking key={`tracking:${id}`} documentId={id} />}
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle>Detalle de la operación</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Descripción</TableHead>
                    <TableHead>Cantidad</TableHead>
                    <TableHead>Precio con IGV</TableHead>
                    <TableHead className="text-right">Importe</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {doc.immutableSnapshot.lines.map((line) => (
                    <TableRow key={line.lineNumber}>
                      <TableCell className="max-w-lg whitespace-normal">
                        {line.description}
                      </TableCell>
                      <TableCell>
                        {line.quantity} {line.unitCode}
                      </TableCell>
                      <TableCell>
                        {money(
                          line.unitPriceWithTax,
                          doc.immutableSnapshot.currencyCode,
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {money(
                          line.totalAmount,
                          doc.immutableSnapshot.currencyCode,
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="ml-auto mt-6 max-w-sm space-y-3 text-sm">
                <div className="flex justify-between text-muted-foreground">
                  <span>Base de ítems sin IGV</span>
                  <span>
                    {money(
                      doc.immutableSnapshot.totals.taxableAmount,
                      doc.immutableSnapshot.currencyCode,
                    )}
                  </span>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>IGV</span>
                  <span>
                    {money(
                      doc.immutableSnapshot.totals.igvAmount,
                      doc.immutableSnapshot.currencyCode,
                    )}
                  </span>
                </div>
                <div className="flex justify-between border-t pt-3 text-xl font-semibold">
                  <span>Total</span>
                  <span>
                    {money(
                      doc.immutableSnapshot.totals.payableAmount,
                      doc.immutableSnapshot.currencyCode,
                    )}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
