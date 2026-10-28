"use client";
import {Button} from '@factuez/ui/components/button';
export default function ShadowLabError({reset}:{reset:()=>void}){return <div role="alert" className="space-y-4 rounded-lg border p-6"><h1 className="font-semibold">No se pudo cargar el laboratorio</h1><p className="text-sm text-muted-foreground">No se realizó ningún envío ni cambio fiscal. Puedes reintentar la comparación ficticia.</p><Button variant="outline" onClick={reset}>Reintentar</Button></div>;}
