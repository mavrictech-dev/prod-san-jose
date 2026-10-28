"use client";
import { useEffect, useState } from "react";
import { Search, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { Card, CardContent } from "@factuez/ui/components/card";
import { Input } from "@factuez/ui/components/input";
import { Button } from "@factuez/ui/components/button";
import {
  useResource,
  useWorkspace,
} from "../../../features/workspace/provider";
import {
  ErrorState,
  Loading,
  PageHeading,
} from "../../../features/workspace/common";
import { DocumentTable } from "../../../features/workspace/document-table";
import type { DocumentPage } from "../../../features/workspace/types";
export default function DocumentsPage() {
  const { branchId, companyId, catalogSource } = useWorkspace();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [branchId, companyId, catalogSource]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams({ page: String(page), q: query, dataSource: catalogSource });
  if (branchId) params.set("branchId", branchId);
  if (companyId) params.set("companyId", companyId);
  const { data, error, reload } = useResource<DocumentPage>(
    `/api/v1/documents?${params}`,
    true,
  );
  return (
    <>
      <PageHeading
        eyebrow="Registro de emisión"
        title="Comprobantes"
        description="Busca por número o cliente y selecciona Ver detalles para consultar la ficha completa. Sólo verás tus sedes, puntos y series autorizados."
      />
      <Card className="shadow-none">
        <CardContent>
          <div className="mb-5 flex gap-3">
            <div className="relative w-full max-w-md">
              <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
              <Input
                className="pl-9"
                aria-label="Buscar comprobantes"
                placeholder="Número de comprobante o cliente…"
                maxLength={100}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <Button
              variant="outline"
              size="icon"
              aria-label="Actualizar comprobantes"
              onClick={reload}
            >
              <RefreshCw className="size-4" />
            </Button>
          </div>
          {error ? (
            <ErrorState message={error} retry={reload} />
          ) : data ? (
            <>
              <DocumentTable items={data.items} />
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-xs text-muted-foreground">
                <span>
                  {data.total} resultados · Página {data.page} de{" "}
                  {Math.max(1, Math.ceil(data.total / data.pageSize))}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage(page - 1)}
                  >
                    <ChevronLeft className="size-4" />
                    Anterior
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page * data.pageSize >= data.total}
                    onClick={() => setPage(page + 1)}
                  >
                    Siguiente
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <Loading />
          )}
        </CardContent>
      </Card>
    </>
  );
}
