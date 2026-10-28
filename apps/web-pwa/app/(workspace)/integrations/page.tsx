"use client";

import Link from 'next/link';
import { Button } from '@factuez/ui/components/button';
import { AdminSsoSessionHost } from '../../../features/b2b/admin-session-host';
import { canManageIntegrations } from '../../../features/b2b/integration-access';
import { ConfigurationOverview } from '../../../features/b2b/configuration-overview';
import { useWorkspace } from '../../../features/workspace/provider';
import { PageHeading } from '../../../features/workspace/common';

export default function IntegrationsPage() {
  const { user, can } = useWorkspace();
  if (!canManageIntegrations(user, can)) return <p role="alert">Esta sección requiere un administrador general autorizado.</p>;
  return <div className="mx-auto w-full max-w-6xl space-y-6">
    <PageHeading eyebrow="CONEXIONES" title="Conexiones e integraciones" description="Aplicaciones B2B, permisos de acceso y servicios por emisor." />
    <nav aria-label="Accesos de conexiones" className="flex flex-wrap gap-2">
      {can('document.view') && <Button asChild><Link href="/stations">Gestionar RUC</Link></Button>}
      {can('sunat.configure') && <Button variant="outline" asChild><Link href="/sunat-settings">Cargar credenciales</Link></Button>}
      <Button variant="outline" asChild><a href="/api-docs" target="_blank" rel="noopener noreferrer">Swagger B2B</a></Button>
      {can('sunat.configure') && <Button variant="outline" asChild><Link href="/api-reference">API del sistema</Link></Button>}
      <Button variant="outline" asChild><a href="#b2b-access">Aplicaciones B2B</a></Button>
      <Button variant="outline" asChild><a href="#issuer-services">Servicios por emisor</a></Button>
    </nav>
    <section id="b2b-access" aria-label="Acceso a aplicaciones B2B" className="scroll-mt-6">
      <AdminSsoSessionHost />
    </section>
    <section id="issuer-services" aria-label="Configuración de servicios por emisor" className="scroll-mt-6">
      <ConfigurationOverview />
    </section>
  </div>;
}
