"use client";
import { useState } from "react";
import { CircleHelp } from "lucide-react";
import { Button } from "@factuez/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@factuez/ui/components/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@factuez/ui/components/tooltip";

export function FiscalHelp({ title, description }: { title: string; description: string }) {
  const [open, setOpen] = useState(false);
  return <><TooltipProvider><Tooltip><TooltipTrigger asChild><Button size="sm" variant="ghost" className="h-auto gap-1 px-1 text-xs" aria-label={`Explicar ${title}`} onClick={() => setOpen(true)}>{title}<CircleHelp className="size-3.5" /></Button></TooltipTrigger><TooltipContent className="max-w-xs">{description}</TooltipContent></Tooltip></TooltipProvider>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader></DialogContent></Dialog></>;
}

export const readinessLabels: Record<string, string> = {
  ISSUER_REAL_RUC: "Identificación del emisor", SECRET_VAULT: "Protección de credenciales",
  SOL_SECRETS_LOCAL: "Credenciales SOL", GRE_SECRETS_LOCAL: "Acceso a guías electrónicas",
  CERTIFICATE_KEY_PAIR: "Certificado y clave de firma", CERTIFICATE_RUC: "RUC del certificado",
  CERTIFICATE_CHAIN: "Entidad certificadora de confianza", CERTIFICATE_REVOCATION: "Vigencia y revocación",
  FISCAL_RULES_COVERAGE: "Reglas fiscales del comprobante", SUNAT_REGISTRATION: "Registro del emisor en SUNAT",
  BILLING_PRODUCTION_ADMISSION: "Admisión de facturas en Billing", EMISSION_ENVIRONMENT: "Ambiente de emisión de ventas", FISCAL_PROFILE: "Perfil de emisión", EMITTER_REGISTRATION_ATTESTED: "Registro declarado del emisor", XSD_RUNTIME: "Validador XSD", CDR_TRUST: "Confianza del CDR", PRODUCTION_RUNTIME: "Servicio de despacho", PRODUCTION_AUTHORIZATION_STORAGE: "Registro de autorizaciones",
  OFFICIAL_BETA_PILOT: "Prueba oficial en Beta", OFFICIAL_ACTIVATION: "Habilitación del envío oficial",
};
export const readinessActions: Record<string, string> = {
  ISSUER_REAL_RUC: "Revise el RUC en Sedes y maestros. Un identificador ficticio sólo sirve para pruebas locales.",
  SECRET_VAULT: "Solicite a TI revisar la bóveda y su clave de cifrado. No comparta esa clave en el chat.",
  SOL_SECRETS_LOCAL: "Guarde usuario secundario y contraseña en Credenciales SOL. La comprobación local no verifica el acceso a SUNAT.",
  GRE_SECRETS_LOCAL: "Configure Client ID y Client Secret cuando habilite guías. No es un requisito para facturas o boletas.",
  CERTIFICATE_KEY_PAIR: "Cargue un PKCS#12 vigente con clave privada y su contraseña. Reemplazarlo no cambia documentos ya firmados.",
  CERTIFICATE_RUC: "El certificado debe identificar al RUC seleccionado mediante un atributo de identidad válido.",
  CERTIFICATE_CHAIN: "TI debe configurar las raíces de confianza autorizadas. No se acepta un certificado autofirmado como certificado fiscal.",
  CERTIFICATE_REVOCATION: "TI debe proporcionar evidencias vigentes de revocación para la cadena. No se desactiva esta verificación.",
  FISCAL_RULES_COVERAGE: "El equipo técnico debe completar y verificar las reglas del perfil antes de habilitar su emisión oficial.",
  SUNAT_REGISTRATION: "El responsable del emisor debe acreditar su registro y certificado ante SUNAT.",
  OFFICIAL_BETA_PILOT: "Se requiere un piloto oficial acordado. Un resultado del emulador local no es una aceptación de SUNAT.",
  OFFICIAL_ACTIVATION: "Esta versión no habilita despacho oficial. Elegir Producción aquí guarda credenciales separadas, pero no envía ventas.",
};
