"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_PRINT_BRANDING = exports.PRINT_DOCUMENT_LABELS = exports.PRINT_TEMPLATE = exports.PRINT_SETTINGS_VERSION = exports.PRINT_PRESENTATION_VERSION = void 0;
/** Presentación, no autoridad fiscal. No contiene credenciales ni modifica UBL. */
exports.PRINT_PRESENTATION_VERSION = 'factuez.print-presentation.v1';
exports.PRINT_SETTINGS_VERSION = 'factuez.print-settings.v1';
exports.PRINT_TEMPLATE = 'SAN_JOSE_V1';
exports.PRINT_DOCUMENT_LABELS = {
    '01': 'Factura electrónica', '03': 'Boleta de venta electrónica',
    '07': 'Nota de crédito electrónica', '08': 'Nota de débito electrónica',
    '09': 'Guía de remisión remitente', '31': 'Guía de remisión transportista',
};
exports.DEFAULT_PRINT_BRANDING = {
    template: exports.PRINT_TEMPLATE, logoMode: 'DEFAULT', logoWidthMm: 40,
    logoAlignment: 'LEFT', showBranchAddress: true, footerNote: '',
};
//# sourceMappingURL=print-presentation.js.map