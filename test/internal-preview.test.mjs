import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createInternalPreview,instagramSource} from '../internal-preview.mjs';
import {handleInternalHTTP} from '../internal-http.mjs';
import {photoIdentity} from '../functions/api/preview.js';
const secret='a'.repeat(64),source='https://www.instagram.com/p/DezFdXmkkI2/';
const image=i=>`https://a.cdninstagram.com/v/post-${i}.jpg?oe=ffffffff`;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhN0AAAAASUVORK5CYII=','base64');
const html=(count=7)=>`<meta property="og:url" content="${source}"><script type="application/json">${JSON.stringify({code:'DezFdXmkkI2',user:{username:'example'},carousel_media:Array.from({length:count},(_,i)=>({media_type:i===2?2:1,image_versions2:{candidates:[{url:image(i)}]},...(i===2?{video_versions:[{url:'https://a.cdninstagram.com/video.mp4'}]}:{})}))})}</script>`;
const request=(path,body={url:source},headers={})=>new Request('https://render.test'+path,{method:'POST',headers:{'Content-Type':'application/json','X-SharedMark-Render-Secret':secret,...headers},body:JSON.stringify(body)});
const jsonRequest=(handler,path,body,headers)=>handler(request(path,body,headers));
function transport(network,{sourceResponse,imageResponse}={}){return async(url,options)=>{
 assert.equal(options.headers.Cookie,undefined);assert.equal(options.headers.Authorization,undefined);
 assert.equal(options.headers['X-SharedMark-Render-Secret'],undefined);assert.equal(options.redirect,'manual');network.push(String(url));
 return String(url).startsWith('https://www.instagram.com/')?(sourceResponse?.()||new Response(html(),{headers:{'Content-Type':'text/html'}})):
  (imageResponse?.()||new Response(png,{headers:{'Content-Type':'image/png'}}));
};}
test('internal album returns seven ordered stable media, mixed video, and coalesces metadata',async()=>{
 const network=[],handler=createInternalPreview({secret,fetcher:transport(network)});
 const [a,b]=await Promise.all([jsonRequest(handler,'/internal/preview'),jsonRequest(handler,'/internal/preview')]);
 const value=await a.json();assert.equal(b.status,200);assert.equal(value.mediaItems.length,7);assert.equal(value.mediaPattern,'iiviiii');
 assert.deepEqual(value.mediaItems.map(v=>v.index),[0,1,2,3,4,5,6]);assert.equal(value.mediaItems[0].id,await photoIdentity(source,image(0)));
 assert.equal(value.mediaItems[2].type,'video');assert.match(value.mediaItems[2].posterUrl,/preview-photo/);assert.equal(network.length,1);
});
test('photo verifies membership, returns PNG bytes and coalesces simultaneous downloads',async()=>{
 const network=[],handler=createInternalPreview({secret,fetcher:transport(network)}),id=await photoIdentity(source,image(0));
 const [a,b]=await Promise.all([jsonRequest(handler,'/internal/photo',{url:source,id}),jsonRequest(handler,'/internal/photo',{url:source,id})]);
 assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(a.headers.get('content-type'),'image/png');
 assert.deepEqual(Buffer.from(await a.arrayBuffer()),png);assert.equal(network.length,2);
 const denied=await jsonRequest(handler,'/internal/photo',{url:source,id:'0'.repeat(32)});assert.equal(denied.status,404);assert.equal(network.length,2);
});
test('missing/wrong credentials, TEST_KEY, Origin, methods and unconfigured secret fail before source',async()=>{
 let calls=0;const handler=createInternalPreview({secret,fetcher:()=>{calls++;throw Error();}});
 for(const headers of [{'X-SharedMark-Render-Secret':''},{'X-SharedMark-Render-Secret':'bad'},{'X-Test-Key':secret,'X-SharedMark-Render-Secret':''}])assert.equal((await jsonRequest(handler,'/internal/preview',undefined,headers)).status,401);
 assert.equal((await jsonRequest(handler,'/internal/preview',undefined,{Origin:'https://app.test'})).status,403);
 assert.equal((await handler(new Request('https://x/internal/photo',{headers:{'X-SharedMark-Render-Secret':secret}}))).status,405);
 assert.equal((await createInternalPreview({secret:''})(request('/internal/preview'))).status,503);assert.equal(calls,0);
});
test('strict whitelist rejects malicious URLs, extra image URL fields and excessive/invalid JSON',async()=>{
 let calls=0;const handler=createInternalPreview({secret,fetcher:()=>{calls++;throw Error();}});
 for(const url of ['http://www.instagram.com/p/abc/','https://127.0.0.1/p/abc/','https://www.instagram.com.evil.test/p/abc/',
  'https://u:p@www.instagram.com/p/abc/','https://www.instagram.com:443/p/abc/','https://www.instagram.com/p/%2e%2e/',
  'https://www.instagram.com/api/v1/media/','https://www.instagram.com/accounts/login/','https://www.instagram.com/p/abc/?url=http://localhost/',
  'https://www.instagram.com/share/abc/','https://www.instagram.com/p/abc/#x']){
  assert.equal(instagramSource(url),null,url);assert.equal((await jsonRequest(handler,'/internal/preview',{url})).status,400,url);
 }
 assert.equal((await jsonRequest(handler,'/internal/photo',{url:source,id:'a'.repeat(32),imageUrl:'http://localhost/'})).status,400);
 assert.equal((await jsonRequest(handler,'/internal/preview',{url:'x'.repeat(5000)})).status,413);
 assert.equal((await handler(new Request('https://x/internal/preview',{method:'POST',headers:{'X-SharedMark-Render-Secret':secret,'Content-Type':'application/json'},body:'{'}))).status,400);
 assert.equal(calls,0);
});
test('source login stops; rate limits, timeout and source errors retain safe categories',async()=>{
 for(const [status,location,reason]of [[302,'https://www.instagram.com/accounts/login/?sensitive=hidden','source_unavailable'],[429,null,'rate_limited'],[500,null,'provider_error']]){
  const network=[],handler=createInternalPreview({secret,fetcher:transport(network,{sourceResponse:()=>new Response(null,{status,headers:location?{Location:location}:{'Retry-After':'70'}})})});
  const r=await jsonRequest(handler,'/internal/preview');const value=await r.json();assert.equal(value.reason,reason);assert.equal(value.sourceHttpStatus,status);
  assert.equal(network.length,1);assert.ok(!JSON.stringify(value).includes('sensitive'));assert.equal(r.status,status===429?429:502);
 }
 const handler=createInternalPreview({secret,fetcher:()=>{throw new DOMException('secret detail','TimeoutError');}});
 assert.equal((await jsonRequest(handler,'/internal/preview')).status,504);
});
test('invalid MIME, signature, oversized image and expired CDN URL retain image errors without retry',async()=>{
 const id=await photoIdentity(source,image(0));
 for(const [response,status]of [[()=>new Response('html',{headers:{'Content-Type':'text/html'}}),415],
  [()=>new Response('bad',{headers:{'Content-Type':'image/png'}}),415],
  [()=>new Response(png,{headers:{'Content-Type':'image/png','Content-Length':String(9*1024*1024)}}),413],
  [()=>new Response(null,{status:403}),502]]){
  const network=[],handler=createInternalPreview({secret,fetcher:transport(network,{imageResponse:response})});
  const r=await jsonRequest(handler,'/internal/photo',{url:source,id});assert.equal(r.status,status);assert.equal((await r.json()).photoStage,'image');assert.equal(network.length,2);
 }
});
test('rate and source budgets are bounded and denied calls do not fetch',async()=>{
 const network=[],handler=createInternalPreview({secret,maxRequests:1,fetcher:transport(network)});
 assert.equal((await jsonRequest(handler,'/internal/preview')).status,200);
 const r=await jsonRequest(handler,'/internal/preview');assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'60');assert.equal(network.length,1);
 const zero=createInternalPreview({secret,maxSourceRequests:0,fetcher:transport([])});assert.equal((await jsonRequest(zero,'/internal/preview')).status,429);
});
test('real Node HTTP adapter preserves authentication and image bytes',async()=>{
 const handler=createInternalPreview({secret,fetcher:transport([])}),server=http.createServer((req,res)=>handleInternalHTTP(req,res,handler));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const endpoint=`http://127.0.0.1:${server.address().port}`;
  const no=await fetch(endpoint+'/internal/preview',{method:'POST'});assert.equal(no.status,401);
  const r=await fetch(endpoint+'/internal/photo',{method:'POST',headers:{'Content-Type':'application/json','X-SharedMark-Render-Secret':secret},body:JSON.stringify({url:source,id:await photoIdentity(source,image(0))})});
  assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),png);
 }finally{await new Promise(r=>server.close(r));}
});
