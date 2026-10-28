"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { CollaborationLogos, SanJoseLogo } from "./brand";
import { usePathname, useRouter } from "next/navigation";
import {
  Building2,
  Fuel,
  LayoutDashboard,
  FileText,
  Users,
  ShieldCheck,
  KeyRound,
  Plug,
  LogOut,
  Moon,
  Sun,
  FlaskConical,
  ChevronRight,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@factuez/ui/components/sidebar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@factuez/ui/components/select";
import { Button } from "@factuez/ui/components/button";
import { Badge } from "@factuez/ui/components/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@factuez/ui/components/dialog";
import { useWorkspace } from "./provider";
import { canManageIntegrations } from "../b2b/integration-access";
import { CATALOG_VIEW_LABELS, type CatalogView } from './catalog-model';
import { Empty, ErrorState, Loading, rolesText } from "./common";
const menu = [
  { href: '/integrations', title: 'Conexiones e integraciones', icon: Plug, permission: 'setup.manage', group: 'Conexiones' },
  { href: '/ti-guide', title: 'Guía para TI', icon: FileText, permission: 'setup.manage', group: 'Administración' },
  { href: '/api-docs', title: 'Documentación API', icon: FileText, permission: 'setup.manage', group: 'Administración' },
  { href: '/received', title: 'Documentos recibidos', icon: FileText, permission: 'report.view', group: 'Documentos' },
  { href: '/print-settings', title: 'Formatos y logos', icon: FileText, permission: 'setup.manage', group: 'Administración' },
  { href: '/shadow-lab', title: 'Modo sombra (pruebas)', icon: FlaskConical, permission: 'sunat.configure', group: 'Administración' },
  { href: '/fiscal-lab', title: 'Laboratorio fiscal Beta', icon: FlaskConical, permission: 'sunat.configure', group: 'Administración' },
  { href: '/batches', title: 'Resúmenes y bajas', icon: FileText, permission: 'sunat.configure', group: 'Documentos' },
  { href: '/notes', title: 'Notas de crédito/débito', icon: FileText, permission: 'sunat.configure', group: 'Documentos' },
  { href: '/guides', title: 'Guías de remisión', icon: FileText, permission: 'sunat.configure', group: 'Documentos' },
  { href: '/mail-settings', title: 'Correo corporativo', icon: KeyRound, permission: 'document.email', group: 'Administración' },
  {
    href: "/dashboard",
    title: "Resumen",
    icon: LayoutDashboard,
    permission: "report.view",
    group: "Operación",
  },
  {
    href: "/pos",
    title: "Terminal de pista",
    icon: Fuel,
    permission: "document.issue",
    group: "Operación",
  },
  {
    href: "/documents",
    title: "Comprobantes emitidos",
    icon: FileText,
    permission: "document.view",
    group: "Documentos",
  },
  {
    href: "/stations",
    title: "Sedes y maestros",
    icon: Building2,
    permission: "document.view",
    group: "Administración",
  },
  {
    href: "/users",
    title: "Usuarios",
    icon: Users,
    permission: "user.manage",
    group: "Administración",
  },
  {
    href: "/roles",
    title: "Roles y permisos",
    icon: ShieldCheck,
    permission: "role.manage",
    group: "Administración",
  },
  {
    href: "/sunat-settings",
    title: "Configuración SUNAT",
    icon: KeyRound,
    permission: "sunat.configure",
    group: "Administración",
  },
];
export function WorkspaceShell({ children }: { children: ReactNode }) {
  const {
    user,
    restoring,
    restoreError,
    retryRestore,
    catalog,
    catalogSource,
    setCatalogSource,
    branchId,
    companyId,
    setCompany,
    setBranch,
    can,
    logout,
    catalogError,
    reloadCatalog,
    dirty,
    setDirty,
  } = useWorkspace();
  const pathname = usePathname();
  const router = useRouter();
  const [dark, setDark] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  useEffect(() => {
    if (!user && !restoring && !restoreError) router.replace("/login");
  }, [user, restoring, restoreError, router]);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  function confirm(action: () => void) {
    if (dirty) setPending(() => action);
    else action();
  }
  if (!user && restoreError) return <main className="p-8"><ErrorState message={restoreError} /><Button onClick={retryRestore}>Reintentar sesión</Button></main>;
  if (!user || restoring) return <Loading />;
  const integrationsAllowed = canManageIntegrations(user, can);
  const current = menu.find(
    (item) => item.href === pathname || pathname.startsWith(`${item.href}/`),
  );
  const selectedCompany = catalog?.companies.find(company => String(company.id) === companyId);
  const branches = catalog?.branches.filter(branch => !companyId || String(branch.companyId) === companyId) ?? [];
  return (
    <SidebarProvider
      style={{ "--sidebar-width": "15rem" } as React.CSSProperties}
    >
      <Sidebar collapsible="icon">
        <SidebarHeader className="px-5 py-7">
          <SanJoseLogo className="w-40 self-start group-data-[collapsible=icon]:hidden" />
          <Fuel className="hidden size-5 group-data-[collapsible=icon]:block" />
        </SidebarHeader>
        <SidebarContent>
          {["Operación", "Conexiones", "Documentos", "Administración"].filter(group => group !== "Conexiones" || integrationsAllowed).map((group) => (
            <SidebarGroup key={group}>
              <SidebarGroupLabel className="mb-2 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                {group}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {menu
                    .filter(
                      (item) => item.group === group && can(item.permission) && (item.href !== '/integrations' || integrationsAllowed) && (item.href !== '/shadow-lab' || user.scope.kind === 'GLOBAL' && user.roles.includes('ADMIN')),
                    )
                    .map((item) => (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton
                          asChild
                          isActive={pathname === item.href}
                          tooltip={item.title}
                          className={item.href === '/integrations' ? "min-h-11 h-auto py-2 group-data-[collapsible=icon]:min-h-0 [&>span:last-child]:whitespace-normal [&>span:last-child]:leading-snug" : "h-11"}
                        >
                          <Link
                            href={item.href}
                            target={item.href === '/api-docs' ? '_blank' : undefined}
                            rel={item.href === '/api-docs' ? 'noopener noreferrer' : undefined}
                            prefetch={item.href === '/api-docs' ? false : undefined}
                            onClick={(event) => {
                              if (item.href === '/api-docs') return;
                              if (dirty) {
                                event.preventDefault();
                                confirm(() => {
                                  setDirty(false);
                                  router.push(item.href);
                                });
                              }
                            }}
                          >
                            <item.icon />
                            <span>{item.title}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter className="p-4">
          <div className="mb-3 rounded-lg border border-white/10 p-3 group-data-[collapsible=icon]:hidden">
            <p className="text-xs font-medium">
              {user.fullName ?? user.username}
            </p>
            <p className="mt-1 text-[11px] text-slate-400">
              {user.roles.map((role) => rolesText[role] ?? role).join(" · ")}
            </p>
          </div>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() =>
                  confirm(() => {
                    logout();
                    router.replace("/login");
                  })
                }
                tooltip="Cerrar sesión"
              >
                <LogOut />
                <span>Cerrar sesión</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <CollaborationLogos
            compact
            dark
            className="mt-2 self-start group-data-[collapsible=icon]:hidden"
          />
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0 bg-background">
        <header className="flex min-h-18 flex-wrap items-center gap-3 border-b bg-card px-4 py-3 sm:px-7">
          <SidebarTrigger aria-label="Abrir o cerrar menú" />
          <span className="hidden text-sm text-muted-foreground sm:block">
            San José
          </span>
          <ChevronRight className="hidden size-3.5 text-muted-foreground sm:block" />
          <span className="hidden text-sm font-medium xl:block">
            {current?.title}
          </span>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2 sm:gap-3">
            {integrationsAllowed && <Button variant="outline" size="sm" asChild>
              <Link href="/integrations" aria-label="Abrir conexiones e integraciones" aria-current={pathname === '/integrations' ? 'page' : undefined} onClick={event => {
                if (dirty) {
                  event.preventDefault();
                  confirm(() => { setDirty(false); router.push('/integrations'); });
                }
              }}><Plug aria-hidden="true" className="size-4" />Conexiones</Link>
            </Button>}
            {catalog && <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Catálogo</span>
              <Select value={catalogSource} onValueChange={value => confirm(() => setCatalogSource(value as CatalogView))}>
                <SelectTrigger aria-label="Fuente del catálogo" className="w-40 sm:w-48"><SelectValue /></SelectTrigger>
                <SelectContent>{(Object.keys(CATALOG_VIEW_LABELS) as CatalogView[]).map(source =>
                  <SelectItem key={source} value={source}>{CATALOG_VIEW_LABELS[source]}</SelectItem>,
                )}</SelectContent>
              </Select>
            </div>}
            {catalog && (
              <Select
                value={companyId || (user.scope.kind === 'GLOBAL' ? 'all' : undefined)}
                disabled={user.scope.kind !== 'GLOBAL' && catalog.companies.length === 1}
                onValueChange={(value) =>
                  confirm(() => setCompany(value === "all" ? "" : value))
                }
              >
                <SelectTrigger
                  aria-label="Emisor RUC activo"
                  className="w-44 sm:w-56"
                >
                  <SelectValue placeholder="Emisor RUC" />
                </SelectTrigger>
                <SelectContent>
                  {user.scope.kind === "GLOBAL" && (
                    <SelectItem value="all">Consolidado (todo el alcance)</SelectItem>
                  )}
                  {catalog.companies.map((company) => (
                    <SelectItem key={company.id} value={String(company.id)}>
                      {company.ruc} · {company.legalName}
                      {company.source === 'SYNTHETIC' ? ' · QA' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {catalog && (
                <Select
                  value={branchId || (user.scope.kind === 'GLOBAL' ? 'all' : undefined)}
                  disabled={user.scope.kind !== 'GLOBAL' && branches.length === 1}
                  onValueChange={(value) =>
                    confirm(() => setBranch(value === "all" ? "" : value))
                  }
                >
                  <SelectTrigger
                    aria-label="Sede activa"
                    className="w-44 sm:w-56"
                  >
                    <Building2 className="size-4 text-muted-foreground" />
                    <SelectValue placeholder="Selecciona sede" />
                  </SelectTrigger>
                  <SelectContent>
                    {user.scope.kind === "GLOBAL" && (
                      <SelectItem value="all">Todas las sedes</SelectItem>
                    )}
                    {branches.map((branch) => (
                        <SelectItem value={branch.id} key={branch.id}>
                          {branch.name}
                          {branch.source === 'SYNTHETIC' ? ' · QA' : ''}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              )}
            <Badge
              variant="outline"
              className="hidden border-amber-200 bg-amber-50 text-amber-900 sm:flex"
            >
              <FlaskConical className="mr-1 size-3" />
              {selectedCompany ? `${selectedCompany.environment} · ${selectedCompany.source === 'SYNTHETIC' ? 'Laboratorio QA' : 'Negocio'}` : 'Consolidado autorizado'}
            </Badge>
            <Button
              variant="ghost"
              size="icon"
              aria-label={dark ? "Usar tema claro" : "Usar tema oscuro"}
              onClick={() => setDark(!dark)}
            >
              {dark ? <Sun /> : <Moon />}
            </Button>
          </div>
        </header>
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs leading-relaxed text-amber-900 sm:px-7">
          {selectedCompany?.environment === 'PRODUCTION'
            ? 'Producción · El estado fiscal de cada comprobante se confirma con su CDR.'
            : selectedCompany?.environment === 'BETA'
              ? 'Ambiente de pruebas Beta · Sin validez tributaria.'
              : 'Vista consolidada de las empresas y sedes autorizadas.'}
          {catalogSource !== 'BUSINESS' && <> {CATALOG_VIEW_LABELS[catalogSource]} · Incluye datos de pruebas.</>}

        </div>
        <div className="mx-auto w-full max-w-[1600px] p-4 sm:p-7 lg:p-8">
          {catalogError ? (
            <ErrorState
              message={catalogError}
              retry={() => void reloadCatalog()}
            />
          ) : !catalog ? (
            <Loading />
          ) : current && (!can(current.permission) || current.href === '/integrations' && !integrationsAllowed) ? (
            <Empty
              title="Acceso no autorizado"
              description="Tu cuenta no tiene permiso para este módulo."
            />
          ) : (
            <><div className="mb-4 text-xs text-muted-foreground" role="status">
              {!catalog.companies.length && `No hay emisores en la vista ${CATALOG_VIEW_LABELS[catalogSource]}. Cambia Fuente del catálogo para consultar las otras fuentes autorizadas.`}
            </div><div key={`${catalogSource}:${companyId}:${branchId}`}>{children}</div></>
          )}
        </div>
      </SidebarInset>
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Hay datos sin guardar</DialogTitle>
            <DialogDescription>
              {pathname === '/shadow-lab' ? 'Las anotaciones y motivos del laboratorio están sólo en memoria. Descárgalos antes de salir; continuar los descarta sin modificar documentos fiscales.' : <>Los borradores no enviados se descartarán. Una solicitud de
              emisión enviada sin respuesta conserva su clave en esta pestaña;
              salir no la cancela. ¿Deseas continuar?</>}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>
              Seguir editando
            </Button>
            <Button
              onClick={() => {
                const action = pending;
                setPending(null);
                setDirty(false);
                action?.();
              }}
            >
              Continuar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );
}
