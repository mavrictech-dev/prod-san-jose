"use client";
import {createContext,useContext,useMemo,type ReactNode} from 'react';
import {IntegrationAdminPanel} from './integration-admin-panel';
import {createIntegrationAdminPort,type AuthorizedAdminHttpClient} from './integration-admin-remote';
import {Card,CardContent,CardHeader,CardTitle,CardDescription} from '@factuez/ui/components/card';
const AdminSession=createContext<AuthorizedAdminHttpClient|null>(null);
/** Only the authorized BFF/session host installs this client. No implicit PWA
 * login exchange, browser tokens or default fetch endpoint is supplied. */
export function IntegrationAdminSessionProvider({client,children}:{client:AuthorizedAdminHttpClient;children:ReactNode}){return <AdminSession.Provider value={client}>{children}</AdminSession.Provider>;}
export function IntegrationAdminHost(){
 const client=useContext(AdminSession),port=useMemo(()=>client?createIntegrationAdminPort(client):null,[client]);
 if(!port)return <Card><CardHeader><CardTitle>Integraciones B2B</CardTitle><CardDescription>Administración privada de aplicaciones y permisos.</CardDescription></CardHeader><CardContent><p className="text-sm text-muted-foreground" role="status">No hay una sesión de administración vinculada. El estado del servicio no se ha verificado. La gestión requiere una sesión autorizada con verificación adicional y acceso privado.</p></CardContent></Card>;
 return <IntegrationAdminPanel port={port}/>;
}
