// Stable public-post photo indirection. Metadata lives only in the shared
// bounded coordinator; validated image bytes are returned once and never saved.
import {coordinatedPreview,photoSource,photoIdentity} from './preview.js';
import {fetchPreviewImage,PreviewImageFailure} from './preview-image.js';

const buckets=new Map();
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer'};
export class PreviewPhotoFailure extends Error {
  constructor(status,reason,detail={},photoStage='selection') {
    super(reason);this.status=status;this.reason=reason;this.detail={...detail,photoStage};
  }
}

export async function resolvePreviewPhoto(value,id,{coordinator=coordinatedPreview,fetcher=fetch}={}) {
  const source=photoSource(value);
  if (!source || typeof id!=='string' || !/^[a-f0-9]{32}$/.test(id)) {
    throw new PreviewPhotoFailure(400,'invalid_source');
  }
  const wait=coordinator.sourceCooldown(source.platform);
  if (wait>0) throw new PreviewPhotoFailure(429,'rate_limited',{cooldown:true,retryAfterSeconds:wait},'source');
  const preview=await coordinator(source.url,fetcher);
  if (preview.status!=='available') {
    throw new PreviewPhotoFailure(preview.reason==='rate_limited' ? 429 : 502,
      preview.reason || 'source_unavailable',{
        ...(preview.sourceHttpStatus ? {sourceHttpStatus:preview.sourceHttpStatus} : {}),
        ...(preview.sourceOutcome ? {sourceOutcome:preview.sourceOutcome} : {}),
        ...(preview.retryAfterSeconds ? {retryAfterSeconds:preview.retryAfterSeconds} : {}),
        ...(preview.cooldown ? {cooldown:true} : {})},'source');
  }
  // Compare IDs across the latest complete/partial manifest. Never map by index:
  // omitted, reordered or deleted album items cannot select a different photo.
  const candidates=[...new Set([...(preview.images || []),...(preview.media || []).flatMap(item=>
    item.type==='image' ? [item.url] : item.type==='video' && item.thumbnailUrl ? [item.thumbnailUrl] : [])])];
  let image;
  for (const candidate of candidates) {
    if (await photoIdentity(source.url,candidate)===id) {image=candidate;break;}
  }
  if (!image) throw new PreviewPhotoFailure(404,candidates.length ? 'media_changed' : 'media_unavailable');
  // A concurrent photo/source request may have latched a provider cooldown while
  // this request awaited parsing or hashing. Recheck before touching the CDN.
  const remaining=coordinator.sourceCooldown(source.platform);
  if (remaining>0) throw new PreviewPhotoFailure(429,'rate_limited',{cooldown:true,retryAfterSeconds:remaining},'source');
  try {return await fetchPreviewImage(image,source.platform,fetcher);}
  catch (error) {
    if (!(error instanceof PreviewImageFailure)) throw error;
    if (error.reason==='rate_limited') coordinator.limitSource(source.platform,error.retryAfterSeconds);
    // Unknown signing formats may expire before the metadata TTL. Drop only
    // this post's metadata for a later explicit/bounded refresh; never retry the
    // source or CDN inside the failed request or clear other photo/device bytes.
    if ([403,404].includes(error.sourceDiagnostic?.sourceHttpStatus)) coordinator.invalidate(source.url);
    throw new PreviewPhotoFailure(error.status,error.reason,{
      ...error.sourceDiagnostic,...(error.retryAfterSeconds ? {retryAfterSeconds:error.retryAfterSeconds} : {})},'image');
  }
}

export async function onRequest({request,env={}}) {
  const target=new URL(request.url),origin=request.headers.get('Origin');
  const allowed=new Set([target.origin,...(env.PREVIEW_ALLOWED_ORIGINS || '').split(',').map(value=>value.trim())]);
  const cors=origin && allowed.has(origin) ? {'Access-Control-Allow-Origin':origin,Vary:'Origin'} : {};
  const reply=(reason,status,detail={})=>new Response(JSON.stringify({reason,photoStage:'selection',...detail,
    message:reason==='media_changed' ? '來源照片已更新，請更新預覽。' : '圖片暫時無法載入，仍可開啟原文。'}),
    {status,headers:{...headers,...cors,'Content-Type':'application/json; charset=utf-8',
      ...(status===429 ? {'Retry-After':String(detail.retryAfterSeconds || 60)} : {})}});
  if (origin && !allowed.has(origin)) return reply('invalid_origin',403);
  if (request.method==='OPTIONS') return new Response(null,{status:204,headers:{...headers,...cors,
    'Access-Control-Allow-Methods':'GET, OPTIONS'}});
  if (request.method!=='GET') return reply('invalid_method',405);
  const params=target.searchParams;
  if (target.search.length>16384 || params.getAll('url').length!==1 || params.getAll('id').length!==1 ||
      [...params.keys()].some(key=>!['url','id'].includes(key)) ||
      !photoSource(params.get('url')) || !/^[a-f0-9]{32}$/.test(params.get('id') || '')) {
    return reply('invalid_source',400);
  }
  const ip=request.headers.get('CF-Connecting-IP') || 'local';
  const minute=Math.floor(Date.now()/60000),previous=buckets.get(ip);
  if (previous?.minute===minute && previous.count>=120) return reply('rate_limited',429);
  if (buckets.size>4096) buckets.clear();
  buckets.set(ip,{minute,count:previous?.minute===minute ? previous.count+1 : 1});
  for (const limiter of [env.PREVIEW_LIMITER,env.PREVIEW_IMAGE_LIMITER]) {
    if (limiter && !(await limiter.limit({key:ip})).success) return reply('rate_limited',429);
  }
  try {
    const image=await resolvePreviewPhoto(params.get('url'),params.get('id'));
    return new Response(image.bytes,{headers:{...headers,...cors,'Content-Type':image.mime,
      'Content-Length':String(image.bytes.byteLength),'X-SharedMark-Photo-Version':'1',
      'X-SharedMark-Image-Outcome':'validated_image','X-SharedMark-Source-Status':'200','X-SharedMark-Thumb-Source':'live',
      ...(origin && allowed.has(origin) ? {'Access-Control-Expose-Headers':
        'X-SharedMark-Photo-Version, X-SharedMark-Image-Outcome, X-SharedMark-Source-Status, X-SharedMark-Thumb-Source'} : {})}});
  } catch (error) {
    return error instanceof PreviewPhotoFailure ? reply(error.reason,error.status,error.detail) :
      reply('service_error',502,{photoStage:'source'});
  }
}
