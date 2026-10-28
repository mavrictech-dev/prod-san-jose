import { defineConfig } from 'vitest/config';
import base from '../vitest.config.mts';

// Ahora comprueba reparación/recuperación, no el comportamiento defectuoso previo.
export default defineConfig({ ...base, test: { ...base.test, include: ['tests/batch-recovery.spec.ts', 'tests/notes-recovery.spec.ts', 'tests/local-preparation-policy.spec.ts', 'tests/circuit-recovery.spec.ts', 'tests/local-emission-workflow.spec.ts'] } });
