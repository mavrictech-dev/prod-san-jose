/** Metadata check / explicit command plan only. Never runs Compose or installs tasks. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWindowsBundle } from './windows-edge.mjs';
import { inspectWindows } from './windows-readiness.mjs';
export function windowsOperationPlan(bundle, action) {
  if (!['START', 'STOP'].includes(action)) throw new Error('WINDOWS_OPERATION_INVALID');
  checkWindowsBundle(bundle);
  const args = ['--context', 'desktop-linux', 'compose', '--project-name', 'factuez-private-edge-windows-beta',
    '--env-file', resolve(bundle, 'empty.env'), '-f', resolve(bundle, 'compose.yml'), '--profile', 'private-edge-beta'];
  return { status: 'PLAN_ONLY_NOT_EXECUTED', environment: 'BETA', automaticActivation: false,
    command: { file: 'docker.exe', args: [...args, ...(action === 'START' ? ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'kong-private'] : ['stop', 'kong-private'])] },
    requires: ['TI_NETWORK_TLS_AND_CLIENT_APPROVAL', 'REVIEWED_KONG_DIGEST_AND_BUNDLE_ENV', 'DESKTOP_HOST_NETWORKING_PRE_ENABLED',
      'EXISTING_PREPARED_HTTPS_LOOPBACK_OWNERS', 'NATIVE_RELAY_MANUAL_START'],
    changesIntranet: false, deletesData: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 5 || process.argv[2] !== '--bundle' || !['--check', '--plan-start', '--plan-stop'].includes(process.argv[4])) throw new Error('INVALID');
    checkWindowsBundle(process.argv[3]);
    if (process.argv[4] === '--check') {
      const report = await inspectWindows(); process.stdout.write(JSON.stringify({ ...report, bundle: 'EXACT_RENDER_VERIFIED',
        tlsAndFirewall: 'NOT_CHECKED', autostart: 'NOT_INSTALLED' }, null, 2) + '\n');
      if (report.status !== 'HOST_CHECKS_PASSED_PILOT_PENDING') process.exitCode = 2;
    } else process.stdout.write(JSON.stringify(windowsOperationPlan(process.argv[3], process.argv[4] === '--plan-start' ? 'START' : 'STOP'), null, 2) + '\n');
  } catch { process.stderr.write('WINDOWS_OPERATION_BLOCKED_NOT_ACTIVATED\n'); process.exitCode = 1; }
}
