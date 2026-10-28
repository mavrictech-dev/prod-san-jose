"""Prepare the pinned public SUNAT XSD fixture offline for CI; never read business data."""
from pathlib import Path, PurePosixPath
from zipfile import ZipFile
from hashlib import sha256
import io, stat
root = Path(__file__).resolve().parents[1]
raw = (root / 'services/sunat-service/assets/sunat/xsd-20220228.zip').read_bytes()
if len(raw) != 609363 or sha256(raw).hexdigest() != '5cac9d9353521340fbc15d23f465a4946b004535b9ff411541c87da01694dbd5':
    raise ValueError('PINNED_XSD_REQUIRED')
target = root / 'tmp/sunat-schema/ubl21-browser'
if target.exists():
    raise ValueError('NEW_XSD_FIXTURE_TARGET_REQUIRED')
archive = ZipFile(io.BytesIO(raw))
entries = archive.infolist()
if len(entries) > 1024 or sum(e.file_size for e in entries) > 20 * 1024 * 1024:
    raise ValueError('XSD_ARCHIVE_LIMIT')
for e in entries:
    p = PurePosixPath(e.filename)
    if p.is_absolute() or '..' in p.parts or not p.parts or p.parts[0] != 'Archivos XSD' or '\\' in e.filename or stat.S_ISLNK(e.external_attr >> 16):
        raise ValueError('XSD_ENTRY_UNSAFE')
target.mkdir(parents=True)
for e in entries:
    p = target.joinpath(*PurePosixPath(e.filename).parts)
    if e.is_dir():
        p.mkdir(parents=True, exist_ok=True)
    elif p.suffix.lower() == '.xsd':
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open('xb') as f:
            f.write(archive.read(e))
print('OFFLINE_XSD_FIXTURE_READY')
