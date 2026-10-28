"""PDF de notas/GRE QA: lectura independiente, nunca impresión ni cambios fiscales."""
import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from pypdf import PdfReader
import pdfplumber

root = Path('tmp/pdfs/stage2-prepared')
proof = json.loads(Path('tmp/stage2-prepared/proof.json').read_text(encoding='utf-8'))
if '--decode-qr' in sys.argv:
    sys.path.insert(0, str(Path('tmp/circuit-qa/python').resolve()))
    import zxingcpp

for kind, evidence in [(f'nota-{n["type"]}', n) for n in proof['notes']] + [('guia', proof['guide'])]:
    for format in ['ticket', 'a4']:
        path = root / f'{kind}-{format}.pdf'
        reader = PdfReader(path)
        assert len(reader.pages) == 1, (kind, format, 'Operación corta debe ocupar una página')
        page = reader.pages[0]
        width = 80 * 72 / 25.4 if format == 'ticket' else 595.28
        assert abs(float(page.mediabox.width) - width) < 0.01
        with pdfplumber.open(path) as pdf:
            text = ' '.join(' '.join(p.extract_text() or '' for p in pdf.pages).split())
            for required in [proof['ruc'], 'SIN VALIDEZ TRIBUTARIA', 'Desarrollado e implementado por www.mavrictec.com']:
                assert required in text, (kind, format, required)
            assert 'Max Garcia' not in text and 'Colaboración' not in text
            assert evidence['digestValue'] in ''.join(text.split()), (kind, format, 'Digest distinto al XML verificado')
            sizes = [image['srcsize'] for p in pdf.pages for image in p.images]
            for required in [(1200, 800), (1200, 380), (1254, 1254), (400, 400)]:
                assert required in sizes, (kind, format, 'Logo/QR ausente', required)
            for p in pdf.pages:
                assert all(c['x0'] >= 0 and c['x1'] <= p.width + .01 and c['top'] >= 0 and c['bottom'] <= p.height + .01 for c in p.chars), (kind, format, 'Texto fuera del papel')
        assert 'Max Garcia' not in str(reader.metadata)
        if kind.startswith('nota'):
            assert ('NOTA DE CRÉDITO' if evidence['type'] == '07' else 'NOTA DE DÉBITO') in text
            assert 'Comprobante afectado: 01' in text and 'FQ01-1' in text
            assert evidence['totals']['payableAmount'] in text
            series, number = evidence['fullNumber'].split('-')
            day = datetime.fromisoformat(evidence['issueDate'].replace('Z', '+00:00')).astimezone(timezone(timedelta(hours=-5))).strftime('%Y-%m-%d')
            expected = '|'.join([proof['ruc'], evidence['type'], series, number, evidence['totals']['igvAmount'], evidence['totals']['payableAmount'], day, evidence['customer']['identityType'], evidence['customer']['identityNumber'], evidence['digestValue']]) + '|'
        else:
            assert 'NO AUTORIZA TRASLADO' in text and 'ORIGEN' in text and 'DESTINO' in text and 'Peso bruto 25.125 KGM' in text
            assert 'TOTAL PEN' not in text and 'Base de ítems sin IGV' not in text
            expected = f'FACTUEZ-GRE-QA|{proof["ruc"]}|{evidence["number"]}|{evidence["digestValue"]}|NO-AUTORIZA-TRASLADO'
        if '--decode-qr' in sys.argv:
            qrs = [i.image.convert('RGB') for i in page.images if i.image.size == (400, 400)]
            assert len(qrs) == 1
            decoded = zxingcpp.read_barcodes(qrs[0])
            assert len(decoded) == 1 and decoded[0].text == expected, (kind, format, 'QR distinto a XML/importes')
        print(f'OK {kind} {format}: página, contenido, tres logos, límites y digest/QR')
