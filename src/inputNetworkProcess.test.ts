import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('real process exit 75, replacement PID, and outage clears only on real read',()=>{
  const dir=mkdtempSync(join(tmpdir(),'input-network-process-')); const state=join(dir,'health.json');
  try {
    const moduleUrl=pathToFileURL(join(process.cwd(),'src/inputNetworkGuard.ts')).href;
    const source=`import { InputNetworkGuard } from ${JSON.stringify(moduleUrl)};
      const g=new InputNetworkGuard({lane:'watcher',statePath:process.argv[1],emit:line=>console.log(line)});
      if(process.argv[2]==='fail') {
        for(let i=0;i<3;i++) {
          g.beginIteration();
          try { await g.read('games',async()=>{throw Object.assign(new Error('SYNTHETIC_SECRET'),{code:'EAI_AGAIN'});}); } catch {}
          const code=g.finishIteration(); if(code!==null)process.exitCode=code;
        }
      } else {
        g.beginIteration(); g.finishIteration();
        const fs=await import('node:fs');
        if(!JSON.parse(fs.readFileSync(process.argv[1],'utf8')).episodes.games)throw new Error('false healthy startup');
        g.beginIteration(); await g.read('games',async()=>[]); g.finishIteration();
        console.log(JSON.stringify({pid:process.pid,recovered:true}));
      }`;
    const run=(phase:string)=>spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',source,state,phase],{
      encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,HOME:dir},
    });
    const first=run('fail'); assert.equal(first.status,75,first.stderr);
    const event=JSON.parse(first.stdout.trim()); assert.equal(event.count,3);
    assert.ok(!first.stdout.includes('SYNTHETIC_SECRET'));
    assert.throws(()=>process.kill(event.pid,0),{code:'ESRCH'});
    const next=run('recover'); assert.equal(next.status,0,next.stderr);
    assert.notEqual(JSON.parse(next.stdout.trim()).pid,event.pid);
    assert.deepEqual(JSON.parse(readFileSync(state,'utf8')).episodes,{});
  } finally {rmSync(dir,{recursive:true,force:true});}
});
