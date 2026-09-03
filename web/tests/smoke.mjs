import fs from 'node:fs';
import { spawn } from 'node:child_process';
const port=18080+Math.floor(Math.random()*1000);
const p=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
let done=false;
const stop=(code=0)=>{if(done)return;done=true;p.kill();process.exitCode=code};
setTimeout(async()=>{try{
  const h=await fetch(`http://127.0.0.1:${port}/api/health`).then(r=>r.json());
  const s=await fetch(`http://127.0.0.1:${port}/api/settings`).then(r=>r.json());
  const t=await fetch(`http://127.0.0.1:${port}/api/tasks`).then(r=>r.json());
  if(!h.ok||h.runtime!=='node'||!Array.isArray(t)||s.max<2)throw new Error('Smoke test invalide');
  console.log('OK smoke:',h.app,h.version,'concurrency',s.concurrency,'max',s.max);stop(0);
}catch(e){console.error(e);stop(1)}},1200);
setTimeout(()=>{console.error('Timeout smoke test');stop(1)},8000);
