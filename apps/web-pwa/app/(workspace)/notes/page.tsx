"use client";
import {PageHeading} from '../../../features/workspace/common';
import {DocumentPicker} from '../../../features/workspace/document-picker';
import {useWorkspace} from '../../../features/workspace/provider';
import Link from 'next/link';
import {Button} from '@factuez/ui/components/button';
export default function NotesPage(){
 const {catalog,companyId}=useWorkspace(),company=catalog?.companies.find(c=>String(c.id)===companyId),production=company?.environment==='PRODUCTION';
 return <><PageHeading eyebrow="Documentos" title="Notas de crédito y débito" description={production?'Seleccione una factura propia aceptada para registrar una nota vinculada. La autorización fiscal y las series se comprueban en el servidor.':'Seleccione el original de prueba para preparar una nota de laboratorio.'}/>{production?<div className="rounded-xl border bg-card p-6"><p className="mb-4 text-sm">Abra la factura original en Comprobantes emitidos. Su detalle muestra las notas disponibles según su permiso y el estado SUNAT.</p><Button asChild><Link href="/documents">Consultar facturas emitidas</Link></Button></div>:<DocumentPicker/>}</>;
}
