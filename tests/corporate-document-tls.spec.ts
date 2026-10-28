import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createServer as netServer, connect, type Socket } from 'node:net';
import { createServer as tlsServer, TLSSocket, createSecureContext } from 'node:tls';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { corporateEmailPki } from './b2b-email-deliveries-corporate-tls.fixture';
import { documentSourceFixture, documentIssuer, documentAuthorization } from './corporate-document.fixture';
import { CorporateDocumentSmtp } from '../services/mailer-worker/src/corporate-document-transport';
const { createTransport } = createRequire(new URL('../services/mailer-worker/package.json', import.meta.url))('nodemailer');
let pki: ReturnType<typeof corporateEmailPki>;
beforeAll(() => { pki = corporateEmailPki(); });
beforeEach(() => { vi.stubEnv('SERVER_SMTP_ENABLED', 'true'); vi.stubEnv('SERVER_SMTP_DOCUMENTS_ENABLED', 'true'); vi.stubEnv('SMTP_APPROVED_HOSTS', 'smtp.corporativo.pe'); });
afterEach(() => { vi.unstubAllEnvs(); });
describe('envío corporativo efectivo contra SMTP TLS ficticio en loopback', () => {
  it.each([
    { port: 465, success: true, mode: 'TLS NC07', type: '07' as const },
    { port: 587, success: true, mode: 'STARTTLS ND08', type: '08' as const },
    { port: 465, success: true, mode: 'TLS' }, { port: 587, success: true, mode: 'STARTTLS' },
    { port: 587, success: false, mode: 'sin STARTTLS' }, { port: 465, success: false, mode: 'sin AUTH' },
    { port: 465, success: false, mode: 'AUTH rechazado' }, { port: 465, success: false, mode: 'certificado no confiable' },
    { port: 465, success: false, mode: 'hostname incorrecto' }, { port: 465, success: false, mode: 'respuesta perdida' },
  ])('$mode en $port mantiene TLS/AUTH obligatorio y resultado sin entrega inventada', async scenario => {
    const commands: string[] = [], messages: string[] = [], sockets = new Set<Socket>();
    let authenticated = false, authEncrypted = true;
    const context = createSecureContext({ key: pki.server.key, cert: pki.server.cert, minVersion: 'TLSv1.2' });
    const track = (socket: Socket) => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); };
    const session = (socket: Socket, greet = true) => {
      track(socket); let pending = '', login = 0, dataMode = false, message = '';
      if (greet) socket.write('220 synthetic SMTP\r\n');
      const data = (bytes: Buffer) => {
        pending += bytes.toString('utf8'); let end: number;
        while ((end = pending.indexOf('\r\n')) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 2);
          if (dataMode) {
            if (line === '.') {
              messages.push(message); dataMode = false;
              if (scenario.mode === 'respuesta perdida') socket.destroy(); else socket.write('250 2.0.0 queued\r\n');
            } else message += line + '\r\n';
            continue;
          }
          if (login) {
            authEncrypted = authEncrypted && Boolean((socket as TLSSocket).encrypted);
            if (login++ === 1) socket.write('334 UGFzc3dvcmQ6\r\n');
            else { login = 0; authenticated = true; socket.write('235 authenticated\r\n'); }
            continue;
          }
          commands.push(line.split(' ')[0]); // No credential payloads or addresses are recorded as command logs.
          if (line.startsWith('EHLO ')) socket.write('250-synthetic\r\n' +
            (!(socket as TLSSocket).encrypted && scenario.mode !== 'sin STARTTLS' ? '250-STARTTLS\r\n' : '') +
            (scenario.mode !== 'sin AUTH' ? '250-AUTH LOGIN PLAIN\r\n' : '') + '250 OK\r\n');
          else if (line === 'STARTTLS') {
            if (scenario.mode === 'sin STARTTLS') { socket.write('500 not supported\r\n'); continue; }
            socket.write('220 upgrade TLS\r\n'); socket.removeListener('data', data);
            session(new TLSSocket(socket, { isServer: true, secureContext: context }), false); return;
          } else if (line.startsWith('AUTH')) {
            authEncrypted = authEncrypted && Boolean((socket as TLSSocket).encrypted);
            if (scenario.mode === 'sin AUTH' || scenario.mode === 'AUTH rechazado') socket.write('535 authentication denied\r\n');
            else if (line.startsWith('AUTH LOGIN')) { login = 1; socket.write('334 VXNlcm5hbWU6\r\n'); }
            else { authenticated = true; socket.write('235 authenticated\r\n'); }
          } else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) socket.write(authenticated ? '250 OK\r\n' : '530 auth required\r\n');
          else if (line === 'DATA' && authenticated) { dataMode = true; message = ''; socket.write('354 end with dot\r\n'); }
          else if (line === 'QUIT') socket.end('221 bye\r\n'); else socket.write('500 unsupported\r\n');
        }
      }; socket.on('data', data);
    };
    const server = scenario.port === 465 ? tlsServer({ key: pki.server.key, cert: pki.server.cert }, socket => session(socket)) : netServer(socket => session(socket));
    server.on('connection', track); server.on('tlsClientError', () => {});
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try {
      const port = (server.address() as { port: number }).port;
      const smtp = new CorporateDocumentSmtp({ resolve: async () => ['8.8.8.8'], connect: options => {
        expect(options).toMatchObject({ host: '8.8.8.8', port: scenario.port, family: 4 });
        return connect({ ...options, host: '127.0.0.1', port }); // Redirect only the test port to loopback.
      }, createTransport: options => {
        expect(options.tls).toMatchObject({ servername: 'smtp.corporativo.pe', rejectUnauthorized: true });
        return createTransport({ ...options, tls: { ...options.tls,
          servername: scenario.mode === 'hostname incorrecto' ? 'smtp.corporativo.pe' : '127.0.0.1',
          ...(scenario.mode === 'certificado no confiable' ? {} : { ca: pki.ca }) } });
      } });
      const config = { host: 'smtp.corporativo.pe', port: scenario.port as 465 | 587, tlsMode: (scenario.port === 465 ? 'TLS' : 'STARTTLS') as 'TLS' | 'STARTTLS',
        fromName: 'Synthetic Sender', fromAddress: 'sender@example.invalid', replyTo: null, username: 'synthetic-user', password: 'synthetic-password' };
      const current = vi.fn().mockResolvedValue(undefined), submitting = vi.fn().mockResolvedValue(undefined);
      const fixture = documentSourceFixture(scenario.type ?? '01');
      const prepared = await fixture.source.prepare(documentIssuer, fixture.id, 'a4', documentAuthorization);
      const result = smtp.send(config, 'recipient@example.invalid', randomUUID(), prepared, current, submitting);
      if (scenario.success) {
        await expect(result).resolves.toEqual({ handedOffToSmtp: true, deliveredToClient: false });
        expect(authenticated).toBe(true); expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('sender@example.invalid'); expect(messages[0]).toContain('recipient@example.invalid');
        expect(messages[0]).not.toMatch(/synthetic-password|synthetic-user/i);
        expect(messages[0].match(/Content-Disposition: attachment/gi)).toHaveLength(5);
        for (const attachment of prepared.attachments) expect(messages[0].replaceAll('\r\n', '')).toContain(attachment.content.toString('base64'));
        expect(commands).toContain('MAIL'); expect(commands).toContain('RCPT'); expect(commands).toContain('DATA');
      } else {
        await expect(result).rejects.toMatchObject({ status: 503 });
        expect(messages).toHaveLength(scenario.mode === 'respuesta perdida' ? 1 : 0);
      }
      expect(authEncrypted).toBe(true); expect(submitting).toHaveBeenCalledOnce();
      if (scenario.mode === 'STARTTLS') expect(commands).toContain('STARTTLS');
      if (scenario.mode === 'sin STARTTLS' || scenario.mode.includes('certificado') || scenario.mode.includes('hostname')) expect(commands).not.toContain('AUTH');
      if (!scenario.success && scenario.mode !== 'respuesta perdida') expect(commands).not.toContain('MAIL');
    } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 20000);
});
