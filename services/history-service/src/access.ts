import { assertHistory, historyInteger, historyJson, historyObject, historyText, historyUuid } from '@factuez/history-core';

export type HistoryActor = Readonly<{ userId: string; roles: string[]; permissions: string[];
  scope: { kind: 'GLOBAL' } | { kind: 'ASSIGNED'; branchIds: string[]; emissionPointIds: string[]; seriesCounterIds: string[] } }>;
/** Must be implemented by trusted server-side identity verification, NOT body/x-user-id. */
export interface HistoryIdentityPort { authorize(credential: string, permission: 'history.import' | 'history.view'): Promise<unknown> }
export function historyActor(input: unknown, permission: 'history.import' | 'history.view'): HistoryActor {
  const value = historyJson(input); historyObject(value, ['userId','roles','permissions','scope']);
  const userId = historyUuid(value.userId);
  for (const k of ['roles','permissions']) assertHistory(Array.isArray(value[k]) && value[k].length <= 100 && value[k].every((s: unknown) => typeof s === 'string' && s.length <= 80), 'INVALID_ACTOR');
  assertHistory(value.permissions.includes(permission), 'PERMISSION_DENIED');
  if (value.scope?.kind === 'GLOBAL') { historyObject(value.scope,['kind']); assertHistory(value.roles.includes('ADMIN'), 'GLOBAL_SCOPE_DENIED'); }
  else {
    historyObject(value.scope, ['kind','branchIds','emissionPointIds','seriesCounterIds']); assertHistory(value.scope.kind === 'ASSIGNED','INVALID_ACTOR');
    for (const k of ['branchIds','emissionPointIds','seriesCounterIds']) {
      assertHistory(Array.isArray(value.scope[k]) && value.scope[k].length <= 1_000,'INVALID_ACTOR'); value.scope[k] = value.scope[k].map(historyUuid);
    }
  }
  if (permission === 'history.import') assertHistory(value.scope.kind === 'GLOBAL' && value.roles.includes('ADMIN'), 'IMPORT_SCOPE_DENIED');
  return { userId, roles: value.roles, permissions: value.permissions, scope: value.scope };
}
export function historyScopeWhere(actor: HistoryActor) {
  return actor.scope.kind === 'GLOBAL' ? {} : { branchId: { in: actor.scope.branchIds },
    emissionPointId: { in: actor.scope.emissionPointIds }, seriesCounterId: { in: actor.scope.seriesCounterIds } };
}
export function historyListQuery(input: unknown) {
  const value = historyJson(input); historyObject(value,['issuerRuc','branchId','documentTypeCode','series','take','afterRecordId']);
  const issuerRuc = value.issuerRuc === null ? null : historyText(value.issuerRuc,11,/^00000000[0-9]{3}$/);
  const branchId = value.branchId === null ? null : historyUuid(value.branchId);
  const documentTypeCode = value.documentTypeCode === null ? null : historyText(value.documentTypeCode,2,/^(01|03|07|08)$/);
  const series = value.series === null ? null : historyText(value.series,4,/^[FB][A-Z0-9]{3}$/);
  const afterRecordId = value.afterRecordId === null ? null : historyText(value.afterRecordId,64,/^[0-9a-f]{64}$/);
  return { issuerRuc, branchId, documentTypeCode, series, take: historyInteger(value.take,100), afterRecordId };
}
