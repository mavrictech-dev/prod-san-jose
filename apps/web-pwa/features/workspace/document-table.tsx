"use client";
import Link from "next/link";
import { Eye } from "lucide-react";
import { Button } from "@factuez/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@factuez/ui/components/table";
import { Empty, money, StatusBadge } from "./common";
import type { DocumentRow } from "./types";
export function DocumentTable({ items }: { items: DocumentRow[] }) {
  if (!items.length)
    return (
      <Empty
        title="Sin comprobantes todavía"
        description="Los documentos emitidos en las sedes autorizadas aparecerán aquí."
      />
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Documento / cliente</TableHead>
          <TableHead>RUC emisor / sede</TableHead>
          <TableHead>Fecha · Lima</TableHead>
          <TableHead className="text-right">Importe</TableHead>
          <TableHead>Estado</TableHead>
          <TableHead className="text-right">Acciones</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.id}>
            <TableCell>
              <Link
                className="font-medium underline-offset-4 hover:underline"
                href={`/documents/${item.id}`}
                aria-label={`Ver ${item.fullNumber} de RUC ${item.issuerRuc}`}
              >
                {item.fullNumber}
              </Link>
              <p className="mt-1 max-w-64 truncate text-xs text-muted-foreground">
                {item.customerLegalName}
              </p>
            </TableCell>
            <TableCell className="text-xs">
              <p className="font-mono">{item.issuerRuc}</p>
              <p className="mt-1 text-muted-foreground">{item.branchName}</p>
            </TableCell>
            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
              {new Intl.DateTimeFormat("es-PE", {
                dateStyle: "short",
                timeStyle: "short",
                timeZone: "America/Lima",
              }).format(new Date(item.issueDate))}
            </TableCell>
            <TableCell className="text-right font-medium tabular-nums">
              {money(item.payableAmount, item.currencyCode)}
            </TableCell>
            <TableCell>
              <StatusBadge status={item.sunatStatus} />
            </TableCell>
            <TableCell className="text-right">
              <Button variant="outline" size="sm" asChild>
                <Link
                  href={`/documents/${item.id}`}
                  aria-label={`Ver detalles de ${item.fullNumber} de RUC ${item.issuerRuc}`}
                >
                  <Eye className="size-4" aria-hidden="true" />
                  Ver detalles
                </Link>
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
