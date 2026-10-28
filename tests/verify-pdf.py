"""QA sobre PDFs ficticios generados por el renderer real; no escribe archivos."""
from pathlib import Path
from pypdf import PdfReader
import pdfplumber
import sys

files = list(Path("output/pdf").glob("boleta-*-PRUEBA.pdf")) + list(Path("tmp/pdfs/long").glob("boleta-*-PRUEBA.pdf"))
assert len(files) == 4, "Genere los casos normal y --long"
for path in files:
    reader = PdfReader(path)
    text = "\n".join(page.extract_text() for page in reader.pages)
    normalized = " ".join(text.split())
    for expected in ["DOCUMENTO LOCAL DE PRUEBA", "SIN VALIDEZ TRIBUTARIA", "RUC 00000000000", "B001-1", "Desarrollado e implementado por www.mavrictec.com", "diésel"]:
        assert expected in normalized, (str(path), expected)
    assert "Max Garcia" not in normalized and "Colaboración" not in normalized
    assert "Max Garcia" not in str(reader.metadata), "Nombre personal en metadatos"
    assert "\x00" not in text, "Glifos ausentes"
    assert "www.mavrictec.com" in reader.pages[-1].extract_text(), "Crédito debe estar al final"
    with pdfplumber.open(path) as pdf:
        assert any(i["srcsize"] == (1254, 1254) for i in pdf.pages[-1].images), "Falta el logo Mavric encima del crédito"
        assert any(i["srcsize"] == (1200, 380) for i in pdf.pages[-1].images), "Falta FactuEz al costado de Mavric"
        brands = [i for i in pdf.pages[-1].images if i["srcsize"] in [(1254, 1254), (1200, 380)]]
        assert len(brands) == 2 and brands[0]["x0"] < brands[1]["x0"], "Orden FactuEz/Mavric incorrecto"
        assert any(i["srcsize"] == (1200, 800) for i in pdf.pages[0].images), "Falta el logo San José en la cabecera"
        if len(pdf.pages) == 1:
            assert len(pdf.pages[0].images) >= 3, "Faltan los tres logos"
    if "ticket" in path.name:
        assert len(reader.pages) == 1
        assert abs(float(reader.pages[0].mediabox.width) - 80 * 72 / 25.4) < 0.01
    else:
        assert abs(float(reader.pages[0].mediabox.width) - 595.28) < 0.01
    if "long" in path.parts:
        assert "100." in text, "Falta el último ítem"
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            assert all(c["x0"] >= 0 and c["x1"] <= page.width + 0.01 and c["top"] >= 0 and c["bottom"] <= page.height + 0.01 for c in page.chars), "Texto fuera del papel"
    print(f"OK {path}: {len(reader.pages)} página(s), créditos, texto y medidas verificados")

if "--e2e" in sys.argv:
    for document_type, title in [("SALES_RECEIPT", "BOLETA DE VENTA"), ("INVOICE", "FACTURA")]:
        for print_format in ["ticket", "a4"]:
            path = Path(f"tmp/pdfs/e2e/{document_type}-{print_format}.pdf")
            reader = PdfReader(path)
            text = " ".join(" ".join(p.extract_text() for p in reader.pages).split())
            for expected in [title, "DOCUMENTO LOCAL DE PRUEBA", "SIN VALIDEZ TRIBUTARIA", "CLIENTE QA - SIN USO FISCAL", "46.25", "Desarrollado e implementado por www.mavrictec.com"]:
                assert expected in text, (str(path), expected)
            assert "Max Garcia" not in text and "Colaboración" not in text
            assert "Max Garcia" not in str(reader.metadata)
            expected_width = 80 * 72 / 25.4 if print_format == "ticket" else 595.28
            assert abs(float(reader.pages[0].mediabox.width) - expected_width) < 0.01
            with pdfplumber.open(path) as pdf:
                assert any(i["srcsize"] == (1200, 800) for i in pdf.pages[0].images), "Falta San José en PDF descargado por Kong"
                assert any(i["srcsize"] == (1254, 1254) for i in pdf.pages[-1].images), "Falta Mavric en PDF descargado por Kong"
                assert any(i["srcsize"] == (1200, 380) for i in pdf.pages[-1].images), "Falta FactuEz en PDF descargado por Kong"
                for page in pdf.pages:
                    assert all(c["x0"] >= 0 and c["x1"] <= page.width + 0.01 and c["top"] >= 0 and c["bottom"] <= page.height + 0.01 for c in page.chars), "Texto fuera del papel"
            print(f"OK E2E {document_type}/{print_format}: tres logos, crédito sin nombre, importe y medidas verificados")
