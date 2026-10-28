"""Read-only inspection of user-supplied PDF models. No fiscal import."""
import json
from pathlib import Path
import pdfplumber

ROOT = Path(r'C:\Users\maxmo\Downloads\documentos\documentos')
NAMES = [
    '20175642341-01-F179-00034256-factura.pdf',
    '20175642341-03-B032-01053134-boleta con dni.pdf',
    '20175642341-07-F300-00002035-NC factura.pdf',
    '20175642341-07-B073-00000591-NC boleta.pdf',
    '20175642341-08-F300-00000217-ND factura.pdf',
    '20175642341-09-T204-00000606 GR.pdf',
    '20175642341-31-V250-00001973 GT.pdf',
]
for name in NAMES:
    with pdfplumber.open(ROOT / name) as pdf:
        print(json.dumps({'file': name, 'pages': len(pdf.pages)}, ensure_ascii=False))
        for page in pdf.pages:
            print(json.dumps({'page': page.page_number, 'size': [page.width, page.height],
                'fonts': sorted(set((c['fontname'], round(c['size'], 2)) for c in page.chars)),
                'images': [[round(i[k], 1) for k in ['x0', 'top', 'width', 'height']] for i in page.images],
                'rects': [[round(i[k], 1) for k in ['x0', 'top', 'width', 'height']] for i in page.rects],
                'lineCount': len(page.lines),
            }, ensure_ascii=False))
            for line in page.extract_text_lines(layout=False):
                print(f"{line['x0']:.1f},{line['top']:.1f} {line['text']}")
