import Image from "next/image";
// Recorte de presentación mediante CSS: los WebP originales permanecen intactos.
export function SanJoseLogo({ className = "w-40" }: { className?: string }) {
  return (
    <div className={`relative aspect-[961/222] overflow-hidden ${className}`}>
      <Image
        src="/brand/estaciones-san-jose.webp"
        alt="Estaciones San José"
        width={1200}
        height={800}
        sizes="220px"
        className="absolute max-w-none"
        style={{
          width: "124.87%",
          height: "auto",
          left: "-13.53%",
          top: "-128.83%",
        }}
        priority
      />
    </div>
  );
}
export function FactuezLogo({
  className = "w-28",
  dark = true,
  autoTheme = false,
  priority = false,
}: {
  className?: string;
  dark?: boolean;
  autoTheme?: boolean;
  priority?: boolean;
}) {
  const logo = (darkVariant: boolean, themeClass = "") => (
    <Image
      src={darkVariant ? "/brand/factuez-completo-oscuro.webp" : "/brand/factuez-completo-claro.webp"}
      alt="Basado en FactuEz"
      width={1200}
      height={380}
      sizes="180px"
      priority={priority}
      className={`absolute max-w-none ${themeClass}`}
      style={{ width: "150.19%", height: "auto", left: "-10.64%", top: "-26%" }}
    />
  );
  return (
    <div className={`relative aspect-[799/250] overflow-hidden ${className}`}>
      {autoTheme ? <>{logo(false, "brand-light")}{logo(true, "brand-dark")}</> : logo(dark)}
    </div>
  );
}

export function MavricLogo({
  className = "size-10",
  priority = false,
}: {
  className?: string;
  priority?: boolean;
}) {
  return (
    <Image
      src="/brand/mavric-logo.png"
      alt="Mavric Tecnologies"
      title="Mavric Tecnologies"
      width={64}
      height={64}
      sizes="64px"
      priority={priority}
      className={`shrink-0 object-contain ${className}`}
    />
  );
}

export function CollaborationLogos({
  className = "",
  dark = false,
  compact = false,
  priority = false,
}: {
  className?: string;
  dark?: boolean;
  compact?: boolean;
  priority?: boolean;
}) {
  return (
    <div
      aria-label="FactuEz y Mavric Tecnologies"
      className={`flex items-center ${compact ? "gap-3" : "gap-5"} ${className}`}
    >
      <FactuezLogo
        className={compact ? "w-28 shrink-0" : "w-40 shrink-0"}
        dark={dark}
        autoTheme={!dark}
        priority={priority}
      />
      <span aria-hidden="true" className="h-7 w-px shrink-0 bg-current opacity-20" />
      <MavricLogo className={compact ? "size-8" : "size-12"} priority={priority} />
    </div>
  );
}

export function DevelopmentCredits({
  className = "",
  dark = false,
}: {
  className?: string;
  dark?: boolean;
}) {
  return (
    <div className={`space-y-1.5 text-xs leading-relaxed ${dark ? "text-slate-400" : "text-muted-foreground"} ${className}`}>
      <p>
        Desarrollado e implementado por{" "}
        <a
          href="https://www.mavrictec.com"
          target="_blank"
          rel="noopener noreferrer"
          className={`font-medium underline underline-offset-4 ${dark ? "text-slate-200 hover:text-white" : "text-foreground hover:text-primary"}`}
        >
          www.mavrictec.com
        </a>
      </p>
    </div>
  );
}
