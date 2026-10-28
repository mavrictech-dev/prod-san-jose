"use client";

import { useParams } from 'next/navigation';
import { ReceivedDocuments } from '../../../../features/workspace/received-documents';

export default function ReceivedDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <ReceivedDocuments id={id} />;
}
