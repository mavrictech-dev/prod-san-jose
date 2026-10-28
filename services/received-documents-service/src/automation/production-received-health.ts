/** Health capability is local state, never an assertion of a validated LIVE connector. */
export function productionReceivedHealthCapabilities(env:NodeJS.ProcessEnv=process.env) {
  const liveReadAllowed=env.RECEIVED_LIVE_READ_ALLOWED==='true';
  const localFixtureAllowed=env.RECEIVED_LOCAL_FIXTURE_ENABLED==='true';
  return {mode:liveReadAllowed?'LIVE_READ_ONLY_CAPABLE':localFixtureAllowed?'LOCAL_FIXTURE_CAPABLE':'EXTERNAL_READ_DISABLED',liveReadAllowed,localFixtureAllowed,perRucActivationRequired:true,externalConnectionValidation:'NOT_PERFORMED_BY_HEALTH',officialTransmission:false};
}
export async function productionReceivedApiHealth(db:{$queryRaw(query:TemplateStringsArray):PromiseLike<unknown>}) {
  await db.$queryRaw`SELECT 1`;
  return {status:'ok',service:'received-documents-service',...productionReceivedHealthCapabilities()};
}
export function productionReceivedWorkerHealth(lastTick:number, now=Date.now()) {
  const schedulerHealthy=Number.isFinite(lastTick)&&lastTick>0&&lastTick<=now&&now-lastTick<90000;
  return {status:schedulerHealthy?'ok':'unavailable',service:'received-sync-worker',schedulerHealthy,lastSchedulerTick:lastTick>0?new Date(lastTick).toISOString():null,fiscalEmission:false,...productionReceivedHealthCapabilities()};
}
