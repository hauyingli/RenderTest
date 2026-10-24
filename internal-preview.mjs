import {createHash,timingSafeEqual} from 'node:crypto';
import {createPreviewCoordinator,resolvePreview,withPhotoEndpoints,photoSource} from './functions/api/preview.js';
import {resolvePreviewPhoto,PreviewPhotoFailure} from './functions/api/preview-photo.js';

const SECRET=/^[A-Za-z0-9_-]{64,256}$/;
const ID=/^[a-f0-9]{32}$/;
export function instagramSource(value){
 if(typeof value!=='string'||value.length>2048||/[\s\x00-\x1f\\%]/.test(value))return null;
 let u;try{u=new URL(value);}catch{return null;}
 if(!/^https:\/\/(?:www\.)?instagram\.com\//.test(value)||u.protocol!=='https:'||u.username||u.password||u.port||u.hash)return null;
 if(!/^\/(?:(?:[a-zA-Z0-9_.]+)\/)?(?:p|reel|reels|tv)\/[A-Za-z0-9_-]{1,128}\/?$/.test(u.pathname))return null;
 // Only plain canonical permalinks at this internal boundary. The CF caller
 // strips share tracking parameters before forwarding an already verified post.
 if(u.search||!photoSource(value))return null;
 return photoSource(value).url;
}
const digest=value=>createHash('sha256').update(value).digest();
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{
 'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',
 ...(status===429?{'Retry-After':String(value.retryAfterSeconds||60)}:{})}});
const classify=p=>p.reason==='rate_limited'?429:p.reason==='timeout'?504:502;
async function bodyJSON(request){
 if(!(request.headers.get('Content-Type')||'').toLowerCase().startsWith('application/json'))throw {status:415,reason:'invalid_content_type'};
 const reader=request.body?.getReader();if(!reader)throw {status:400,reason:'invalid_body'};
 const parts=[];let size=0;
 const signal=AbortSignal.timeout(5000);let listener;
 const expired=new Promise((_,reject)=>{listener=()=>reject({status:504,reason:'timeout'});signal.addEventListener('abort',listener,{once:true});});
 try{while(true){const {done,value}=await Promise.race([reader.read(),expired]);if(done)break;size+=value.length;
  if(size>4096)throw {status:413,reason:'request_too_large'};parts.push(value);}}
 finally{signal.removeEventListener('abort',listener);void reader.cancel().catch(()=>{});}
 try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw {status:400,reason:'invalid_body'};}
}
export function createInternalPreview({secret=process.env.RENDER_PREVIEW_SECRET,fetcher=fetch,now=Date.now,
 maxRequests=120,maxConcurrent=4,maxSourceRequests=12,sourceTimeoutMs=25000,requestTimeoutMs=30000}={}){
 let minute=-1,requests=0,active=0,sourceWindow=-1,sourceRequests=0;
 const images=new Map();
 const coordinator=createPreviewCoordinator({now,maxPending:maxConcurrent,resolver:async(value,transport,time)=>{
  const slot=Math.floor(now()/60000);if(slot!==sourceWindow){sourceWindow=slot;sourceRequests=0;}
  if(sourceRequests++>=maxSourceRequests)return {platform:'Instagram',status:'unavailable',reason:'rate_limited',retryAfterSeconds:60,images:[],media:[]};
  const signal=AbortSignal.timeout(sourceTimeoutMs);
  return resolvePreview(value,(url,options)=>transport(url,{...options,signal:AbortSignal.any([options.signal,signal])}),time);
 }});
 return async function internal(request){
  if(!SECRET.test(secret||''))return json({reason:'render_not_configured'},503);
  const candidate=request.headers.get('X-SharedMark-Render-Secret')||'';
  if(candidate.length>256||!timingSafeEqual(digest(candidate),digest(secret)))return json({reason:'unauthorized'},401);
  // No browser clients/CORS, even if somebody knows the TEST_KEY.
  if(request.headers.has('Origin'))return json({reason:'invalid_origin'},403);
  const url=new URL(request.url);
  if(request.method!=='POST')return json({reason:'invalid_method'},405);
  if(url.search||!['/internal/preview','/internal/photo'].includes(url.pathname))return json({reason:'invalid_request'},400);
  const slot=Math.floor(now()/60000);if(slot!==minute){minute=slot;requests=0;}
  if(++requests>maxRequests||active>=maxConcurrent)return json({reason:'rate_limited',retryAfterSeconds:60},429);
  active++;
  const deadline=AbortSignal.timeout(requestTimeoutMs);
  const transport=(url,options)=>fetcher(url,{...options,signal:AbortSignal.any([options.signal,deadline,request.signal])});
  try{
   const body=await bodyJSON(request),photo=url.pathname==='/internal/photo';
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['url',...(photo?['id']:[])].includes(k)))return json({reason:'invalid_source'},400);
   const source=instagramSource(body.url);
   if(!source||photo&&!ID.test(body.id||''))return json({reason:'invalid_source'},400);
   if(!photo){
    const result=await coordinator(source,transport);
    const full=await withPhotoEndpoints(result);
    const text=JSON.stringify(full);if(Buffer.byteLength(text)>262144)return json({reason:'invalid_preview'},502);
    return json(full,result.status==='available'?200:classify(result));
   }
   // Coalesce identical concurrent downloads; no permanent bytes stored here.
   const key=source+'\n'+body.id;
   let pending=images.get(key);
   if(!pending){pending=resolvePreviewPhoto(source,body.id,{coordinator,fetcher:transport}).finally(()=>images.delete(key));images.set(key,pending);}
   const image=await pending;
   return new Response(image.bytes,{headers:{'Content-Type':image.mime,'Content-Length':String(image.bytes.byteLength),
    'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-SharedMark-Image-Outcome':'validated_image',
    'X-SharedMark-Source-Status':'200','X-SharedMark-Thumb-Source':'live'}});
  }catch(error){
   if(error instanceof PreviewPhotoFailure)return json({reason:error.reason,...error.detail},error.status);
   if(error?.status&&error?.reason)return json({reason:error.reason},error.status);
   return json({reason:deadline.aborted||request.signal.aborted||['AbortError','TimeoutError'].includes(error?.name)?'timeout':'service_error'},deadline.aborted||request.signal.aborted||['AbortError','TimeoutError'].includes(error?.name)?504:502);
  }finally{active--;}
 };
}
