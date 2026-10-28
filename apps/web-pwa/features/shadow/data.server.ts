import 'server-only';
import {compareShadowRun} from '@factuez/shadow-core';
import {createShadowPanelFixture} from '@factuez/shadow-core/fixtures';
import type {ShadowPanelData} from './model';
/** Fixed public fictional fixtures. Never accepts query/body input or reads configuration. */
export function loadShadowPanelData():ShadowPanelData{
  const input=createShadowPanelFixture();return {schemaVersion:'factuez.shadow-panel.v1',report:compareShadowRun(input),cases:input.cases};
}
