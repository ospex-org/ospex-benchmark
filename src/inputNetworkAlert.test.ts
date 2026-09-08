import assert from 'node:assert/strict';
import test from 'node:test';
import { createInputNetworkEventSink, enqueueInputNetworkAlert } from './inputNetworkAlert.js';

const event=JSON.stringify({event:'input_network_restart',lane:'watcher',dependency:'games',count:3,exitCode:75});
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
test('network alert child argv is fixed; environment excludes provider and database credentials',()=>{
 let calls=0;
 const ok=enqueueInputNetworkAlert(event,(command,args,options)=>{
   calls++; assert.equal(command,'/usr/bin/python3');
   assert.deepEqual(args,['/home/vince/.ospex/heartbeat/ospex-mve/monitoring/enqueue_input_network.py']);
   assert.equal(options.input,event); assert.equal(options.timeout,5000);
   assert.ok(Object.keys(options.env).every(k=>['PATH','HOME','LANG','LC_ALL','TZ','TMPDIR','PYTHONDONTWRITEBYTECODE'].includes(k)));
   assert.equal(options.env.PYTHONDONTWRITEBYTECODE,'1');
   return {status:0};
 });
 assert.equal(ok,true); assert.equal(calls,1);
});
test('network alert missing helper or timeout is not successful enqueue',()=>{
 assert.equal(enqueueInputNetworkAlert(event,()=>({status:2})),false);
 assert.equal(enqueueInputNetworkAlert(event,()=>({status:null})),false);
});
