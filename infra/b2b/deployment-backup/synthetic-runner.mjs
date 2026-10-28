/** Fixed standalone opt-in runner; accepts no data, URL, path, target or key arguments. */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
if (process.argv.length !== 3 || process.argv[2] !== '--isolated-synthetic-only') {
  process.stderr.write('DEPLOYMENT_BACKUP_SYNTHETIC_OPT_IN_REQUIRED\n'); process.exitCode = 2;
} else {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url)),
    'run', '--config', 'infra/b2b/deployment-backup/vitest.config.mts'], {cwd: root, stdio: 'inherit', windowsHide: true, timeout: 120000});
  process.exitCode = result.status === 0 ? 0 : 1;
}
