import { assertHistory, historyJson } from '@factuez/history-core';
import { historyActor, type HistoryIdentityPort } from './access';
import { HistoryArchiveRepository } from './repository';
import { HistoryArtifactStore } from './artifact-store';

/** Internal application service only. No HTTP controller, queue or live bootstrap.
 * Public activation/real-copy/cutover are not part of this rehearsal composition.
 */
export class HistoricalArchiveService {
  constructor(private readonly identity:HistoryIdentityPort,private readonly repository:HistoryArchiveRepository,private readonly artifacts:HistoryArtifactStore) {}
  private async actor(credential:string,permission:'history.import'|'history.view') {
    assertHistory(typeof credential==='string'&&credential.length>0&&credential.length<=8192,'SESSION_REQUIRED');
    return historyActor(await this.identity.authorize(credential,permission),permission);
  }
  async importNext(input:unknown,credential:string) {
    const actor=await this.actor(credential,'history.import');
    const {plan}=await this.repository.preflight(input,actor), checkpoint=await this.repository.checkpoint(plan.normalized,actor);
    if(checkpoint.complete) return {...checkpoint,persisted:true,deduplicated:true,insertedCount:0};
    const keys=await this.artifacts.stageBatch(plan.normalized,checkpoint.completedBatches);
    const freshActor=await this.actor(credential,'history.import');
    assertHistory(freshActor.userId===actor.userId,'SESSION_CHANGED');
    return this.repository.commitBatch(plan.normalized,checkpoint.completedBatches,freshActor,keys);
  }
  async list(query:unknown,credential:string) { return this.repository.list(query,await this.actor(credential,'history.view')); }
  async detail(recordId:unknown,credential:string) { return this.repository.detail(recordId,await this.actor(credential,'history.view')); }
  async reconciliation(query:unknown,credential:string) { return this.repository.reconciliation(query,await this.actor(credential,'history.view')); }
  async artifact(recordId:unknown,kind:unknown,credential:string) {
    const actor=await this.actor(credential,'history.view'), detail=await this.repository.detail(recordId,actor);
    const result=await this.artifacts.read(detail.snapshot,kind);
    await this.repository.detail(recordId,await this.actor(credential,'history.view')); // Reauthorization after file I/O.
    return result;
  }
}
export function denyHistoricalCutover(input:unknown):never {
  // No counters/owner changes can be smuggled into a snapshot or service call.
  historyJson(input); throw new Error('HISTORY_REAL_COPY_AND_CUTOVER_DISABLED');
}
