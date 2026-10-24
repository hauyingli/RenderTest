import {test} from 'node:test';import assert from 'node:assert/strict';
import {checkRenderHealth} from '../render-health.mjs';
import worker from '../worker.mjs';import {readFileSync}from'node:fs';
test('health probe defaults off and sends no credentials or source media requests',async()=>{
 let calls=0;assert.deepEqual(await checkRenderHealth({}, {fetcher:()=>{calls++;}}),{outcome:'disabled'});assert.equal(calls,0);
 const result=await checkRenderHealth({RENDER_HEALTH_CHECK_ENABLED:'true',TEST_KEY:'private',RENDER_PREVIEW_SECRET:'private'},{fetcher:async(url,options)=>{
  calls++;assert.equal(url,'https://rendertest-gmdr.onrender.com/health');assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');
  assert.deepEqual(Object.keys(options.headers).sort(),['Accept','Cache-Control','Pragma']);assert.ok(options.signal instanceof AbortSignal);
  return Response.json({ok:true});}});assert.equal(result.outcome,'ok');assert.equal(calls,1);
});
test('health errors are bounded and never followed or retried',async()=>{
 for(const [make,expected]of [[()=>new Response(null,{status:302,headers:{Location:'http://127.0.0.1/'}}),'http_error'],
  [()=>new Response(null,{status:429}),'http_error'],[()=>new Response('html'),'invalid_health_response'],
  [()=>Response.json({ok:false}),'invalid_health_response'],[()=>new Response('x'.repeat(2048),{headers:{'Content-Type':'application/json'}}),'invalid_health_response'],
  [()=>{throw new DOMException('private','TimeoutError');},'timeout'],[()=>{throw Error('private');},'network_error']]){
  let calls=0;const result=await checkRenderHealth({RENDER_HEALTH_CHECK_ENABLED:'true'},{fetcher:async()=>{calls++;return make();}});
  assert.equal(result.outcome,expected);assert.equal(calls,1);assert.ok(!JSON.stringify(result).includes('private'));
 }
});
test('existing worker has scheduled entry and deployment config targets existing service once per minute',async()=>{
 const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));assert.equal(config.name,'rendertest');assert.equal(config.keep_vars,true);assert.deepEqual(config.triggers.crons,['* * * * *']);
 const original=console.log;const logs=[];console.log=(...args)=>logs.push(args);
 try{await worker.scheduled({scheduledTime:123},{});}finally{console.log=original;}
 assert.equal(logs[0][1].outcome,'disabled');assert.equal(logs[0][1].scheduledTime,123);assert.equal(typeof worker.fetch,'function');
});
