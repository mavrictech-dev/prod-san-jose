import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './application/auth.service';
import { BrowserSessionStore, SESSION_COOKIE, SESSION_COOKIE_PATH, SESSION_IDLE_MS, type BrowserSession } from './application/browser-session.store';

type BrowserRequest = { headers: Record<string, string | string[] | undefined> };
type BrowserResponse = { setHeader: (name: string, value: string) => void };

@Controller('api/v1/auth/browser-session')
export class BrowserSessionController {
  constructor(private readonly auth: AuthService, private readonly sessions: BrowserSessionStore) {}
  private secure() { return process.env.LOCAL_BROWSER_SESSION_QA_ENABLED !== 'true'; }
  private origin(request: BrowserRequest) {
    const origin = request.headers.origin;
    const allowed = (process.env.AUTH_BROWSER_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
    if (typeof origin !== 'string' || !allowed.includes(origin)) throw new ForbiddenException('Origen de sesión no autorizado');
    try {
      const url = new URL(origin);
      if (url.origin !== origin || (url.protocol !== 'https:' && (this.secure() || url.protocol !== 'http:'))) throw new Error();
    } catch { throw new ForbiddenException('Se requiere un origen de sesión seguro'); }
  }
  private cookie(request: BrowserRequest, optional = false) {
    const raw = request.headers.cookie;
    const values = typeof raw === 'string' ? raw.split(';').map(value => value.trim()).filter(value => value.startsWith(SESSION_COOKIE + '=')) : [];
    if (values.length === 0 && optional) return undefined;
    if (values.length !== 1) throw new UnauthorizedException('Inicie sesión para continuar');
    const cookie = values[0].slice(SESSION_COOKIE.length + 1); this.sessions.id(cookie); return cookie;
  }
  private headers(response: BrowserResponse) {
    response.setHeader('Cache-Control', 'no-store, private'); response.setHeader('Pragma', 'no-cache');
    response.setHeader('Vary', 'Cookie');
  }
  private setCookie(response: BrowserResponse, cookie: string, expiresAt: number) {
    const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${cookie}; Path=${SESSION_COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=${seconds}${this.secure() ? '; Secure' : ''}`);
  }
  private summary(session: BrowserSession) {
    return { idleExpiresAt: session.lastActivityAt + SESSION_IDLE_MS, idleTimeoutSeconds: SESSION_IDLE_MS / 1000, serverNow: Date.now() };
  }
  private async resolve(request: BrowserRequest) {
    const cookie = this.cookie(request)!; const id = this.sessions.id(cookie); const session = await this.sessions.get(id);
    await this.auth.assertActive({ sub: session.userId, authVersion: session.authVersion });
    return { cookie, id, session };
  }
  @Post('login') @HttpCode(200)
  async login(@Req() request: BrowserRequest, @Res({ passthrough: true }) response: BrowserResponse, @Body() body: { username: string; password: string }) {
    this.headers(response); this.origin(request);
    const result = await this.auth.login(body?.username, body?.password);
    const claims = this.auth.verifyAccessToken(result.accessToken);
    let previous: string | undefined;
    try { previous = this.cookie(request, true); } catch { /* A damaged old cookie must not prevent a new password login. */ }
    const created = await this.sessions.create(claims.sub, claims.authVersion);
    if (previous) await this.sessions.revoke(this.sessions.id(previous));
    const access = await this.auth.browserAccess(created.session.userId, created.session.authVersion, created.id);
    const user = this.auth.verifyAccessToken(access.accessToken);
    const summary = this.summary(created.session); this.setCookie(response, created.cookie, summary.idleExpiresAt);
    return { ...access, user, ...summary };
  }
  @Get() @HttpCode(200)
  async restore(@Req() request: BrowserRequest, @Res({ passthrough: true }) response: BrowserResponse) {
    this.headers(response);
    // Restaurar/renovar JWT NO actualiza lastActivityAt ni el TTL de Redis.
    const { session, id, cookie } = await this.resolve(request);
    const access = await this.auth.browserAccess(session.userId, session.authVersion, id);
    const summary = this.summary(session); this.setCookie(response, cookie, summary.idleExpiresAt);
    return { ...access, user: this.auth.verifyAccessToken(access.accessToken), ...summary };
  }
  @Post('activity') @HttpCode(200)
  async activity(@Req() request: BrowserRequest, @Res({ passthrough: true }) response: BrowserResponse) {
    this.headers(response); this.origin(request);
    const { id, cookie } = await this.resolve(request);
    const session = await this.sessions.touch(id);
    const summary = this.summary(session); this.setCookie(response, cookie, summary.idleExpiresAt);
    return summary;
  }
  @Post('logout') @HttpCode(200)
  async logout(@Req() request: BrowserRequest, @Res({ passthrough: true }) response: BrowserResponse) {
    this.headers(response); this.origin(request);
    const cookie = this.cookie(request, true);
    this.setCookie(response, '', 0);
    if (cookie) await this.sessions.revoke(this.sessions.id(cookie));
    return { loggedOut: true };
  }
}
