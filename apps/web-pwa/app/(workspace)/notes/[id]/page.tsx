"use client";
import { useParams } from 'next/navigation';
import { NotesQaPanel } from '../../../../features/workspace/notes-qa';
import { PageHeading } from '../../../../features/workspace/common';
export default function NotePage(){const {id}=useParams<{id:string}>();return <><PageHeading eyebrow="Documentos · Desarrollo" title="Notas de crédito y débito" description="Ajustes locales vinculados a un comprobante ficticio aceptado por el emulador."/><NotesQaPanel originalDocumentId={id}/></>;}
