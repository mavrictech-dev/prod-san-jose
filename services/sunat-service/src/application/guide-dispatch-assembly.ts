import type {PrismaService} from '../infrastructure/prisma.service';
import {GuideDispatchCoordinator} from './guide-dispatch';
import {PostgresGuideDispatchStore} from './guide-dispatch-store';
import type {GuideDispatchOwner,GuideDispatchEmulator} from './guide-dispatch-types';

/** Explicit isolated-candidate composition only. No owner is fabricated, no
 * schema is applied, no queue registered and no official GRE adapter imported. */
export function createLocalGuideDispatchCoordinator(db:PrismaService,owner:GuideDispatchOwner,emulator:GuideDispatchEmulator,now=()=>new Date().toISOString()){
  if(!owner||typeof owner.current!=='function')throw new Error('Explicit guide package owner required');
  return new GuideDispatchCoordinator(new PostgresGuideDispatchStore(db),owner,emulator,now);
}
