/** Phase 8. Metadata-only Windows/Desktop check; never installs, starts or activates. */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const systemScript = "$ErrorActionPreference='Stop'; $taskOs=Get-CimInstance Win32_OperatingSystem; $taskComputer=Get-CimInstance Win32_ComputerSystem; $taskCpu=@(Get-CimInstance Win32_Processor); [ordered]@{build=[int]$taskOs.BuildNumber; productType=[int]$taskOs.ProductType; is64Bit=[Environment]::Is64BitOperatingSystem; ramBytes=[double]$taskComputer.TotalPhysicalMemory; processors=[int]$taskComputer.NumberOfLogicalProcessors; hypervisorPresent=[bool]$taskComputer.HypervisorPresent; virtualizationFirmware=(@($taskCpu | Where-Object {$_.VirtualizationFirmwareEnabled -eq $true}).Count -eq $taskCpu.Count -and $taskCpu.Count -gt 0); slat=(@($taskCpu | Where-Object {$_.SecondLevelAddressTranslationExtensions -eq $true}).Count -eq $taskCpu.Count -and $taskCpu.Count -gt 0)} | ConvertTo-Json -Compress";
export const windowsProbes = Object.freeze({
  system: { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', systemScript] },
  wsl: { file: 'wsl.exe', args: ['--version'] },
  context: { file: 'docker.exe', args: ['context', 'inspect', 'desktop-linux', '--format', '{{(index .Endpoints "docker").Host}}'] },
  engine: { file: 'docker.exe', args: ['--context', 'desktop-linux', 'version', '--format', '{"os":"{{.Server.Os}}","engineVersion":"{{.Server.Version}}"}'] },
});
const blocked = code => { throw new Error(code); };
const version = value => typeof value === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:\.\d{1,4})?$/.test(value)
  ? value.split('.').map(Number) : null;
