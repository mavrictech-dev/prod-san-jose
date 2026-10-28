"""Rebuild the client request PDF; no application, database or fiscal access.

Generate a candidate under tmp/pdfs, inspect it, then publish the verified PDF
to the existing output/pdf path. This script never reads credentials or a backup.
"""
from argparse import ArgumentParser
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak


ROOT = Path(__file__).resolve().parents[1]
DEFAULT = ROOT / "tmp/pdfs/solicitud-etapas-2-3-20261003/solicitud-actualizada.pdf"
SUNAT_REFERENCE = "https://orientacion.sunat.gob.pe/12-pautas-servicio-beta"


def build(output: Path) -> None:
    output = output.resolve()
    output.relative_to((ROOT / "tmp/pdfs").resolve())
    if output.exists():
        raise ValueError("Candidate already exists; use a new candidate filename")
    output.parent.mkdir(parents=True, exist_ok=True)
    regular = Path("C:/Windows/Fonts/arial.ttf")
    bold = Path("C:/Windows/Fonts/arialbd.ttf")
    if regular.is_file() and bold.is_file():
        pdfmetrics.registerFont(TTFont("RequestArial", str(regular)))
        pdfmetrics.registerFont(TTFont("RequestArialBold", str(bold)))
        pdfmetrics.registerFontFamily("RequestArial", normal="RequestArial", bold="RequestArialBold")
        normal_font, bold_font = "RequestArial", "RequestArialBold"
    else:
        normal_font, bold_font = "Helvetica", "Helvetica-Bold"

    ink, muted, accent = colors.HexColor("#162332"), colors.HexColor("#566270"), colors.HexColor("#C91D30")
    styles = {
        "tag": ParagraphStyle("Tag", fontName=bold_font, fontSize=8.5, leading=11, textColor=accent, spaceAfter=7),
        "title": ParagraphStyle("Title", fontName=bold_font, fontSize=19, leading=23, textColor=ink, spaceAfter=10),
        "meta": ParagraphStyle("Meta", fontName=normal_font, fontSize=9.6, leading=13, textColor=ink, spaceAfter=3),
        "intro": ParagraphStyle("Intro", fontName=normal_font, fontSize=10, leading=13.6, textColor=ink, spaceAfter=9),
        "heading": ParagraphStyle("Heading", fontName=bold_font, fontSize=10.5, leading=13.4, textColor=ink, spaceBefore=8, spaceAfter=4, keepWithNext=True),
        "body": ParagraphStyle("Body", fontName=normal_font, fontSize=9.7, leading=13.3, textColor=ink, spaceAfter=3, alignment=TA_LEFT),
        "note": ParagraphStyle("Note", fontName=normal_font, fontSize=8.9, leading=12, textColor=muted, spaceBefore=9, spaceAfter=3),
    }
    story = []

    def add(text: str, style: str = "body") -> None:
        story.append(Paragraph(text, styles[style]))

    def section(title: str, text: str) -> None:
        add(title, "heading")
        add(text)

    add("FACTUEZ / ESTACIONES SAN JOSÉ", "tag")
    add("Solicitud de información - fases 2 y 3", "title")
    add("<b>Para:</b> Responsable de TI, para gestionar con Administración y Contabilidad", "meta")
    add("<b>De:</b> Equipo de desarrollo de Mavric Technologies", "meta")
    story.append(Spacer(1, 9))
    add("Solicitamos los datos y autorizaciones siguientes para validar la fase fiscal y preparar "
        "la migración del historial. Los ensayos serán exclusivamente en desarrollo y SUNAT Beta, "
        "previa aprobación del alcance concreto. <b>No se emitirá en producción ni se alterarán "
        "ventas o correlativos fiscales existentes.</b>", "intro")

    section("1. Datos de cada empresa",
        "RUC, razón social, nombre comercial, dirección fiscal y ubigeo; ficha RUC actualizada. "
        "Confirmar con Contabilidad la modalidad de emisión electrónica actual, el proveedor "
        "o sistema que utilizan y su contacto técnico, si corresponde.")
    section("2. Mapa confirmado de sedes, puntos y series",
        "Entregar una relación en Excel o CSV con <b>empresa/RUC - sede - punto de emisión - "
        "tipo de comprobante - serie</b>. Incluir dirección, ubigeo y código de establecimiento "
        "SUNAT de cada sede, propietario de cada serie y si está activa o retirada. "
        "La asignación de sedes a distintos RUC debe quedar confirmada; las series de prueba "
        "se definirán por separado, sin reutilizar ni modificar las vigentes.")
    section("3. Información pública del certificado",
        "Proveedor y contacto, vigencia y documentación pública de la cadena de certificación "
        "y revocación, si está disponible. Coordinaremos con el proveedor la verificación técnica. "
        "<b>El certificado privado y su contraseña los cargará su responsable directamente en "
        "la configuración segura cuando se acuerde; no enviarlos por correo o chat.</b>")
    section("4. Muestras originales autorizadas",
        "XML firmados y CDR originales de facturas, boletas o sus resúmenes, notas de crédito "
        "y débito, y bajas; ZIP y PDF asociados si están disponibles. Incluir ejemplos aceptados, "
        "observados y rechazados, si existen, y su estado en el sistema actual. La entrega será "
        "restringida porque pueden contener datos de clientes. Se usarán para comparar y validar; "
        "<b>no se reenviarán a SUNAT</b>. Si no pueden exportarlos, indicar el contacto del proveedor.")
    section("5. Coordinación del piloto y prueba en intranet",
        "Designar contactos de TI y Contabilidad y una fecha para probar desde una terminal. "
        "Indicar sistema operativo, navegador, modelo de impresora y formatos de papel usados. "
        "Antes de cualquier envío Beta se acordarán por escrito RUC, documentos, cantidades, "
        "series y fechas. <b>Entregar información no autoriza nuevos envíos.</b>")
    add("Para las pruebas actuales no solicitamos claves SOL privadas ni credenciales de producción. "
        "GRE y correo corporativo se coordinarán aparte; no bloquean las pruebas actuales de "
        "facturas, boletas y notas.", "note")
    add(f'Referencia de pruebas: <link href="{SUNAT_REFERENCE}" color="#566270"><u>SUNAT - Pautas del servicio Beta</u></link>.', "note")

    story.append(PageBreak())
    add("PREPARACIÓN DEL HISTORIAL / FASE 3", "tag")
    add("Copia, conciliación y autorización", "title")
    add("Ya se ensayó el adaptador con datos ficticios y una base nueva. <b>Eso no valida el "
        "historial real ni aprueba su importación o el corte.</b> Para avanzar con datos del "
        "negocio necesitamos lo siguiente.", "intro")

    section("6. Copia offline íntegra del historial",
        "Export completo del periodo autorizado o respaldo limitado a las tablas necesarias, "
        "con esquema/diccionario de campos del sistema actual. Debe conservar <b>cabeceras, "
        "clientes, ítems, impuestos, referencias de notas, estados, identificadores de origen "
        "y series/contadores sólo para lectura</b>, sin perder detalle. Adjuntar los XML/ZIP/CDR/PDF "
        "originales disponibles y un inventario de archivos, filas, origen y fecha de la copia. "
        "No incluir usuarios, contraseñas, certificados privados ni configuración de secretos. "
        "El proveedor puede facilitar el export; nuestro equipo verificará tamaños y huellas SHA-256.")
    section("7. Autorización de lectura, entrega y protección de datos",
        "TI debe autorizar por escrito los <b>RUC, periodo, datos y cantidad de filas/archivos "
        "incluidos</b>. Antes de leer la copia acordaremos ruta de origen, base y almacenamiento "
        "aislados de destino, responsables con acceso, canal restringido de entrega, uso permitido "
        "y plazos de conservación/eliminación. Trabajaremos sobre la copia, no sobre la base "
        "productiva. La autorización de lectura no permite emitir, reenviar, borrar o modificar ventas.")
    section("8. Reportes para conciliación con Contabilidad",
        "Reporte del sistema actual y/o de Contabilidad del mismo periodo, desglosado por "
        "<b>RUC, moneda, tipo y serie</b>: cantidad de documentos, mínimo/máximo, huecos, bases "
        "netas, IGV, otros impuestos, total pagable y estados. Identificar las notas vinculadas "
        "y explicar diferencias conocidas, duplicados o documentos sin CDR. Designar al "
        "responsable que resolverá y aprobará las diferencias. Coincidir en SHA-256 no acredita "
        "por sí solo aceptación de SUNAT.")
    section("9. Ensayo de restauración y permisos de consulta",
        "TI debe acordar la ventana y los recursos aislados para repetir respaldo/restauración "
        "sobre la copia autorizada, e indicar <b>qué cargos pueden consultar qué sedes, puntos "
        "y series</b>. Nuestro equipo realizará el ensayo y entregará evidencia de integridad, "
        "acceso autorizado e incidencias. No solicitamos que TI ejecute scripts de desarrollo "
        "ni que entregue acceso administrador a la base productiva.")
    section("10. Aprobación antes de un corte futuro",
        "Confirmar propietario y última numeración autorizada de cada serie. Tras la conciliación, "
        "TI, Administración y Contabilidad deberán aprobar un <b>acta de corte</b> con alcance, "
        "excepciones, responsables, ventana, bloqueo del emisor anterior y plan de reversión. "
        "<b>No se tocarán contadores ni propietarios sin aprobación; el máximo observado en "
        "el export no autoriza a iniciar numeración.</b> Hoy no hay corte aprobado ni ejecutado.")
    section("Trabajo a cargo de Mavric Technologies",
        "Nuestro equipo preparará el extractor y contrato de la copia autorizada, la API de "
        "consulta con autenticación, la verificación de XML/CDR y confianza, las pruebas de "
        "restauración y la conciliación técnica. También continuará los pendientes fiscales "
        "de fase 2. <b>El cliente entrega y autoriza los datos del negocio; nuestro equipo realiza "
        "la implementación. La entrega no equivale al cierre de ninguna fase.</b>")

    def footer(canvas, doc) -> None:
        canvas.saveState()
        width, _ = letter
        canvas.setStrokeColor(colors.HexColor("#DCE1E6"))
        canvas.setLineWidth(0.6)
        canvas.line(48, 44, width - 48, 44)
        canvas.setFont(normal_font, 8)
        canvas.setFillColor(muted)
        canvas.drawString(48, 30, "Mavric Technologies | FactuEz | Actualizada: 03/10/2026")
        canvas.drawRightString(width - 48, 30, f"Página {doc.page} de 2")
        canvas.restoreState()

    doc = SimpleDocTemplate(str(output), pagesize=letter, leftMargin=48, rightMargin=48,
        topMargin=44, bottomMargin=57, title="Solicitud de información - fases 2 y 3 - Estaciones San José",
        author="Mavric Technologies", subject="Datos y autorizaciones para pruebas Beta e historial aislado")
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    print(str(output))


if __name__ == "__main__":
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT)
    build(parser.parse_args().output)
