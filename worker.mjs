import {checkRenderHealth} from './render-health.mjs';
import {resolvePreview} from './functions/api/preview.js';

// A deliberately limited public-post diagnostic, not an unrestricted scraper.
const TARGET='https://www.instagram.com/p/DezFdXmkkI2/';
let lastRun=0,running=false;
const cooldown=65_000;

const page=`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SharedMark Cloudflare IG Test</title>
<style>body{font:16px system-ui;max-width:700px;margin:48px auto;padding:0 20px;line-height:1.6}input,button{font:inherit;padding:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:#eee}</style>
</head><body><h1>SharedMark Cloudflare IG Test</h1>
<p>固定貼文：p/DezFdXmkkI2。僅回傳解析結果，不下載照片。</p>
<input id="key" type="password" placeholder="TEST_KEY Secret" autocomplete="off">
<button id="run">開始測試</button><pre id="result">尚未測試</pre>
<script>document.getElementById('run').onclick=async()=>{const b=document.getElementById('run'),r=document.getElementById('result');
b.disabled=true;r.textContent='測試中…';try{const response=await fetch('/api/test',{method:'POST',headers:{'X-Test-Key':document.getElementById('key').value}});
r.textContent=JSON.stringify({apiStatus:response.status,...await response.json()},null,2)}
catch(e){r.textContent=String(e)}finally{b.disabled=false}}</script></body></html>`;
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{
  'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
async function validKey(candidate,expected){
  if(!candidate || typeof expected!=='string' || expected.length<20)return false;
  const encoder=new TextEncoder();
  const digests=await Promise.all([candidate,expected].map(value=>crypto.subtle.digest('SHA-256',encoder.encode(value))));
  const a=new Uint8Array(digests[0]),b=new Uint8Array(digests[1]);
  let difference=0;for(let i=0;i<a.length;i++)difference|=a[i]^b[i];
  return difference===0;
}
export default {
  async scheduled(event,env){
    const result=await checkRenderHealth(env);
    console.log('[RENDER HEALTH]',{scheduledTime:event.scheduledTime,...result});
  },
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==='GET' && url.pathname==='/health')return json({ok:true,runtime:'cloudflare-workers'});
    if(request.method==='GET' && url.pathname==='/')return new Response(page,{headers:{
      'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    if(request.method!=='POST' || url.pathname!=='/api/test')return json({error:'not_found'},404);
    if(request.headers.get('Origin') && request.headers.get('Origin')!==url.origin)return json({error:'invalid_origin'},403);
    if(!env?.TEST_KEY || env.TEST_KEY.length<20)return json({error:'test_key_not_configured'},503);
    if(!(await validKey(request.headers.get('X-Test-Key'),env.TEST_KEY)))return json({error:'invalid_test_key'},401);
    if(running)return json({error:'test_running'},429);
    const wait=lastRun+cooldown-Date.now();
    if(wait>0)return json({error:'cooldown',retryAfterSeconds:Math.ceil(wait/1000)},429);
    running=true;lastRun=Date.now();const started=performance.now();
    try{
      const fetcher=(target,options)=>fetch(target,{...options,
        signal:AbortSignal.any([options.signal,AbortSignal.timeout(25_000)])});
      const result=await resolvePreview(TARGET,fetcher);
      const summary={status:result.status,sourceHttpStatus:result.sourceHttpStatus??null,
        sourceOutcome:result.sourceOutcome??null,reason:result.reason||null,
        galleryStatus:result.galleryStatus??null,mediaCount:result.media?.length??0,
        imageCount:result.images?.length??0,elapsedMs:Math.round(performance.now()-started)};
      console.log('[WORKER TEST]',summary);
      return json(summary);
    }catch(e){
      console.log('[WORKER TEST ERROR]',{type:e?.name||'unknown'});
      return json({error:'test_failed'},500);
    }finally{running=false}
  },
};
