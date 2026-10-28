import { AccessError } from '@factuez/service-access';
import { isIP } from 'node:net';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

export type CorporateSmtpSettings = {
  host: string; port: 465 | 587; tlsMode: 'TLS' | 'STARTTLS';
  fromName: string; fromAddress: string; replyTo: string | null;
};
export type CorporateSmtpConfiguration = CorporateSmtpSettings & { username: string; password: string };
export const EXTERNAL_SMTP_STATE = 'EXTERNAL_SMTP_DISABLED' as const;

function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function keys(value: Record<string, unknown>, allowed: string[]) { if (Object.keys(value).some(key => !allowed.includes(key))) throw new AccessError(400, 'Campos SMTP no permitidos'); }
function safeText(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value); }

export function approvedSmtpHosts(value = process.env.SMTP_APPROVED_HOSTS ?? ''): string[] {
  if (!value || value.length > 2048) return [];
  const entries = value.split(',').map(host => host.trim().toLowerCase());
  if (entries.length > 16 || entries.some(host => !smtpHostname(host))) return [];
  return [...new Set(entries)];
}

/** Lista exacta administrada en el servidor; ni IP, URLs, comodines ni destinos internos por entrada HTTP. */
export function smtpHostname(host: unknown): host is string {
  return typeof host === 'string' && host.length <= 253 && !isIP(host) &&
    /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) &&
    !/(^|\.)(?:localhost|local|localdomain|internal|invalid|test|onion|home|lan)$/.test(host) &&
    !/^(?:localhost|metadata)(?:\.|$)/.test(host);
}

export function approvedHost(host: unknown, hosts = approvedSmtpHosts()): host is string { return smtpHostname(host) && hosts.includes(host); }

export function smtpMailbox(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(value);
}

export function parseSmtpSettings(value: unknown): CorporateSmtpSettings {
  if (!object(value)) throw new AccessError(400, 'Parámetros SMTP inválidos');
  keys(value, ['host', 'port', 'tlsMode', 'fromName', 'fromAddress', 'replyTo']);
  if (!smtpHostname(value.host) || (value.port !== 465 && value.port !== 587) ||
    value.tlsMode !== (value.port === 465 ? 'TLS' : 'STARTTLS') || !safeText(value.fromName, 160) ||
    value.fromName !== value.fromName.trim() || !smtpMailbox(value.fromAddress) ||
    (value.replyTo !== undefined && value.replyTo !== null && !smtpMailbox(value.replyTo)))
    throw new AccessError(400, 'Revise hostname, TLS 465/STARTTLS 587 y remitente SMTP');
  return { host: value.host, port: value.port, tlsMode: value.tlsMode, fromName: value.fromName,
    fromAddress: value.fromAddress, replyTo: value.replyTo ?? null } as CorporateSmtpSettings;
}

export function parseSmtpCredentials(value: unknown): { username: string; password: string } {
  if (!object(value)) throw new AccessError(400, 'Credenciales SMTP incompletas');
  keys(value, ['username', 'password']);
  if (!safeText(value.username, 254) || value.username !== value.username.trim() || !safeText(value.password, 512))
    throw new AccessError(400, 'Credenciales SMTP incompletas');
  return { username: value.username, password: value.password };
}

export function parseSmtpInput(value: unknown) {
  if (!object(value)) throw new AccessError(400, 'Configuración SMTP inválida');
  keys(value, ['expectedRevision', 'settings', 'credentials']);
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0 || (value.expectedRevision as number) > 2147483646)
    throw new AccessError(400, 'Revisión SMTP inválida');
  return { expectedRevision: value.expectedRevision as number, settings: parseSmtpSettings(value.settings),
    credentials: value.credentials === undefined ? undefined : parseSmtpCredentials(value.credentials) };
}

/** Sólo construcción local. No crea transporte ni abre sockets; no debe serializarse ni registrarse. */
export function corporateSmtpTransportOptions(config: CorporateSmtpConfiguration): SMTPTransport.Options {
  const { username, password } = parseSmtpCredentials({ username: config.username, password: config.password });
  const settings = parseSmtpSettings({ host: config.host, port: config.port, tlsMode: config.tlsMode,
    fromName: config.fromName, fromAddress: config.fromAddress, replyTo: config.replyTo });
  if (!approvedHost(settings.host)) throw new AccessError(400, 'Servidor SMTP no aprobado por el administrador de infraestructura');
  return {
    host: settings.host, port: settings.port, secure: settings.port === 465, requireTLS: true, ignoreTLS: false,
    opportunisticTLS: false, auth: { type: 'login', user: username, pass: password },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: settings.host },
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000, dnsTimeout: 5000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false,
  };
}
