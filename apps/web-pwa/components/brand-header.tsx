import Image from 'next/image';
import { CircleUserRound, Radio } from 'lucide-react';

function FactuEzFullLogo() {
  return (
    <>
      <Image className="brand-light h-auto w-[152px]" src="/brand/factuez-completo-claro.webp" width={1200} height={380} priority alt="FactuEz" />
      <Image className="brand-dark h-auto w-[152px]" src="/brand/factuez-completo-oscuro.webp" width={1200} height={380} priority alt="FactuEz" />
    </>
  );
}

function FactuEzMark() {
  return (
    <>
      <Image className="brand-light h-10 w-10" src="/brand/factuez-modo-claro.webp" width={512} height={512} priority alt="" />
      <Image className="brand-dark h-10 w-10" src="/brand/factuez-modo-oscuro.webp" width={512} height={512} priority alt="" />
    </>
  );
}

export function BrandHeader() {
  return (
    <header className="mb-6 flex min-h-[72px] items-center justify-between gap-3 border-b border-[var(--border)] pb-4">
      <div className="flex min-w-0 items-center gap-3">
        <div className="shrink-0 sm:hidden"><FactuEzMark /></div>
        <div className="hidden shrink-0 sm:block"><FactuEzFullLogo /></div>
        <span className="hidden h-10 w-px bg-[var(--border)] sm:block" />
        <div className="min-w-0 rounded border border-dashed border-[var(--border)] bg-[var(--surface)] px-2 py-1.5" title="Marca institucional de Grifo San José">
          <p className="mb-0.5 text-[9px] font-medium uppercase tracking-wider text-[var(--muted)]">Operado por</p>
          <Image className="h-auto w-24 object-contain sm:w-[120px]" src="/brand/estaciones-san-jose.webp" width={600} height={400} priority alt="Estaciones San José" />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="hidden items-center gap-1 rounded-full border border-emerald-600/25 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400 sm:flex"><Radio className="h-3 w-3" /> SUNAT en espera</span>
        <button aria-label="Perfil del operador" className="grid h-8 w-8 place-items-center rounded-full border border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface)]"><CircleUserRound className="h-4 w-4" /></button>
      </div>
    </header>
  );
}
