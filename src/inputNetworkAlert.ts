import { spawnSync } from 'node:child_process';

interface BridgeOptions {
  input: string; encoding: 'utf8'; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv;
}
type RunBridge = (command:string,args:string[],options:BridgeOptions)=>{status:number|null};

/** Enqueue only into an operator-managed outbox. No send, restart, environment
 * sourcing or fallback endpoint. Missing uninstalled helper is an explicit
 * sanitized diagnostic, never a reason to replay paid work or veto exit 75. */
export function enqueueInputNetworkAlert(line:string, run:RunBridge=spawnSync): boolean {
  const bridge = process.env.OSPEX_INPUT_NETWORK_ALERT_HELPER;
  if (bridge === undefined || bridge.length === 0) return false;
  const env:NodeJS.ProcessEnv={PYTHONDONTWRITEBYTECODE:'1'};
  for (const key of ['PATH','HOME','LANG','LC_ALL','TZ','TMPDIR']) {
    if (process.env[key] !== undefined) env[key]=process.env[key];
  }
  try {
    return run('/usr/bin/python3',[bridge],{
      input:line,encoding:'utf8',timeout:5000,maxBuffer:8192,env,
    }).status === 0;
  } catch { return false; }
}

export function createInputNetworkEventSink(log:(line:string)=>void,
  enqueue:(line:string)=>boolean=enqueueInputNetworkAlert): (line:string)=>void {
  return line=>{
    log(line); // Guard supplies an allowlisted structured event, not raw errors.
    let queued=false;
    try { queued=enqueue(line); } catch { /* no raw exception or child stderr */ }
    if (!queued) log('{"event":"input_network_alert_enqueue_failed"}');
  };
}
