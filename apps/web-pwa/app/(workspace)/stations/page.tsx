"use client";
import { Badge } from "@factuez/ui/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@factuez/ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@factuez/ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@factuez/ui/components/tabs";
import { useWorkspace } from "../../../features/workspace/provider";
import { Empty, money, PageHeading } from "../../../features/workspace/common";
import { StationAdminWorkspace } from "../../../features/workspace/station-admin";
import { canAdminMasters } from "../../../features/workspace/station-admin-model";
import { ProductAdmin } from "../../../features/workspace/product-admin";

function Products() {
  const { catalog, user, can } = useWorkspace();
  if (user?.scope.kind === "GLOBAL" && user.roles.includes("ADMIN") && user.permissions.includes("product.manage") && can("product.manage")) return <ProductAdmin />;
  return <Card className="shadow-none"><CardHeader><CardTitle>Combustibles y productos</CardTitle><CardDescription>Consulta del catálogo operativo compartido.</CardDescription></CardHeader><CardContent>
    <Table><TableHeader><TableRow><TableHead>SKU</TableHead><TableHead>Producto</TableHead><TableHead>Unidad</TableHead><TableHead>Afectación</TableHead><TableHead className="text-right">Precio de referencia</TableHead></TableRow></TableHeader>
      <TableBody>{catalog?.products.map(product => <TableRow key={product.id}><TableCell className="text-xs">{product.sku}</TableCell><TableCell className="font-medium">{product.description}</TableCell><TableCell>{product.unitCode}</TableCell><TableCell>{product.taxAffectationCode}</TableCell><TableCell className="text-right tabular-nums">{product.defaultUnitPrice ? money(product.defaultUnitPrice) : "Sin precio"}</TableCell></TableRow>)}</TableBody>
    </Table></CardContent></Card>;
}
export default function StationsPage() {
  const { user, catalog, companyId, branchId } = useWorkspace();
  if (canAdminMasters(user)) return <StationAdminWorkspace products={<Products />} />;
  const branches = catalog?.branches.filter(branch => (!branchId || branch.id === branchId) && (!companyId || String(branch.companyId) === companyId)) ?? [];
  return <>
    <PageHeading eyebrow="Sistema privado · múltiples sedes" title="Sedes y maestros" description="Consulta de los emisores, sedes, puntos y series de tu alcance. El CRUD requiere administrador general." />
    <Tabs defaultValue="branches"><TabsList className="mb-5 h-auto flex-wrap"><TabsTrigger value="issuers">Emisores RUC</TabsTrigger><TabsTrigger value="branches">Sedes y series</TabsTrigger><TabsTrigger value="products">Catálogo de productos</TabsTrigger></TabsList>
      <TabsContent value="issuers"><div className="grid gap-5 lg:grid-cols-2">{catalog?.companies.filter(company => !companyId || String(company.id) === companyId).map(company => <Card key={company.id} className="shadow-none"><CardHeader><Badge variant="outline" className="w-fit font-mono">RUC {company.ruc}</Badge><CardTitle>{company.legalName}</CardTitle><CardDescription>{company.environment} · Consulta autorizada</CardDescription></CardHeader></Card>)}</div></TabsContent>
      <TabsContent value="branches"><div className="grid gap-5 lg:grid-cols-2">{branches.map(branch => <Card key={branch.id} className="shadow-none"><CardHeader><Badge variant="outline" className="w-fit">{branch.code}</Badge><CardTitle>{branch.name}</CardTitle><CardDescription>RUC {catalog?.companies.find(c => c.id === branch.companyId)?.ruc}</CardDescription><CardDescription>{branch.address || "Dirección pendiente"}</CardDescription></CardHeader><CardContent className="space-y-3">
        {catalog?.emissionPoints.filter(point => point.branchId === branch.id).map(point => <div key={point.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"><div><p className="text-sm font-medium">{point.name}</p><p className="text-xs text-muted-foreground">{point.code}</p></div><div className="flex gap-2">{point.series.map(counter => <Badge variant="secondary" key={counter.id}>{counter.series}</Badge>)}</div></div>)}
      </CardContent></Card>)}</div>{!branches.length && <Empty title="Sin sedes autorizadas" description="Solicita al administrador una asignación de sede." />}</TabsContent>
      <TabsContent value="products"><Products /></TabsContent>
    </Tabs>
  </>;
}
