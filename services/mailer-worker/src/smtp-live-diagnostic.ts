import { Injectable } from '@nestjs/common';
import { AccessError } from '@factuez/service-access';
import { lookup } from 'node:dns/promises';
import { connect, isIP, type NetConnectOpts, type Socket } from 'node:net';
import { createRequire } from 'node:module';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { corporateEmailSmtpOptions, type CorporateEmailNetwork } from './b2b/email-deliveries.corporate';
import { approvedHost, approvedSmtpHosts, type CorporateSmtpConfiguration } from './smtp-configuration.policy';

export interface DiagnosticMailer { verify(): Promise<true>; close(): void }
/** Read/verify ports only. No message or recipient can reach this diagnostic. */
export interface SmtpDiagnosticNetwork extends Pick<CorporateEmailNetwork, 'resolve'> {
  createTransport(options: SMTPTransport.Options): DiagnosticMailer;
  connect(options: NetConnectOpts): Socket;
}
export const smtpDiagnosticNetwork: SmtpDiagnosticNetwork = {
  resolve: async host => (await lookup(host, { family: 4, all: true })).map(row => row.address),
  createTransport: options => createRequire(__filename)('nodemailer').createTransport(options),
  connect: options => connect(options),
};
const disabled = () => new AccessError(423, 'Diagnóstico de conexión SMTP deshabilitado en este servidor');
const timeout = () => new AccessError(504, 'La comprobación SMTP superó el límite de 15 segundos');
const failed = () => new AccessError(503, 'No se pudo verificar conexión, certificado TLS y autenticación SMTP');

export function smtpConnectionDiagnosticsEnabled() { return process.env.SMTP_CONNECTION_DIAGNOSTICS_ENABLED === 'true'; }

/** Conservative IPv4-only egress, matching the corporate port, including legacy reserved relay space.
 * No private relay policy is configured by this panel; corporate send policies are never inferred. */
export function diagnosticPublicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return a > 0 && a < 224 && a !== 10 && a !== 127 &&
    !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || b === 0 || b === 2 || b === 88 && c === 99)) &&
    !(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) &&
    !(a === 203 && b === 0 && c === 113);
}

export interface DiagnosticScope {
  check(): void;
  step<T>(operation: () => Promise<T>): Promise<T>;
  cleanup(action: () => void): void;
}

@Injectable()
export class SmtpLiveDiagnostic {
  private active = 0;
  private readonly attempts = new Map<string, { count: number; expires: number }>();
  constructor(private readonly io: SmtpDiagnosticNetwork = smtpDiagnosticNetwork) {}

  /** A single server instance admits two checks, without a queue, and bounded rate-limit memory. */
  async run<T>(subject: string, ruc: string, operation: (scope: DiagnosticScope) => Promise<T>, startedAt = Date.now()): Promise<T> {
    if (!smtpConnectionDiagnosticsEnabled()) throw disabled();
    if (this.active >= 2) throw new AccessError(429, 'Hay dos comprobaciones SMTP en curso; intente más tarde');
    const now = Date.now();
    const deadline = startedAt + 15000;
    if (now >= deadline) throw timeout();
    for (const [key, value] of this.attempts) if (value.expires <= now) this.attempts.delete(key);
    const limits = [{ key: 'subject:' + subject, max: 6 }, { key: 'ruc:' + ruc, max: 3 }];
    if (this.attempts.size >= 4094 || limits.some(({ key, max }) => (this.attempts.get(key)?.count ?? 0) >= max))
      throw new AccessError(429, 'Límite de comprobaciones SMTP alcanzado; espere un minuto');
    for (const { key } of limits) {
      const value = this.attempts.get(key) ?? { count: 0, expires: now + 60000 };
      value.count++; this.attempts.set(key, value);
    }
    this.active++;
    try { return await withSmtpDeadline(operation, () => { if (!smtpConnectionDiagnosticsEnabled()) throw disabled(); }, deadline); }
    finally { this.active--; }
  }

  async verify(config: CorporateSmtpConfiguration, beforeConnection: () => Promise<void>, scope: DiagnosticScope) {
    const options = await pinnedSmtpOptions(config, beforeConnection, scope, this.io);
    let mailer: DiagnosticMailer | undefined;
    try {
      mailer = this.io.createTransport(options);
      scope.cleanup(() => mailer!.close());
      if (await scope.step(() => mailer!.verify()) !== true) throw failed();
    } catch { scope.check(); throw failed(); }
    return { dnsValidated: true, smtpAuthenticationVerified: true, tlsVerified: true } as const;
  }
}

/** Shared strict session policy; diagnostic and test-send gates remain independent. */
export async function pinnedSmtpOptions(config: CorporateSmtpConfiguration, beforeConnection: () => Promise<void>, scope: DiagnosticScope,
  io: Pick<SmtpDiagnosticNetwork, 'resolve' | 'connect'>): Promise<SMTPTransport.Options> {
    scope.check();
    if (!approvedHost(config.host)) throw new AccessError(400, 'Servidor SMTP no aprobado por infraestructura');
    let addresses: readonly string[];
    try { addresses = await scope.step(() => io.resolve(config.host)); }
    catch { scope.check(); throw failed(); }
    if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(a => typeof a !== 'string' || !diagnosticPublicIpv4(a)))
      throw new AccessError(503, 'DNS SMTP rechazado: se requieren únicamente direcciones IPv4 públicas');
    const address = addresses[0];
    await scope.step(beforeConnection);
    // Reuse strict corporate TLS options; pin the socket and SNI separately. Never re-resolve the hostname.
    const options: SMTPTransport.Options = { ...corporateEmailSmtpOptions(config, approvedSmtpHosts(), address),
      forceAuth: true, name: '[127.0.0.1]',
      getSocket: (_options, callback) => {
        let handedOff = false;
        const done: typeof callback = (...args) => { if (!handedOff) { handedOff = true; callback(...args); } };
        try {
          scope.check();
          const socket = io.connect({ host: address, port: config.port, family: 4,
            lookup: (_host, options, done) => {
              try { scope.check(); if (options.all) done(null, [{ address, family: 4 }]); else done(null, address, 4); }
              catch { done(timeout(), '', 4); }
            } });
          // Transport.close() alone does not close a pending non-pooled verify connection.
          scope.cleanup(() => socket.destroy());
          socket.once('error', () => done(failed()));
          socket.once('connect', () => {
            // The TCP handshake can outlive a grant or credential change. Recheck before TLS handoff.
            void scope.step(beforeConnection).then(() => {
              try { scope.check(); done(null, { connection: socket }); }
              catch { socket.destroy(); done(timeout()); }
            }, () => { socket.destroy(); done(failed()); });
          });
        } catch { done(failed()); }
      },
    };
    scope.check();
    return options;
}

export async function withSmtpDeadline<T>(operation: (scope: DiagnosticScope) => Promise<T>, gate: () => void, deadline = Date.now() + 15000): Promise<T> {
    let stopped = false;
    const cleanups: Array<() => void> = [];
    const scope: DiagnosticScope = {
      check: () => {
        if (stopped || Date.now() >= deadline) throw timeout();
        gate();
      },
      step: async action => { scope.check(); const value = await action(); scope.check(); return value; },
      cleanup: action => { if (stopped) { try { action(); } catch {} } else cleanups.push(action); },
    };
    const close = () => { stopped = true; for (const action of cleanups.splice(0)) { try { action(); } catch {} } };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(scope)),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { close(); reject(timeout()); }, Math.max(0, deadline - Date.now())); }),
      ]);
    } finally { if (timer) clearTimeout(timer); close(); }
  }
