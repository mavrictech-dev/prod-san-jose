import { createRequire } from 'node:module';
import { createServer as netServer, connect, type Socket } from 'node:net';
import { createServer as tlsServer, TLSSocket, createSecureContext } from 'node:tls';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { corporateEmailPki } from './b2b-email-deliveries-corporate-tls.fixture';
import { SmtpLiveDiagnostic } from '../services/mailer-worker/src/smtp-live-diagnostic';
const { createTransport } = createRequire(new URL('../services/mailer-worker/package.json', import.meta.url))('nodemailer');
let pki: ReturnType<typeof corporateEmailPki>;
beforeAll(() => { pki = corporateEmailPki(); });
beforeEach(() => { vi.stubEnv('SMTP_CONNECTION_DIAGNOSTICS_ENABLED', 'true'); vi.stubEnv('SMTP_APPROVED_HOSTS', 'smtp.corporativo.pe'); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('Nodemailer verify contra SMTP ficticio, sólo loopback', () => {
  it.each([
    { port: 465, success: true, mode: 'TLS' },
    { port: 587, success: true, mode: 'STARTTLS' },
    { port: 587, success: false, mode: 'sin STARTTLS' },
    { port: 465, success: false, mode: 'sin AUTH' },
    { port: 465, success: false, mode: 'AUTH rechazado' },
    { port: 465, success: false, mode: 'certificado no confiable' },
    { port: 465, success: false, mode: 'hostname incorrecto' },
  ])('$mode en $port: conexión/AUTH sin MAIL, RCPT ni DATA', async scenario => {
    const commands: string[] = [], sockets = new Set<Socket>();
    let authenticated = false, authEncrypted = true;
    const context = createSecureContext({ key: pki.server.key, cert: pki.server.cert, minVersion: 'TLSv1.2' });
    const track = (socket: Socket) => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); };
    const session = (socket: Socket, greet = true) => {
      track(socket); let pending = '', login = 0;
      if (greet) socket.write('220 synthetic SMTP\r\n');
      const data = (bytes: Buffer) => {
        pending += bytes.toString('utf8'); let end: number;
        while ((end = pending.indexOf('\r\n')) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 2);
          if (login) {
            authEncrypted = authEncrypted && Boolean((socket as TLSSocket).encrypted);
            if (login++ === 1) { socket.write('334 UGFzc3dvcmQ6\r\n'); }
            else { login = 0; authenticated = scenario.success; socket.write(authenticated ? '235 authenticated\r\n' : '535 rejected\r\n'); }
            continue;
          }
          // Keep command names only, never AUTH payloads or base64 credentials.
          commands.push(line.split(' ')[0]);
          if (line.startsWith('EHLO ')) socket.write('250-synthetic\r\n' +
            (!((socket as TLSSocket).encrypted) && scenario.mode !== 'sin STARTTLS' ? '250-STARTTLS\r\n' : '') +
            (scenario.mode !== 'sin AUTH' ? '250-AUTH LOGIN PLAIN\r\n' : '') + '250 OK\r\n');
          else if (line === 'STARTTLS') {
            if (scenario.mode === 'sin STARTTLS') { socket.write('500 not supported\r\n'); continue; }
            socket.write('220 upgrade TLS\r\n'); socket.removeListener('data', data);
            const upgraded = new TLSSocket(socket, { isServer: true, secureContext: context });
            session(upgraded, false); return;
          }
          else if (line.startsWith('AUTH')) {
            authEncrypted = authEncrypted && Boolean((socket as TLSSocket).encrypted);
            if (scenario.mode === 'sin AUTH' || scenario.mode === 'AUTH rechazado') socket.write('535 authentication denied\r\n');
            else if (line.startsWith('AUTH LOGIN')) { login = 1; socket.write('334 VXNlcm5hbWU6\r\n'); }
            else { authenticated = true; socket.write('235 authenticated\r\n'); }
          }
          else if (line === 'QUIT') { socket.end('221 bye\r\n'); }
          else socket.write('500 unsupported\r\n');
        }
      };
      socket.on('data', data);
    };
    const server = scenario.port === 465 ? tlsServer({ key: pki.server.key, cert: pki.server.cert }, socket => session(socket)) : netServer(socket => session(socket));
    server.on('connection', track); server.on('tlsClientError', () => {});
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try {
      const localPort = (server.address() as { port: number }).port;
      const diagnostic = new SmtpLiveDiagnostic({
        resolve: async () => ['8.8.8.8'],
        connect: options => {
          expect(options).toMatchObject({ host: '8.8.8.8', port: scenario.port, family: 4 });
          // Test fixture alone redirects the pinned connection to an ephemeral loopback server.
          return connect({ ...options, host: '127.0.0.1', port: localPort });
        },
        createTransport: options => {
          expect(options.tls).toMatchObject({ rejectUnauthorized: true, servername: 'smtp.corporativo.pe' });
          return createTransport({ ...options, tls: { ...options.tls,
            servername: scenario.mode === 'hostname incorrecto' ? 'smtp.corporativo.pe' : '127.0.0.1',
            ...(scenario.mode === 'certificado no confiable' ? {} : { ca: pki.ca }) } });
        },
      });
      const config = { host: 'smtp.corporativo.pe', port: scenario.port as 465 | 587, tlsMode: (scenario.port === 465 ? 'TLS' : 'STARTTLS') as 'TLS' | 'STARTTLS',
        fromName: 'Synthetic', fromAddress: 'synthetic@example.invalid', replyTo: null, username: 'synthetic-user', password: 'synthetic-password' };
      const result = diagnostic.run('synthetic', '00000000001', scope => diagnostic.verify(config, async () => {}, scope));
      if (scenario.success) { await expect(result).resolves.toMatchObject({ tlsVerified: true, smtpAuthenticationVerified: true }); expect(authenticated).toBe(true); }
      else { await expect(result).rejects.toMatchObject({ status: 503 }); expect(authenticated).toBe(false); }
      expect(authEncrypted).toBe(true);
      expect(commands).not.toContain('MAIL'); expect(commands).not.toContain('RCPT'); expect(commands).not.toContain('DATA');
      if (scenario.mode === 'STARTTLS') expect(commands).toContain('STARTTLS');
      if (scenario.mode === 'sin STARTTLS' || scenario.mode.includes('certificado') || scenario.mode.includes('hostname')) expect(commands).not.toContain('AUTH');
      if (scenario.mode === 'sin AUTH') expect(commands).toContain('AUTH');
    } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 20000);
});
