"""Export only the approved Compra02 fix, excluding the pre-existing local CRUD."""
import difflib
import hashlib
import json
import re
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[2]
out = root / 'output/gre-series-administration-lifecycle-20261127/t099'
files = [
    'packages/contracts/src/production-guides.ts',
    'packages/contracts/src/gre-administration.ts',
    'packages/sunat-core/src/production-guides-purchase.ts',
    'packages/sunat-core/src/production-guides.ts',
    'services/sunat-service/src/production-guides-administration.ts',
    'services/sunat-service/src/production-guides-catalogue.ts',
    'services/sunat-service/src/production-guides-pdf.ts',
    'apps/web-pwa/features/workspace/gre-series-admin.tsx',
    'apps/web-pwa/features/workspace/gre-transport-admin.tsx',
    'apps/web-pwa/features/workspace/gre-catalogue-admin.tsx',
    'apps/web-pwa/features/workspace/gre-administration-context.tsx',
    'apps/web-pwa/features/workspace/gre-administration-review.tsx',
    'apps/web-pwa/features/workspace/gre-hydrocarbon-review.tsx',
    'apps/web-pwa/features/workspace/production-guides.tsx',
    'tests/gre-administration.e2e.cjs',
    'tests/production-guides-purchase-address.spec.ts',
    'tests/production-guides-purchase-address-db.spec.ts',
    'tests/production-guides-purchase-address.browser.cjs',
    'tests/helpers/gre-purchase-source-evidence.py',
    'tests/helpers/gre-purchase-fix-manifest.py',
]
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root).decode().strip()
entries, patch = [], []
for file in files:
    raw = (root / file).read_bytes()
    text = raw.decode('utf-8').replace('\r\n', '\n')
    if file.endswith('/gre-series-admin.tsx'):
        # Keep the worker's unfinished panel in the worktree, never in this release.
        text = text.replace("import {GreSeriesAdministrationPanel} from './gre-series-administration';\n", '')
        text, count = re.subn(r'<GreSeriesAdministrationPanel key=\{companyId\+\':\'\+point\} companyId=\{companyId\}/>', '', text)
        assert count <= 1 and 'GreSeriesAdministrationPanel' not in text, 'Review the separate CRUD panel before exporting'
    publish = text.encode('utf-8')
    target = out / 'fix-source' / file
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(publish)
    original = subprocess.run(['git', 'show', f'{head}:{file}'], cwd=root, capture_output=True)
    old = original.stdout.decode('utf-8').replace('\r\n', '\n') if original.returncode == 0 else ''
    if original.returncode == 0:
        base = out / 'patch-check-base' / file
        base.parent.mkdir(parents=True, exist_ok=True)
        base.write_text(old, encoding='utf-8', newline='\n')
    assert old != text, f'No fix change in {file}'
    patch.append(f'diff --git a/{file} b/{file}\n')
    if original.returncode != 0:
        patch.append('new file mode 100644\n')
    patch.extend(difflib.unified_diff(old.splitlines(True), text.splitlines(True),
                                    fromfile=f'a/{file}' if original.returncode == 0 else '/dev/null',
                                    tofile=f'b/{file}'))
    entries.append({'path': file, 'newFile': original.returncode != 0,
                    'workingSha256': hashlib.sha256(raw).hexdigest(),
                    'publishSha256': hashlib.sha256(publish).hexdigest(),
                    'publishSource': str(target.relative_to(out)).replace('\\', '/'),
                    'baseSha256': hashlib.sha256(original.stdout).hexdigest() if original.returncode == 0 else None})
(out / 'fix-from-head.patch').write_text(''.join(patch), encoding='utf-8', newline='\n')
(out / 'source-manifest.json').write_text(json.dumps({
    'version': 'factuez.gre-purchase02-address-fix-source.v1', 'head': head,
    'scope': 'Compra09/private02/motivo02 only; no DDL or new permissions', 'files': entries,
    'excluded': ['series administration CRUD and its contracts/index export, Billing providers, journal and migrations',
                 'Diagnostico4, history diagnostic files and wrappers',
                 'api-contracts/PLAN_GESTION_CORRECCIONES_GRE_V1.md',
                 'client installation, credentials, grants or fiscal emissions'],
    'sharedFileTreatment': 'gre-series-admin.tsx export excludes the pre-existing local CRUD panel import/render; working file retains it',
}, indent=2), encoding='utf-8')
print(json.dumps({'files': len(entries), 'head': head, 'patch': str((out / 'fix-from-head.patch').relative_to(root))}))
