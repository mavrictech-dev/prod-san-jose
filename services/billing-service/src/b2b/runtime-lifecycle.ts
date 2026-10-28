import type { NestInterceptor } from '@nestjs/common';
import type { B2bMaintenanceHooks } from '@factuez/service-access/dist/b2b-maintenance-node';

/** Inject the parent's genuine B2bOwnerDrain({enabled:true}). No local substitute. */
export interface BillingOwnerDrain {
  install(app: { use(fn: (req: any, res: any, next: () => void) => void): unknown; useGlobalInterceptors(...interceptors: NestInterceptor[]): unknown }): void;
  pauseCommands(): void;
  closeAdmission(): void;
  drain(which: 'COMMANDS' | 'MUTATIONS' | 'ALL', timeoutMs?: number): Promise<{ state: string; pending: number }>;
  snapshot(): { state: string; active: number; commands: number; mutations: number; aborted: number };
}

/** Incomplete drain fails maintenance; disconnected clients cannot release SQL work. */
export class BillingRuntimeLifecycle {
  private installed = false;
  private admission = true;
  private storage = true;
  private closeHttp?: () => Promise<void>;
  constructor(readonly ownerDrain: BillingOwnerDrain) {}
  snapshot() { return { admissionOpen: this.admission, storageOpen: this.storage, installed: this.installed, drain: this.ownerDrain.snapshot() }; }
  install(app: Parameters<BillingOwnerDrain['install']>[0] & { close(): Promise<void> }) {
    if (this.installed) throw Error('BILLING_RUNTIME_HOST_ALREADY_INSTALLED');
    this.ownerDrain.install(app); this.installed = true; this.closeHttp = () => app.close();
  }
  authorize() {
    if (!this.installed) throw Error('BILLING_RUNTIME_HTTP_TRACKING_REQUIRED');
    if (!this.storage) throw Error('BILLING_RUNTIME_STORAGE_CLOSED');
  }
  private async drain(which: 'COMMANDS' | 'MUTATIONS' | 'ALL') {
    const result = await this.ownerDrain.drain(which);
    if (result.state !== 'DRAINED' || result.pending !== 0) throw Error('BILLING_RUNTIME_' + which + '_NOT_DRAINED');
  }
  hooks(legacy: B2bMaintenanceHooks, closeBusiness: () => Promise<void>): B2bMaintenanceHooks {
    return {
      ADMISSION: async () => {
        this.admission = false; this.ownerDrain.pauseCommands();
        await legacy.ADMISSION(); await this.drain('COMMANDS');
      },
      PRODUCERS: async () => { await legacy.PRODUCERS(); },
      WORKERS: async () => { await legacy.WORKERS(); await this.drain('MUTATIONS'); },
      STORAGE: async () => {
        this.ownerDrain.closeAdmission(); this.storage = false;
        await this.drain('ALL');
        await this.closeHttp?.(); await closeBusiness(); await legacy.STORAGE();
      },
    };
  }
}