function atLeast(value, expected) {
  const v = version(value); if (!v) return false;
  for (let n = 0; n < expected.length; n++) { if (v[n] > expected[n]) return true; if (v[n] < expected[n]) return false; }
  return true;
}
export function decodeProbe(input) {
  if (!(typeof input === 'string' || Buffer.isBuffer(input)) || input.length > 16384) blocked('WINDOWS_PROBE_INVALID');
  // WSL emits UTF-16LE on some installations, PowerShell/Docker normally UTF-8.
  const text = Buffer.isBuffer(input) ? input.toString(input.includes(0) ? 'utf16le' : 'utf8') : input;
  return text.replace(/^\uFEFF/, '').trim();
}
export function assessWindows(snapshot) {
  const s = snapshot.system;
  if (!s || typeof s !== 'object' || Array.isArray(s) ||
      Object.keys(s).sort().join(',') !== ['build', 'productType', 'is64Bit', 'ramBytes', 'processors', 'hypervisorPresent', 'virtualizationFirmware', 'slat'].sort().join(',') ||
      !Number.isSafeInteger(s.build) || s.build < 1 || s.build > 999999 || ![1, 2, 3].includes(s.productType) ||
      !Number.isFinite(s.ramBytes) || s.ramBytes < 0 || s.ramBytes > 64 * 1024 ** 4 ||
      !Number.isSafeInteger(s.processors) || s.processors < 1 || s.processors > 4096 ||
      ['is64Bit', 'hypervisorPresent', 'virtualizationFirmware', 'slat'].some(k => typeof s[k] !== 'boolean')) blocked('WINDOWS_METADATA_INVALID');
  const checks = [], check = (code, passed) => checks.push({ code, passed: passed === true });
  const family = s.productType !== 1 ? 'WINDOWS_SERVER' : s.build >= 22000 ? 'WINDOWS_11' : s.build >= 10240 ? 'WINDOWS_10' : 'OTHER_WINDOWS';
  check('WINDOWS_DESKTOP_ONLY', s.productType === 1);
  check('WINDOWS_BUILD_MINIMUM', family === 'WINDOWS_11' && s.build >= 22631 || family === 'WINDOWS_10' && s.build >= 19045);
  // Minimum build is not lifecycle/edition/license approval. Do not assume
  // extended Windows 10 support; TI must also review every Windows 11 edition.
  if (family === 'WINDOWS_10') check('WINDOWS_10_SUPPORT_REVIEW', false);
  check('X64_RUNTIME', s.is64Bit && snapshot.architecture === 'x64');
  check('NODE_RUNTIME', atLeast(snapshot.nodeVersion, [22, 18, 0]));
  check('RAM_MINIMUM_8_GIB', s.ramBytes >= 8 * 1024 ** 3);
  check('HARDWARE_VIRTUALIZATION', s.hypervisorPresent || s.virtualizationFirmware && s.slat);
  check('WSL_VERSION_MINIMUM', atLeast(snapshot.wslVersion, [2, 1, 5]));
  check('LOCAL_DESKTOP_LINUX_CONTEXT', snapshot.localDesktopContext === true);
  check('LINUX_ENGINE_RESPONDS', snapshot.localDesktopContext === true && snapshot.engine?.os === 'linux' && version(snapshot.engine?.engineVersion) !== null);
  const pending = ['WINDOWS_SERVICING_AND_DOCKER_LICENSE_REVIEW', 'DESKTOP_WSL2_BACKEND_CONFIRMATION', 'WINDOWS_PRIVATE_NETWORK_REHEARSAL', 'TI_VPN_DNS_FIREWALL_APPROVAL',
    'APPLICATION_PEERS_AND_CLIENT_GRANTS', 'AUTHORIZED_DATA_AND_RECOVERY_PILOT'];
  if (family === 'WINDOWS_10') pending.unshift('WINDOWS_10_SERVICING_AND_DOCKER_SUPPORT_REVIEW');
  return { schemaVersion: 'factuez.windows-readiness.v1', environment: 'BETA', automaticActivation: false,
    status: checks.every(c => c.passed) ? 'HOST_CHECKS_PASSED_PILOT_PENDING' : 'HOST_PREREQUISITES_INCOMPLETE',
    host: { family, build: s.build, architecture: snapshot.architecture === 'x64' ? 'x64' : 'UNSUPPORTED',
      ramGiB: Math.round(s.ramBytes / 1024 ** 3 * 10) / 10, logicalProcessors: s.processors },
    versions: { wsl: version(snapshot.wslVersion) ? snapshot.wslVersion : null,
      engine: snapshot.localDesktopContext === true && version(snapshot.engine?.engineVersion) ? snapshot.engine.engineVersion : null },
    checks, pending };
}
function probe(definition) {
  return execFileSync(definition.file, definition.args, { windowsHide: true, timeout: 5000,
    maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'] });
}
export async function inspectWindows(injected = {}) {
  const io = { platform: () => process.platform, architecture: () => process.arch, nodeVersion: () => process.versions.node, probe, ...injected };
  if (io.platform() !== 'win32') blocked('WINDOWS_DESKTOP_HOST_REQUIRED');
  let system;
  try { system = JSON.parse(decodeProbe(await io.probe(windowsProbes.system))); }
  catch { blocked('WINDOWS_METADATA_UNAVAILABLE'); }
  let wslVersion = null, engine = null, localDesktopContext = false;
  try {
    const firstLine = decodeProbe(await io.probe(windowsProbes.wsl)).split(/\r?\n/).find(line => line.trim());
    wslVersion = /^\D{0,100}(\d{1,4}\.\d{1,4}\.\d{1,4}(?:\.\d{1,4})?)(?:\s|$)/.exec(firstLine ?? '')?.[1] ?? null;
  } catch { /* Missing tool is reported as an incomplete prerequisite, not installed. */ }
  try {
    const endpoint = decodeProbe(await io.probe(windowsProbes.context));
    // Never contact a remote context or honor an arbitrary DOCKER_HOST. No endpoint is returned.
    localDesktopContext = endpoint === 'npipe:////./pipe/dockerDesktopLinuxEngine';
    if (localDesktopContext) engine = JSON.parse(decodeProbe(await io.probe(windowsProbes.engine)));
  } catch { /* No Docker start, context switch, registry modification or network access. */ }
  return assessWindows({ system, wslVersion, localDesktopContext, engine, architecture: io.architecture(), nodeVersion: io.nodeVersion() });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--read-only') blocked('INVALID_WINDOWS_CHECK_INVOCATION');
    const report = await inspectWindows(); process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (report.status !== 'HOST_CHECKS_PASSED_PILOT_PENDING') process.exitCode = 2;
  } catch (error) {
    const allowed = ['WINDOWS_DESKTOP_HOST_REQUIRED', 'WINDOWS_METADATA_UNAVAILABLE', 'WINDOWS_METADATA_INVALID'];
    process.stderr.write(JSON.stringify({ status: 'BLOCKED_NOT_ACTIVATED', automaticActivation: false,
      code: allowed.includes(error.message) ? error.message : 'WINDOWS_READINESS_FAILED' }) + '\n'); process.exitCode = 1;
  }
}
