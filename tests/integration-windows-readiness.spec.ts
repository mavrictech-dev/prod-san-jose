import { describe, expect, it, vi } from 'vitest';
// JavaScript deployment tools intentionally have no runtime dependency on the application.
import { assessWindows, decodeProbe, inspectWindows, windowsProbes } from '../infra/integration/windows-readiness.mjs';
const snapshot = () => ({ system: { build: 22631, productType: 1, is64Bit: true, ramBytes: 16 * 1024 ** 3,
  processors: 8, hypervisorPresent: true, virtualizationFirmware: false, slat: false },
  architecture: 'x64', nodeVersion: '24.16.0', wslVersion: '2.6.1.0', localDesktopContext: true,
  engine: { os: 'linux', engineVersion: '28.5.0' } });
const io = (overrides: any = {}) => ({ platform: () => 'win32', architecture: () => 'x64', nodeVersion: () => '24.16.0',
  probe: vi.fn(async (p: any) => {
    if (p === windowsProbes.system) return JSON.stringify(snapshot().system);
    if (p === windowsProbes.wsl) return Buffer.from('Versión de WSL: 2.6.1.0\r\nVersión de kernel: 6.6.0', 'utf16le');
    if (p === windowsProbes.context) return 'npipe:////./pipe/dockerDesktopLinuxEngine';
    if (p === windowsProbes.engine) return JSON.stringify(snapshot().engine);
    throw new Error('Unexpected probe');
  }), ...overrides });
