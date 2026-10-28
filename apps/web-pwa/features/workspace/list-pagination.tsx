"use client";
import { Button } from "@factuez/ui/components/button";
export function pageWindow(total: number, requested: number, size = 10) {
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(pages, Math.max(1, requested));
  return { page, pages, start: (page - 1) * size, end: Math.min(page * size, total) };
}
export function ListPagination({ total, page, pageSize = 10, onChange }: { total: number; page: number; pageSize?: number; onChange: (page: number) => void }) {
  const window = pageWindow(total, page, pageSize);
  return <nav aria-label="Paginación" className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-xs text-muted-foreground"><span>{total ? window.start + 1 : 0}–{window.end} de {total} registros · Página {window.page} de {window.pages}</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={window.page === 1} onClick={() => onChange(window.page - 1)}>Anterior</Button><Button variant="outline" size="sm" disabled={window.page === window.pages} onClick={() => onChange(window.page + 1)}>Siguiente</Button></div></nav>;
}
