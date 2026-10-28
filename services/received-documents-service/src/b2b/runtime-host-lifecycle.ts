import type {B2bReceivedLegacyLifecycle} from './runtime';
/** Closed-world B2B-only host: DI services have no autonomous activity. This
 * host starts no legacy HTTP app/scheduler/worker. Other processes are NOT
 * covered; the deployment coordinator must register RECEIVED_SYNC separately. */
export class B2bReceivedIsolatedHostLifecycle implements B2bReceivedLegacyLifecycle {
 #phase=0;
 private expect(phase:number){if(this.#phase!==phase)throw Error('RECEIVED_ISOLATED_HOST_PHASE_ORDER');}
 async pauseCommands(){this.expect(0);this.#phase=1;}
 async drainCommands(){this.expect(1);}
 async stopProducers(){this.expect(1);this.#phase=2;}
 async stopWorkers(){this.expect(2);this.#phase=3;}
 async drainMutations(){this.expect(3);}
 async closeAdmission(){this.expect(3);this.#phase=4;}
 async drainAll(){this.expect(4);}
 async closeListeners(){this.expect(4);}
}