describe('Phase8 Windows 10/11 metadata qualification, never an installer or activation', () => {
  it('recognizes Windows 11 without claiming network/backend or activation approval', () => {
    const r = assessWindows(snapshot()); expect(r.status).toBe('HOST_CHECKS_PASSED_PILOT_PENDING');
    expect(r.environment).toBe('BETA'); expect(r.automaticActivation).toBe(false);
    expect(r.pending).toContain('WINDOWS_PRIVATE_NETWORK_REHEARSAL'); expect(r.pending).toContain('DESKTOP_WSL2_BACKEND_CONFIRMATION');
    expect(r.pending).toContain('WINDOWS_SERVICING_AND_DOCKER_LICENSE_REVIEW');
  });
  it('does not confuse Windows 11 with a misleading Windows 10 registry product name', () => {
    expect(assessWindows(snapshot()).host.family).toBe('WINDOWS_11');
  });
  it.each([19045, 19046])('requires servicing/support review for Windows 10 build %i', build => {
    const s = snapshot(); s.system.build = build; const r = assessWindows(s);
    expect(r.host.family).toBe('WINDOWS_10'); expect(r.status).toBe('HOST_PREREQUISITES_INCOMPLETE');
    expect(r.pending).toContain('WINDOWS_10_SERVICING_AND_DOCKER_SUPPORT_REVIEW');
  });
  it.each([2, 3])('does not call Windows Server productType %i desktop ready', productType => {
    const s = snapshot(); s.system.productType = productType;
    expect(assessWindows(s).host.family).toBe('WINDOWS_SERVER'); expect(assessWindows(s).status).toBe('HOST_PREREQUISITES_INCOMPLETE');
  });
  it.each([9600, 19044, 22000, 22621])('rejects older/insufficient host build %i', build => {
    const s = snapshot(); s.system.build = build;
    expect(assessWindows(s).checks.find((c: any) => c.code === 'WINDOWS_BUILD_MINIMUM')?.passed).toBe(false);
  });
  it.each(['arm64', 'ia32', 'unknown'])('does not pretend the x64 image closure supports %s', architecture => {
    const r = assessWindows({ ...snapshot(), architecture }); expect(r.status).toBe('HOST_PREREQUISITES_INCOMPLETE');
    expect(r.host.architecture).toBe('UNSUPPORTED');
  });
  it.each(['20.19.0', '22.17.9', '', 'latest', 'x'.repeat(500)])('rejects insufficient or untrusted Node version %s', nodeVersion => {
    expect(assessWindows({ ...snapshot(), nodeVersion }).checks.find((c: any) => c.code === 'NODE_RUNTIME')?.passed).toBe(false);
  });
  it.each(['2.1.4.0', '1.2.3', null, 'unknown'])('does not approve WSL prerequisite %s', wslVersion => {
    expect(assessWindows({ ...snapshot(), wslVersion }).checks.find((c: any) => c.code === 'WSL_VERSION_MINIMUM')?.passed).toBe(false);
  });
  it('checks RAM and virtualization without assuming a hypervisor detection proves available capacity', () => {
    const s = snapshot(); s.system.ramBytes = 7 * 1024 ** 3; s.system.hypervisorPresent = false;
    expect(assessWindows(s).checks.filter((c: any) => !c.passed).map((c: any) => c.code)).toEqual(['RAM_MINIMUM_8_GIB', 'HARDWARE_VIRTUALIZATION']);
    s.system.ramBytes = 8 * 1024 ** 3; s.system.virtualizationFirmware = s.system.slat = true;
    expect(assessWindows(s).status).toBe('HOST_CHECKS_PASSED_PILOT_PENDING');
  });
  it.each(['windows', 'darwin', null])('requires a Linux engine, not %s', os => {
    expect(assessWindows({ ...snapshot(), engine: { os, engineVersion: '28.5.0' } }).status).toBe('HOST_PREREQUISITES_INCOMPLETE');
  });
  it.each([{ ...snapshot().system, build: NaN }, { ...snapshot().system, ramBytes: -1 },
    { ...snapshot().system, processors: 0 }, { ...snapshot().system, productType: 4 },
    { ...snapshot().system, hypervisorPresent: 'true' }, { ...snapshot().system, password: 'not-allowed' }])('rejects malformed/extraneous system metadata', system => {
    expect(() => assessWindows({ ...snapshot(), system })).toThrow('WINDOWS_METADATA_INVALID');
  });
  it('decodes WSL UTF-16 and ordinary UTF-8 without requiring language-specific labels', async () => {
    const fake = io(); const r = await inspectWindows(fake);
    expect(r.versions.wsl).toBe('2.6.1.0'); expect(r.status).toBe('HOST_CHECKS_PASSED_PILOT_PENDING');
    expect(decodeProbe(Buffer.from('\uFEFFhello', 'utf16le'))).toBe('hello'); expect(decodeProbe(Buffer.from('hello'))).toBe('hello');
  });
  it('rejects unbounded probe data and never returns a raw tool failure', () => {
    expect(() => decodeProbe('x'.repeat(16385))).toThrow('WINDOWS_PROBE_INVALID');
    expect(() => decodeProbe({ password: 'fake' })).toThrow('WINDOWS_PROBE_INVALID');
  });
  it.each(['linux', 'darwin'])('does not probe a non-Windows host %s', async platform => {
    const fake = io({ platform: () => platform }); await expect(inspectWindows(fake)).rejects.toThrow('WINDOWS_DESKTOP_HOST_REQUIRED');
    expect(fake.probe).not.toHaveBeenCalled();
  });
  it('bounds failure to safe metadata code and omits hostnames/accounts/credentials', async () => {
    const fake = io({ probe: vi.fn(async () => { throw new Error('password-fake account-fake hostname-fake'); }) });
    await expect(inspectWindows(fake)).rejects.toThrow('WINDOWS_METADATA_UNAVAILABLE');
  });
  it.each(['tcp://secret-fake@remote.example:2376', 'ssh://user-fake@remote.example', 'npipe:////./pipe/docker_engine', ''])('never contacts unapproved Docker endpoint', async endpoint => {
    const fake = io(); const original = fake.probe.getMockImplementation()!;
    fake.probe.mockImplementation(async (p: any) => p === windowsProbes.context ? endpoint : original(p));
    const r = await inspectWindows(fake); expect(r.status).toBe('HOST_PREREQUISITES_INCOMPLETE');
    expect(fake.probe).not.toHaveBeenCalledWith(windowsProbes.engine); expect(JSON.stringify(r)).not.toContain(endpoint || 'secret-fake');
  });
  it('missing optional tools produces incomplete prerequisites without installing or restarting', async () => {
    const fake = io(); fake.probe.mockImplementation(async (p: any) => {
      if (p === windowsProbes.system) return JSON.stringify(snapshot().system); throw new Error('missing');
    });
    const r = await inspectWindows(fake); expect(r.versions).toEqual({ wsl: null, engine: null });
    expect(r.status).toBe('HOST_PREREQUISITES_INCOMPLETE'); expect(r.automaticActivation).toBe(false);
  });
  it('command inventory has no installs/distro launches/firewall/Docker mutations or credential reads', () => {
    expect(windowsProbes.wsl.args).toEqual(['--version']);
    expect(windowsProbes.engine.args.slice(0, 3)).toEqual(['--context', 'desktop-linux', 'version']);
    const all = JSON.stringify(windowsProbes); for (const action of ['--install', '--update', 'compose', ' run ', ' restart ', ' start ',
      'New-NetFirewall', 'Set-NetFirewall', 'portproxy', 'Get-Content', 'Username', 'ComputerName', 'SerialNumber']) expect(all).not.toContain(action);
  });
});
