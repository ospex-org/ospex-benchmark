import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputNetworkGuard, InputTransportFailure, transportCause, TEMPORARY_NETWORK_EXIT, pollFreeInputs } from './inputNetworkGuard.js';

const dns = () => new TypeError('fetch failed https://user:SECRET@private/?token=SECRET', {
  cause: Object.assign(new Error('SECRET'), {code: 'EAI_AGAIN', syscall: 'getaddrinfo', address: 'SECRET'})
});
function harness(lane: 'watcher' | 'campaign' = 'watcher') {
  const events: string[] = [];
  let clock = 1000;
  const guard = new InputNetworkGuard({lane, now: () => clock++, emit: s => events.push(s), bootId: 'offline', pid: 42});
  return {guard, events};
}
async function fail(g: InputNetworkGuard, alias: 'games' | 'current_odds' | 'history' = 'games') {
  await assert.rejects(g.read(alias, async () => { throw dns(); }), InputTransportFailure);
}
test('two failing iterations do not exit; duplicate failures count once; third requests one exit', async () => {
  const {guard: g, events} = harness();
  for (let n = 1; n <= 3; n++) {
    g.beginIteration();
    await fail(g); await fail(g);
    assert.equal(g.restartRequested, n === 3);
    assert.equal(g.finishIteration(), n === 3 ? TEMPORARY_NETWORK_EXIT : null);
  }
  assert.equal(events.length, 1);
  const event = JSON.parse(events[0]!);
  assert.equal(event.count, 3); assert.equal(event.lane, 'watcher'); assert.equal(event.dependency, 'games');
  assert.equal(event.pid, 42); assert.equal(event.bootId, 'offline');
  assert.ok(event.firstFailureAt < event.lastFailureAt);
  assert.equal(g.finishIteration(), null); assert.equal(events.length, 1);
});
test('same-dependency completed read resets; unrelated success and no-work do not', async () => {
  const {guard: g} = harness();
  g.beginIteration(); await fail(g); g.finishIteration();
  g.beginIteration(); await g.read('current_odds', async () => []); g.finishIteration();
  g.beginIteration(); g.finishIteration();
  g.beginIteration(); await fail(g); assert.equal(g.finishIteration(), null);
  g.beginIteration(); await g.read('games', async () => []); g.finishIteration();
  g.beginIteration(); await fail(g); assert.equal(g.finishIteration(), null);
  g.beginIteration(); await fail(g); assert.equal(g.finishIteration(), null);
  g.beginIteration(); await fail(g); assert.equal(g.finishIteration(), 75);
});
test('a failed member of one dependency cannot be hidden by concurrent successes', async () => {
  const {guard: g} = harness();
  for (let n = 0; n < 3; n++) {
    g.beginIteration(); await fail(g, 'history');
    if (!g.restartRequested) await g.read('history', async () => null);
    assert.equal(g.finishIteration(), n === 2 ? 75 : null);
  }
});
test('dependency isolation does not combine failures into a global streak', async () => {
  const {guard: g, events} = harness();
  for (const alias of ['games', 'history', 'current_odds'] as const) {
    g.beginIteration(); await fail(g, alias); assert.equal(g.finishIteration(), null);
  }
  assert.deepEqual(events, []);
});
test('strict nested transport cause allowlist, hostile objects, cycles, and secret hygiene', async () => {
  assert.deepEqual(transportCause(dns()), [{code:'EAI_AGAIN', syscall:'getaddrinfo'}]);
  for (const e of [new TypeError('fetch failed'), new Error('HTTP 401'), new Error('HTTP 503'),
    new Error('empty'), Object.assign(new Error('Abort'), {name:'AbortError'}),
    {code:'EAI_AGAIN SECRET'}, {code:'ERR_INVALID_URL'}, {code:'ENOSPC'},
    {get code() {throw new Error('SECRET');}}, Proxy.revocable({}, {}).proxy]) {
    assert.equal(transportCause(e), null);
  }
  const cyclic: Record<string, unknown> = {}; cyclic.cause = cyclic;
  assert.equal(transportCause(cyclic), null);
  const revoked = Proxy.revocable({}, {}); revoked.revoke(); assert.equal(transportCause(revoked.proxy), null);
  const {guard: g, events} = harness();
  for (let n = 0; n < 3; n++) {g.beginIteration(); await fail(g); g.finishIteration();}
  assert.ok(!events.join('').includes('SECRET')); assert.ok(!events.join('').includes('https://'));
});
test('nontransport errors never request recycling or reset an unresolved streak', async () => {
  const {guard: g} = harness();
  g.beginIteration(); await fail(g); g.finishIteration();
  for (const error of [new TypeError('fetch failed'), new Error('HTTP 401'), new Error('model budget policy')]) {
    g.beginIteration(); await assert.rejects(g.read('games', async () => {throw error;}), e => e === error);
    assert.equal(g.finishIteration(), null);
  }
  g.beginIteration(); await fail(g); assert.equal(g.finishIteration(), null);
  g.beginIteration(); await fail(g); assert.equal(g.finishIteration(), 75);
});
test('durable unresolved episodes rehydrate, but each new PID still takes three polls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'input-network-')); const statePath = join(dir, 'health.json');
  try {
    const events: string[] = [];
    for (let pid = 1; pid <= 2; pid++) {
      const g = new InputNetworkGuard({lane:'watcher', statePath, emit:s => events.push(s), pid});
      for (let n=1;n<=3;n++) {g.beginIteration(); await fail(g); assert.equal(g.finishIteration(), n===3 ? 75 : null);}
    }
    assert.equal(JSON.parse(events[1]!).episodeFailureCount, 6);
    assert.equal(JSON.parse(events[1]!).episodeFirstFailureAt, JSON.parse(events[0]!).episodeFirstFailureAt);
    assert.ok(!readFileSync(statePath, 'utf8').includes('SECRET'));
    const g = new InputNetworkGuard({lane:'watcher', statePath, emit:() => {}});
    g.beginIteration(); await g.read('games', async () => []); g.finishIteration();
    assert.deepEqual(JSON.parse(readFileSync(statePath,'utf8')).episodes, {});
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('campaign free-input polling sleeps twice, joins reads, never repeats paid work', async () => {
  const {guard: g, events} = harness('campaign'); let reads=0; let joined=0; let paid=0; const sleeps:number[]=[];
  await assert.rejects(pollFreeInputs(g, 30000, async () => {
    reads++;
    await Promise.allSettled([g.read('games', async () => {throw dns();}),
      g.read('history', async () => {await new Promise(r => setTimeout(r,5)); joined++; return [];} )]);
    if (g.hasTransportFailure) throw new InputTransportFailure('games', transportCause(dns())!);
    return 1;
  }, async ms => {sleeps.push(ms);}).then(() => {paid++;}), InputTransportFailure);
  assert.equal(reads,3); assert.equal(joined,3); assert.equal(paid,0);
  assert.deepEqual(sleeps,[30000,30000]); assert.equal(events.length,1);
});
test('free-input polling does not retry unclassified failures or work after admission', async () => {
  const {guard: g} = harness('campaign'); let sleeps=0; let paid=0;
  await assert.rejects(pollFreeInputs(g,30000,async () => {throw new TypeError('fetch failed');},async () => {sleeps++;}));
  assert.equal(sleeps,0);
  const {guard: h} = harness('campaign');
  const result = await pollFreeInputs(h,30000,async () => 1,async () => {sleeps++;});
  assert.equal(result,1);
  try { paid++; throw dns(); } catch {} // outside the retry scope by construction
  assert.equal(paid,1); assert.equal(sleeps,0);
});

test('startup corrupt health is bounded STOP, and an in-flight sibling forbids finish', async () => {
  const dir=mkdtempSync(join(tmpdir(),'network-startup-')); const statePath=join(dir,'health.json');
  try {
    writeFileSync(statePath,'SECRET invalid json');
    assert.throws(()=>new InputNetworkGuard({lane:'watcher',statePath,emit:()=>{}}),/STOP for operator review/);
  } finally {rmSync(dir,{recursive:true,force:true});}
  const {guard:g}=harness(); g.beginIteration();
  let release!:()=>void;
  const pending=g.read('games',()=>new Promise<void>(r=>{release=r;}));
  assert.throws(()=>g.finishIteration(),/reads in flight/);
  release(); await pending; assert.equal(g.finishIteration(),null);
});
