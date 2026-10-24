// 將允許來源的預覽圖片交給裝置快取；伺服器不保存媒體或來源回應。
import {coverURL,retrySeconds} from './preview.js';

export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const IMAGE_MIME_TYPES = new Set(['image/jpeg','image/png','image/webp','image/gif','image/avif']);
const buckets = new Map();
const headers = {'Cache-Control':'private, no-store', 'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer'};

export class PreviewImageFailure extends Error {
  constructor(status, reason, sourceDiagnostic, retryAfterSeconds) {
    super(reason); this.status = status; this.reason = reason;
    this.sourceDiagnostic = sourceDiagnostic; this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function validImageSignature(bytes, mime) {
  const starts = values => values.every((value,index) => bytes[index] === value);
  const ascii = (at,length) => String.fromCharCode(...bytes.subarray(at,at+length));
  if (mime === 'image/jpeg') return starts([255,216,255]);
  if (mime === 'image/png') return starts([137,80,78,71,13,10,26,10]);
  if (mime === 'image/gif') return ['GIF87a','GIF89a'].includes(ascii(0,6));
  if (mime === 'image/webp') return bytes.length >= 12 && ascii(0,4) === 'RIFF' && ascii(8,4) === 'WEBP';
  if (mime === 'image/avif' && bytes.length >= 16 && ascii(4,4) === 'ftyp') {
    const length = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0);
    if (length < 16 || length > bytes.length || length > 1024) return false;
    if (['avif','avis'].includes(ascii(8,4))) return true;
    for (let at = 16; at + 4 <= length; at += 4) {
      if (['avif','avis'].includes(ascii(at,4))) return true;
    }
  }
  return false;
}

export async function fetchPreviewImage(value, platform, fetcher = fetch) {
  if (!['Threads','Instagram','YouTube'].includes(platform)) throw new PreviewImageFailure(400,'invalid_source');
  let url = coverURL(value,platform);
  if (!url) throw new PreviewImageFailure(400,'invalid_source');
  const signal = AbortSignal.timeout(15000);
  let sourceHttpStatus;
  try {
    for (let redirects = 0; ; redirects++) {
      const response = await fetcher(url, {redirect:'manual', signal,
        cf:{cacheTtlByStatus:{'100-599':-1}},
        headers:{Accept:[...IMAGE_MIME_TYPES].join(', '),
          'User-Agent':'SharedMark/0.4 (+https://sharedmark.pages.dev)',
          'Cache-Control':'no-store', Pragma:'no-cache'}});
      sourceHttpStatus=response.status;
      if ([301,302,303,307,308].includes(response.status)) {
        await response.body?.cancel();
        let next;
        const location = response.headers.get('location');
        try { next = location && coverURL(new URL(location,url).href,platform); }
        catch (_) { /* Invalid Location is rejected below. */ }
        if (!next || redirects >= 2) throw new PreviewImageFailure(502,'invalid_redirect',
          {sourceHttpStatus,sourceOutcome:'redirect_rejected'});
        url = next;
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new PreviewImageFailure(response.status === 429 ? 429 : 502,
          response.status === 429 ? 'rate_limited' : 'source_unavailable',
          {sourceHttpStatus,sourceOutcome:'http_error'},
          response.status === 429 ? retrySeconds(response.headers.get('retry-after')) : undefined);
      }
      const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!IMAGE_MIME_TYPES.has(mime)) {
        await response.body?.cancel();
        throw new PreviewImageFailure(415,'invalid_image',
          {sourceHttpStatus,sourceOutcome:'invalid_image_type'});
      }
      const declared = Number(response.headers.get('content-length'));
      if (declared > IMAGE_MAX_BYTES) {
        await response.body?.cancel();
        throw new PreviewImageFailure(413,'image_too_large',
          {sourceHttpStatus,sourceOutcome:'response_too_large'});
      }
      const reader = response.body?.getReader();
      if (!reader) throw new PreviewImageFailure(415,'invalid_image',
        {sourceHttpStatus,sourceOutcome:'invalid_image_signature'});
      const parts = []; let size = 0;
      try {
        while (true) {
          const {done,value:part} = await reader.read();
          if (done) break;
          size += part.byteLength;
          if (size > IMAGE_MAX_BYTES) throw new PreviewImageFailure(413,'image_too_large',
            {sourceHttpStatus,sourceOutcome:'response_too_large'});
          parts.push(part);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(size); let at = 0;
      for (const part of parts) { bytes.set(part,at); at += part.byteLength; }
      // MIME and magic bytes validate the proxy payload, not full image decoding.
      // The Flutter codec remains the authority for a displayable image.
      if (!validImageSignature(bytes,mime)) throw new PreviewImageFailure(415,'invalid_image',
        {sourceHttpStatus,sourceOutcome:'invalid_image_signature'});
      return {bytes,mime};
    }
  } catch (error) {
    if (error instanceof PreviewImageFailure) throw error;
    const timedOut = signal.aborted || ['TimeoutError','AbortError'].includes(error?.name);
    throw new PreviewImageFailure(timedOut ? 504 : 502, timedOut ? 'timeout' : 'source_unavailable',
      {...(sourceHttpStatus ? {sourceHttpStatus} : {}),sourceOutcome:timedOut ? 'timeout' : 'network_error'});
  }
}

export async function onRequest({request, env = {}}) {
  const origin = request.headers.get('Origin');
  const allowed = new Set([new URL(request.url).origin,
    ...(env.PREVIEW_ALLOWED_ORIGINS || '').split(',').map(value => value.trim())]);
  const cors = origin && allowed.has(origin) ? {'Access-Control-Allow-Origin':origin,Vary:'Origin'} : {};
  const reply = (reason,status,diagnostic={},retryAfterSeconds) => new Response(JSON.stringify({reason,
    ...diagnostic,...(retryAfterSeconds ? {retryAfterSeconds} : {}),message:'圖片暫時無法載入，請稍後重試。'}),
    {status,headers:{...headers,...cors,'Content-Type':'application/json; charset=utf-8',
      ...(status===429 ? {'Retry-After':String(retryAfterSeconds || 60)} : {})}});
  if (origin && !allowed.has(origin)) return reply('invalid_origin',403);
  if (request.method === 'OPTIONS') return new Response(null,{status:204,headers:{...headers,...cors,
    'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'}});
  if (request.method !== 'POST') return reply('invalid_method',405);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const minute = Math.floor(Date.now()/60000), previous = buckets.get(ip);
  if (previous?.minute === minute && previous.count >= 120) return reply('rate_limited',429);
  if (buckets.size > 4096) buckets.clear();
  buckets.set(ip,{minute,count:previous?.minute === minute ? previous.count+1 : 1});
  if (env.PREVIEW_IMAGE_LIMITER && !(await env.PREVIEW_IMAGE_LIMITER.limit({key:ip})).success) {
    return reply('rate_limited',429);
  }
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return reply('invalid_payload',415);
  }
  try {
    const reader = request.body?.getReader();
    if (!reader) return reply('invalid_payload',400);
    const parts = []; let size = 0;
    try {
      while (true) {
        const {done,value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16384) return reply('invalid_payload',413);
        parts.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size); let at = 0;
    for (const part of parts) { bytes.set(part,at); at += part.byteLength; }
    const {url,platform} = JSON.parse(new TextDecoder().decode(bytes));
    const image = await fetchPreviewImage(url,platform);
    return new Response(image.bytes,{headers:{...headers,...cors,'Content-Type':image.mime,
      'Content-Length':String(image.bytes.byteLength),
      'X-SharedMark-Image-Outcome':'validated_image', 'X-SharedMark-Source-Status':'200','X-SharedMark-Thumb-Source':'live',
      ...(cors['Access-Control-Allow-Origin'] ? {'Access-Control-Expose-Headers':
        'X-SharedMark-Image-Outcome, X-SharedMark-Source-Status, X-SharedMark-Thumb-Source'} : {})}});
  } catch (error) {
    return error instanceof PreviewImageFailure ?
      reply(error.reason,error.status,error.sourceDiagnostic,error.retryAfterSeconds) : reply('invalid_payload',400);
  }
}
