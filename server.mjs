import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {resolvePreview} from './functions/api/preview.js';

// Single fixed public post; this is a diagnostic, not a general-purpose scraper.
const TARGET = 'https://www.instagram.com/p/DezFdXmkkI2/';
const key = process.env.TEST_KEY ?? '';
const port = Number(process.env.PORT ?? '10000');
const cooldownMs = 65_000;
let lastRun = 0;
let running = false;

if (key.length < 20 || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Set a TEST_KEY (at least 20 characters) and a valid PORT.');
  process.exit(1);
}

function validKey(provided) {
  if (typeof provided !== 'string') return false;
  const expected = Buffer.from(key);
  const actual = Buffer.from(provided);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function reply(res, status, body) {
  res.writeHead(status, {
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
  });
  res.end(JSON.stringify(body));
}

const home = `<!doctype html><html lang="zh-Hant"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SharedMark Instagram Render Test</title>
<style>body{font:16px system-ui,sans-serif;max-width:720px;margin:56px auto;padding:0 20px;line-height:1.6;color:#212121}button,input{font:inherit;padding:10px 14px}button{cursor:pointer}input{min-width:260px;max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f4f6;padding:18px;border-radius:8px}small{color:#666}</style>
</head><body><h1>SharedMark IG 雲端來源測試</h1>
<p>固定測試公開貼文：<code>p/DezFdXmkkI2</code>。只回傳狀態和媒體數，不下載圖片。</p>
<p><label>測試密鑰：<input id="key" type="password" autocomplete="off" placeholder="Render 環境變數 TEST_KEY"></label>
<button id="test">開始測試</button></p>
<small>每次間隔至少 65 秒；登入／驗證重新導向即停止，不自動重試。密鑰只在本次請求使用，不寫入瀏覽器儲存。</small>
<pre id="out">尚未測試</pre><script>
document.getElementById('test').addEventListener('click', async () => {
  const button = document.getElementById('test');
  const out = document.getElementById('out');
  button.disabled = true; out.textContent = '測試中…';
  try {
    const r = await fetch('/api/test', {method:'POST', headers:{'X-Test-Key':document.getElementById('key').value}});
    const json = await r.json();
    out.textContent = JSON.stringify({apiStatus:r.status, ...json},null,2);
  } catch (e) {out.textContent = String(e);}
  finally {button.disabled = false;}
});
</script></body></html>`;

async function handle(req,res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') return reply(res,200,{ok:true});
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(home); return;
  }
  if (req.method !== 'POST' || url.pathname !== '/api/test') return reply(res,404,{error:'not_found'});
  if (req.headers.origin) {
    let allowed = false;
    try {allowed = new URL(req.headers.origin).host === req.headers.host;} catch {}
    if (!allowed) return reply(res,403,{error:'invalid_origin'});
  }
  if (!validKey(req.headers['x-test-key'])) return reply(res,401,{error:'invalid_test_key'});
  if (running) return reply(res,429,{error:'test_running'});
  const waitMs = lastRun + cooldownMs - Date.now();
  if (waitMs > 0) return reply(res,429,{error:'cooldown',retryAfterSeconds:Math.ceil(waitMs/1000)});
  running = true; lastRun = Date.now();
  const start = performance.now();
  try {
    // Bound the *source fetch* independently of the app's original 150-second deadline.
    const fetcher = (value,options) => fetch(value,{
      ...options,
      signal:AbortSignal.any([options.signal,AbortSignal.timeout(25_000)]),
    });
    const result = await resolvePreview(TARGET,fetcher);
    const output = {
      status:result.status,
      sourceHttpStatus:result.sourceHttpStatus ?? null,
      sourceOutcome:result.sourceOutcome ?? null,
      reason:result.reason || null,
      galleryStatus:result.galleryStatus ?? null,
      mediaCount:result.media?.length ?? 0,
      imageCount:result.images?.length ?? 0,
      elapsedMs:Math.round(performance.now()-start),
    };
    console.log('[RENDER TEST]', output);
    return reply(res,200,output);
  } catch (error) {
    console.log('[RENDER TEST ERROR]', {type:error?.name ?? 'unknown',elapsedMs:Math.round(performance.now()-start)});
    return reply(res,500,{error:'test_failed'});
  } finally {running = false;}
}

const server = http.createServer((req,res)=>{handle(req,res).catch(()=>{
  if (!res.headersSent) reply(res,500,{error:'internal_error'});
  else res.end();
});});
server.listen(port,'0.0.0.0',()=>console.log(`SharedMark Render test listening on ${port}`));
