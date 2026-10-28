export type User = {
  sub: string;
  username: string;
  fullName?: string;
  roles: string[];
  permissions: string[];
  exp: number;
  scope:
    | { kind: "GLOBAL" }
    | {
        kind: "ASSIGNED";
        branchIds: string[];
        emissionPointIds: string[];
        series: string[];
      };
};
export type Company = {
  id: number;
  legalName: string;
  ruc: string;
  environment: string;
};
export type Branch = {
  companyId: number;
  id: string;
  code: string;
  name: string;
  address?: string | null;
};
export type Point = {
  companyId: number;
  id: string;
  code: string;
  name: string;
  branchId: string;
  series: { id: string; documentType: string; series: string }[];
};
export type Product = {
  id: string;
  sku: string;
  description: string;
  unitCode: string;
  defaultUnitPrice: string | null;
  taxAffectationCode: string;
};
export type Catalog = {
  companies: Company[];
  capabilities: { demoData: boolean; fiscalTransmission: boolean };
  branches: Branch[];
  emissionPoints: Point[];
  products: Product[];
};
export type DocumentRow = {
  companyId: number;
  issuerRuc: string;
  id: string;
  fullNumber: string;
  documentType: string;
  customerLegalName: string;
  payableAmount: string;
  currencyCode: string;
  sunatStatus: string;
  issueDate: string;
  branchName: string;
  sunatResponseDescription?: string;
};
export type DocumentPage = {
  page: number;
  pageSize: number;
  total: number;
  items: DocumentRow[];
};
export type DashboardData = {
  date: string;
  updatedAt: string;
  currencyCode: string;
  count: number;
  amount: string;
  igv: string;
  states: { status: string; count: number }[];
  types: { type: string; count: number; amount: string }[];
  points: { pointId: string; count: number; amount: string }[];
};
export type ManagedUser = {
  id: string;
  username: string;
  fullName: string;
  active: boolean;
  editable: boolean;
  roles: { code: string; name: string }[];
  branchIds: string[];
  emissionPointIds: string[];
  series: string[];
};
export type Role = {
  id: string;
  code: string;
  name: string;
  description: string;
  permissions: string[];
  assignable: boolean;
  editable?: boolean;
};
