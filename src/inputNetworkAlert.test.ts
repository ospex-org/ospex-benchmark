import assert from 'node:assert/strict';
import test from 'node:test';
import { createInputNetworkEventSink, enqueueInputNetworkAlert } from './inputNetworkAlert.js';

const event=JSON.stringify({event:'input_network_restart',lane:'watcher',dependency:'games',count:3,exitCode:75});
const helperKey = 'OSPEX_INPUT_NETWORK_ALERT_HELPER';
function withHelper(value: string | undefined, check: () => void): void {
 const previous = process.env[helperKey];
 if (value === undefined) delete process.env[helperKey]; else process.env[helperKey] = value;
 try { check(); } finally {
  if (previous === undefined) delete process.env[helperKey]; else process.env[helperKey] = previous;
 }
}
test('network alert sink journals before one enqueue and does not claim delivery',()=>{
 const seen:string[]=[];
 const sink=createInputNetworkEventSink(s=>seen.push(`log:${s}`),s=>{seen.push(`enqueue:${s}`);return true;});
 sink(event); assert.deepEqual(seen,[`log:${event}`,`enqueue:${event}`]);
});
test('network alert transport/helper failure is a bounded diagnostic, not an exit veto',()=>{
 const seen:string[]=[];
 const sink=createInputNetworkEventSink(s=>seen.push(s),()=>{throw new Error('SYNTHETIC_SECRET');});
 assert.doesNotThrow(()=>sink(event));
 assert.equal(seen.length,2); assert.ok(!seen.join('').includes('SYNTHETIC_SECRET'));
 assert.equal(JSON.parse(seen[1]!).event,'input_network_alert_enqueue_failed');
});
test('network alert child gets only the configured helper as one argv; credentials stay excluded',()=>{
 withHelper('./operator helpers/enqueue;literal.py',()=>{
  let calls=0;
  const ok=enqueueInputNetworkAlert(event,(command,args,options)=>{
    calls++; assert.equal(command,'/usr/bin/python3');
    assert.deepEqual(args,['./operator helpers/enqueue;literal.py']);
    assert.equal(options.input,event); assert.equal(options.timeout,5000);
    assert.equal(options.maxBuffer,8192); assert.equal(options.encoding,'utf8');
    assert.ok(!('shell' in options));
    assert.ok(Object.keys(options.env).every(k=>['PATH','HOME','LANG','LC_ALL','TZ','TMPDIR','PYTHONDONTWRITEBYTECODE'].includes(k)));
    assert.equal(options.env.PYTHONDONTWRITEBYTECODE,'1');
    assert.equal(options.env[helperKey], undefined);
    return {status:0};
  });
  assert.equal(ok,true); assert.equal(calls,1);
 });
});
test('network alert missing helper or timeout is not successful enqueue',()=>{
 withHelper('./enqueue.py',()=>{
  assert.equal(enqueueInputNetworkAlert(event,()=>({status:2})),false);
  assert.equal(enqueueInputNetworkAlert(event,()=>({status:null})),false);
  assert.equal(enqueueInputNetworkAlert(event,()=>{throw new Error('SYNTHETIC_SECRET');}),false);
 });
});
test('unset or empty alert-helper configuration never spawns a guessed deployment path',()=>{
 for (const value of [undefined, '']) withHelper(value,()=>{
  let calls=0;
  assert.equal(enqueueInputNetworkAlert(event,()=>{calls++; return {status:0};}),false);
  assert.equal(calls,0);
 });
});
test('sink with no configured helper emits only the fixed enqueue-failure diagnostic',()=>{
 withHelper(undefined,()=>{
  const seen:string[]=[];
  let calls=0;
  createInputNetworkEventSink(line=>seen.push(line), line=>enqueueInputNetworkAlert(line,()=>{calls++; return {status:0};}))(event);
  assert.equal(calls,0);
  assert.deepEqual(seen,[event,'{"event":"input_network_alert_enqueue_failed"}']);
 });
});
