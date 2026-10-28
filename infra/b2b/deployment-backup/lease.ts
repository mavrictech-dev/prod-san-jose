import {b2bManagedServices, type B2bDeploymentMaintenance} from '../../../packages/service-access/src/b2b-deployment-maintenance';
import {type Context, type LeaseProof, type OfflineLeasePort} from './ports';
import {context, equal, requireThat} from './model';
/** Bridge to the PARENT coordinator. Never grants global or TI authorization.
 * The coordinator performs fresh offline verification BEFORE and AFTER work.
 * WeakSet membership makes an archived/local receipt unusable as a live lease. */
export class CoordinatorOfflineLease implements OfflineLeasePort {
  #coordinator: Pick<B2bDeploymentMaintenance, 'withOfflineSnapshot' | 'snapshot'>;
  #held = new WeakMap<LeaseProof, Context>();
  constructor(coordinator: Pick<B2bDeploymentMaintenance, 'withOfflineSnapshot' | 'snapshot'>) {this.#coordinator = coordinator;}
  private current(c: Context): LeaseProof {
    const s = this.#coordinator.snapshot();
    requireThat(s.state === 'STOPPED_CLEAN' && s.backupInProgress && s.deploymentId === c.deploymentId && s.runId === c.runId &&
      s.scope === 'EXPLICIT_REGISTERED_DEPLOYMENT' && s.backupAuthorized === false && s.globalUnmanagedWritersVerified === false &&
      s.instances.length > 0 && Object.keys(b2bManagedServices).every(service => s.instances.some(i => i.service === service)) &&
      new Set(s.instances.map(i => i.instanceId)).size === s.instances.length &&
      s.instances.every(i => i.phase === 'STORAGE' && i.state === 'STOPPED_CLEAN'), 'DEPLOYMENT_LEASE_REQUIRED');
    return {deploymentId: s.deploymentId, runId: s.runId!, inventorySha256: s.inventorySha256,
      inventoryRevision: s.inventoryRevision, scope: 'EXPLICIT_REGISTERED_DEPLOYMENT'};
  }
  async withOfflineSnapshot<T>(c: Context, work: (proof: LeaseProof) => Promise<T>): Promise<T> {
    return this.#coordinator.withOfflineSnapshot(async () => {
      const proof = Object.freeze(this.current(c)); this.#held.set(proof, context(c));
      try {return await work(proof);} finally {this.#held.delete(proof);}
    });
  }
  assertHeld(proof: LeaseProof, c: Context) {
    const bound = this.#held.get(proof);
    requireThat(bound, 'DEPLOYMENT_LEASE_REQUIRED'); equal(bound, context(c), 'DEPLOYMENT_LEASE_CHANGED'); equal(this.current(c), proof, 'DEPLOYMENT_LEASE_CHANGED');
  }
}
