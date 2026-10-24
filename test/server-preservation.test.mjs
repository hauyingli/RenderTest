import {test} from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {spawn} from 'node:child_process';
test('original server home, health and diagnostic TEST_KEY remain available; internal secret is separate',async()=>{
 const reservation=http.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),TEST_KEY:'fixture-test-key-for-original-page',RENDER_PREVIEW_SECRET:'a'.repeat(64)},stdio:['ignore','pipe','pipe']});
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup timeout')),5000);child.once('error',reject);child.once('exit',()=>reject(Error('server exited')));child.stdout.on('data',()=>{clearTimeout(timer);resolve();});});
  const root=`http://127.0.0.1:${port}`;
  assert.equal((await fetch(root+'/health')).status,200);const home=await(await fetch(root+'/')).text();assert.match(home,/SharedMark IG/);assert.match(home,/\/api\/test/);assert.ok(!home.includes('a'.repeat(64)));
  assert.equal((await fetch(root+'/api/test',{method:'POST'})).status,401);
  assert.equal((await fetch(root+'/internal/preview',{method:'POST',headers:{'X-Test-Key':'fixture-test-key-for-original-page'}})).status,401);
 }finally{child.kill();await new Promise(r=>child.once('exit',r));}
});
