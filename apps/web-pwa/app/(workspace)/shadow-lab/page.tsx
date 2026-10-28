import {loadShadowPanelData} from '../../../features/shadow/data.server';
import {ShadowLabWorkspace} from '../../../features/shadow/workspace';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export default function ShadowLabPage(){return <ShadowLabWorkspace data={loadShadowPanelData()}/>;}
