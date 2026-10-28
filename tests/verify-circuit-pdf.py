"""Revisión de PDFs descargados por Kong. Lectura, sin modificar los artefactos."""
from pathlib import Path
import json
from pypdf import PdfReader
import pdfplumber
import sys
from datetime import datetime, timezone, timedelta

proof = json.loads(Path('tmp/circuit-qa/proof.json').read_text(encoding='utf-8'))
for format in ['ticket', 'a4']:
    path = Path(f'output/pdf/circuito-{format}-SIMULADO.pdf')
    reader = PdfReader(path)
    # pypdf inserta espacios por kerning en «7 .06»; pdfplumber conserva cifras.
    with pdfplumber.open(path) as pdf_text:
        text = ' '.join(' '.join(p.extract_text() or '' for p in pdf_text.pages).split())
    for value in ['DOCUMENTO LOCAL DE PRUEBA', 'SIN VALIDEZ TRIBUTARIA', 'CDR NO OFICIAL', 'SIMULADO', proof['ruc'], '46.25', '7.06', '39.19', 'Desarrollado e implementado por www.mavrictec.com']:
        assert value in text, (format, value)
    # El digest base64 puede partirse en dos líneas en el papel de 80 mm.
    assert proof['digestValue'] in ''.join(text.split()), (format, 'Digest XML distinto')
    assert 'Max Garcia' not in text and 'Colaboración' not in text
    metadata = {key: str(value.get_object()) for key, value in reader.metadata.items()}
    assert 'Max Garcia' not in str(metadata)
    assert len(reader.pages) == 1
    width = 80 * 72 / 25.4 if format == 'ticket' else 595.28
    assert abs(float(reader.pages[0].mediabox.width) - width) < 0.01
    with pdfplumber.open(path) as pdf:
        sizes = [i['srcsize'] for p in pdf.pages for i in p.images]
        for size in [(1200, 800), (1200, 380), (1254, 1254), (400, 400)]:
            assert size in sizes, (format, 'Imagen ausente', size)
        for page in pdf.pages:
            assert all(c['x0'] >= 0 and c['x1'] <= page.width + .01 and c['top'] >= 0 and c['bottom'] <= page.height + .01 for c in page.chars), 'Texto fuera de papel'
    if '--decode-qr' in sys.argv:
        sys.path.insert(0, str(Path('tmp/circuit-qa/python').resolve()))
        import zxingcpp
        qr_images = [image.image.convert('RGB') for image in reader.pages[0].images if image.image.size == (400, 400)]
        assert len(qr_images) == 1, 'QR único requerido'
        codes = zxingcpp.read_barcodes(qr_images[0])
        assert len(codes) == 1, 'QR no legible'
        created = datetime.strptime(metadata['/CreationDate'][2:16], '%Y%m%d%H%M%S').replace(tzinfo=timezone.utc)
        day = created.astimezone(timezone(timedelta(hours=-5))).strftime('%Y-%m-%d')
        expected = '|'.join([proof['ruc'], '03', 'BQ01', '1', '7.06', '46.25', day, '0', '0', proof['digestValue']]) + '|'
        assert codes[0].text == expected, 'QR no coincide con XML/importes/documento'
        print(f'OK {format}: QR leído con decodificador independiente, 10 campos y digest exactos')
    print(f'OK {format}: logos, hash firmado, QR, importes, crédito y límites de página')
