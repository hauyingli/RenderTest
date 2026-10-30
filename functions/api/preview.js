// 社群預覽僅解析匿名公開 HTML 的貼文 JSON／OG；不執行頁面腳本。
const HOSTS = new Set(['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net',
  'instagram.com', 'www.instagram.com', 'youtube.com', 'www.youtube.com', 'youtu.be']);
const buckets = new Map();
export const PREVIEW_SOURCE_TIMEOUT_MS = 25000;
export function cancelPreviewBody(response) {
  try { void response.body?.cancel().catch(()=>{}); } catch (_) { /* Already locked/closed. */ }
}
export function awaitPreviewSignal(work, signal) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(signal.reason || new DOMException('Timeout', 'TimeoutError'));
    const abort = () => { signal.removeEventListener('abort', abort); fail(); };
    signal.addEventListener('abort', abort, {once:true});
    Promise.resolve(work).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        if (value?.body?.cancel) cancelPreviewBody(value);
        fail();
      } else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}
const headers = {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'private, no-store',
  'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer'};
// Workers 不支援 redirect:error，舊相容日期亦不支援 cache:no-store。
// 一律手動檢查跳轉；Cloudflare 各狀態負 TTL 禁止建立來源回應快取。
function requestOptions(accept) {
  return {redirect:'manual', signal:AbortSignal.timeout(8000),
    cf:{cacheTtlByStatus:{'100-599':-1}},
    // 清楚識別 App；不偽裝 Chrome／Safari，也不攜帶登入 Cookie。
    headers:{Accept:accept, 'User-Agent':'SharedMark/0.4 (+https://sharedmark.pages.dev)',
      'Cache-Control':'no-store', Pragma:'no-cache'}};
}
class PreviewFailure extends Error {
  constructor(reason, retryAfterSeconds, sourceDiagnostic) {
    super(reason); this.reason = reason; this.retryAfterSeconds = retryAfterSeconds;
    this.sourceDiagnostic = sourceDiagnostic;
  }
}
export function retrySeconds(value, now = Date.now()) {
  if (/^\d+$/.test(value || '')) {
    const seconds=Number(value);
    return Number.isSafeInteger(seconds) && seconds<=2147483647 ? Math.max(60,seconds) : 86400;
  }
  const date = value ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.min(2147483647,Math.max(60,Math.ceil((date-now)/1000))) : 60;
}
export function sourceURL(value) {
  if (typeof value !== 'string' || value.length > 4000 || /[\s\x00-\x1f]/.test(value)) throw Error('url');
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !HOSTS.has(u.hostname)) throw Error('url');
  u.hash = '';
  return u;
}
async function boundedJSON(response) {
  if (!response.ok || !response.headers.get('content-type')?.includes('json')) {
    await response.body?.cancel();
    throw new PreviewFailure(response.status === 429 ? 'rate_limited' :
      response.status >= 500 ? 'provider_error' : 'source_unavailable',
      response.status === 429 ? retrySeconds(response.headers.get('retry-after')) : undefined);
  }
  const reader = response.body.getReader(); let bytes = 0; const parts = [];
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 262144) throw Error('size');
      parts.push(value);
    }
  } catch (error) { await reader.cancel(); throw error; }
  const data = new Uint8Array(bytes); let at = 0;
  for (const part of parts) { data.set(part, at); at += part.length; }
  return JSON.parse(new TextDecoder().decode(data));
}

// 僅解碼 metadata 屬性的必要實體，解碼後仍須通過 URL 白名單。
function attributeText(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (match, entity) => {
    if (entity[0] !== '#') return {amp:'&', quot:'"', apos:"'", lt:'<', gt:'>'}[entity.toLowerCase()];
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2),16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}
export function coverURL(value, platform) {
  try {
    if (typeof value !== 'string' || value.length > 8000 || /[\s\x00-\x1f]/.test(value)) return null;
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    const domains = ['Threads','Instagram'].includes(platform) ? ['fbcdn.net','cdninstagram.com'] :
      platform === 'YouTube' ? ['ytimg.com'] : [];
    return domains.some(host => u.hostname.endsWith('.' + host)) ? u.href : null;
  } catch (_) { return null; }
}

// Stable photo routes bind an opaque CDN object to one public post, never an
// album index. Only known expiry/signature/routing fields are ignored; content
// transformations (stp/efg) and unknown query fields remain part of identity.
export function photoSource(value) {
  try {
    const url=sourceURL(value), thread=threadPost(url), instagram=instagramPost(url);
    const target=thread || instagram;
    if (!target) return null;
    url.search='';url.hash='';
    return {url:url.href,platform:thread ? 'Threads' : 'Instagram',
      key:`${thread ? 'threads' : 'instagram'}:${target.code}`};
  } catch (_) {return null;}
}
export async function photoIdentity(source,value) {
  const post=photoSource(source);
  const allowed=post && coverURL(value,post.platform);
  if (!allowed) return null;
  const url=new URL(allowed), query=[...url.searchParams].filter(([key])=>
    !/^_nc_/i.test(key) && !['oe','oh','ccb','ig_cache_key','edm'].includes(key.toLowerCase()));
  query.sort(([ak,av],[bk,bv])=>ak<bk ? -1 : ak>bk ? 1 : av<bv ? -1 : av>bv ? 1 : 0);
  const identity=`image\n${post.key}\n${url.pathname}?${new URLSearchParams(query)}`;
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identity));
  return [...new Uint8Array(digest).subarray(0,16)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
export async function withPhotoEndpoints(result) {
  if (result.status!=='available' || !photoSource(result.canonicalUrl)) return result;
  const endpoint=async value=>{
    const id=await photoIdentity(result.canonicalUrl,value);
    return id ? '/api/preview-photo?'+new URLSearchParams({url:photoSource(result.canonicalUrl).url,id}) : null;
  };
  const images=await Promise.all((result.images || []).map(endpoint));
  const media=await Promise.all((result.media || []).map(async item=>{
    const photo=item.type==='image' ? await endpoint(item.url) :
      item.type==='video' && item.thumbnailUrl ? await endpoint(item.thumbnailUrl) : null;
    return {...item,...(photo ? {[item.type==='image' ? 'photoUrl' : 'thumbnailPhotoUrl']:photo} : {})};
  }));
  // Add a versioned ordered contract without changing the old CDN fields.
  // Partial galleries expose parsed count only, never a fabricated total.
  const referenced=result.mediaScope==='referenced_post';
  const ordered=referenced?[]:media.length ? media : (result.images || []).map((url,index)=>({type:'image',url,photoUrl:images[index]}));
  const mediaItems=await Promise.all(ordered.map(async(item,at)=>{
    const type=result.mediaTypes?.[at] || item.type;
    const photo=item.photoUrl || item.thumbnailPhotoUrl || null;
    const id=photo ? new URL(photo,'https://preview.invalid').searchParams.get('id') :
      await photoIdentity(result.canonicalUrl,item.url);
    return {id,index:result.mediaIndices?.[at] ?? at,type,
      imageUrl:photo,posterUrl:type==='video'?photo:null,
      videoUrl:type==='video' && item.type==='video'?item.url:null};
  }));
  const complete=result.galleryStatus==='available' && !referenced;
  return {...result,photoVersion:1,mediaVersion:2,imagePhotoUrls:images,media,mediaItems,
    parsedMediaCount:mediaItems.length,totalMediaCount:complete?mediaItems.length:null,
    mediaComplete:complete,mediaPattern:mediaItems.map(item=>item.type==='video'?'v':'i').join(''),
    coverPhotoUrl:referenced?null:mediaItems.find(item=>item.imageUrl)?.imageUrl || images.find(Boolean) || null};
}

function opaqueImageName(pathname) {
  const filename = pathname.split('/').pop();
  return /^\d+(?:_\d+)+_[a-z]\.(?:jpe?g|png|webp)$/i.test(filename) ? filename : null;
}
function profileImage(value, profiles) {
  const url = new URL(value);
  // Public Threads profile images use the -19 image family, including newer
  // t51.82787 variants. Size, aspect ratio and query parameters are not evidence
  // that an image belongs to the post (a real post photo may also be square).
  return /\/(?:t51\.\d+-19)\//.test(url.pathname) ||
    profiles.has(url.pathname) || profiles.has(opaqueImageName(url.pathname));
}
function postImageURL(value, profiles = new Set()) {
  const url = coverURL(value, 'Threads');
  return url && !profileImage(url, profiles) ? url : null;
}
function progressiveVideoURL(value) {
  const url = coverURL(value, 'Threads');
  return url && /\.mp4$/i.test(new URL(url).pathname) ? url : null;
}
function rememberProfileImages(record, profiles) {
  for (const value of [record.profile_pic_url, record.profile_pic_url_hd, record.profile_image_uri,
    record.hd_profile_pic_url_info?.url,
    ...(Array.isArray(record.hd_profile_pic_versions) ? record.hd_profile_pic_versions.slice(0,100).map(item=>item?.url) : [])]) {
    const allowed = coverURL(value, 'Threads');
    if (!allowed) continue;
    const url = new URL(allowed);
    profiles.add(url.pathname);
    const filename = opaqueImageName(url.pathname);
    if (filename) profiles.add(filename);
  }
}

// 僅讀真正 head 內的 meta；註解、script、style、title 內的假標籤不算 metadata。
// OG 是公開結構化貼文資料無法取得時的媒體備援，不嘗試登入或限制頁面。
function postMetadataFromHead(html, canonical, tags, profiles, samePost) {
  let inside = false, source = null, title = '', excerpt = '', currentImage = -1, currentVideo = -1;
  const images = [], videos = [];
  for (const [tag] of tags) {
    if (/^<head\b/i.test(tag)) { inside = true; continue; }
    if (!inside) continue;
    if (/^<\/head\s*>/i.test(tag)) {
      try {
        const target = sourceURL(source);
        // 必須明確指向同一篇貼文，不能把登入頁或平台預設圖當作成功封面。
        if (!samePost(target,canonical)) return null;
        const media = [], seen = new Set();
        for (const video of videos) {
          // OG players/embeds and manifests are not progressive video sources.
          const url = progressiveVideoURL(video.url);
          if (!url || (video.mime && video.mime !== 'video/mp4')) continue;
          const parsed = new URL(url), identity = parsed.origin + parsed.pathname;
          if (seen.has(identity)) continue;
          seen.add(identity);
          const poster = images[video.imageIndex] || (videos.length === 1 ? images.find(Boolean) : null);
          media.push({type:'video',url,...(poster ? {thumbnailUrl:poster} : {})});
        }
        return {images:[...new Set(images.filter(Boolean))].slice(0,20), title, excerpt,
          ...(media.length ? {media} : {})};
      } catch (_) { return null; }
    }
    if (/^<body\b/i.test(tag)) return null;
    if (!/^<meta\s/i.test(tag)) continue;
    const attr = attributes(tag);
    const property = attr.get('property')?.toLowerCase();
    if (property === 'og:url' && source === null) source = attr.get('content');
    // 僅使用公開標準預覽的短文字，供當次自訂介面顯示，不保存全文。
    if (property === 'og:title' && !title) title = (attr.get('content') || '').trim().slice(0,500);
    if (property === 'og:description' && !excerpt) excerpt = (attr.get('content') || '').trim().slice(0,600);
    if (['og:image','og:image:url'].includes(property) && images.length < 20) {
      currentImage = images.length;
      images.push(postImageURL(attr.get('content'), profiles));
    } else if (property === 'og:image:secure_url' && currentImage >= 0 && !images[currentImage]) {
      // secure_url 是前一張的替代網址，不可把相同圖片的不同版本當成多圖。
      images[currentImage] = postImageURL(attr.get('content'), profiles);
    } else if (['og:video','og:video:url'].includes(property) && videos.length < 20) {
      const url=attr.get('content'), previous=videos[currentVideo];
      const progressive=progressiveVideoURL(url), prior=progressiveVideoURL(previous?.url);
      if (property === 'og:video:url' && previous && (!prior || progressive &&
          new URL(progressive).pathname === new URL(prior).pathname)) {
        // :url aliases the current video; signed URL variants are one item.
        if (!prior) previous.url=url;
      } else {
        currentVideo = videos.length;
        videos.push({url, imageIndex:currentImage});
      }
    } else if (property === 'og:video:secure_url') {
      if (currentVideo < 0 && videos.length < 20) {
        currentVideo = videos.length;
        videos.push({url:attr.get('content'), imageIndex:currentImage});
      } else if (currentVideo >= 0 && !progressiveVideoURL(videos[currentVideo].url)) {
        videos[currentVideo].url = attr.get('content');
      }
    } else if (property === 'og:video:type' && currentVideo >= 0) {
      videos[currentVideo].mime = (attr.get('content') || '').trim().toLowerCase();
    }
  }
  return null;
}
export function threadMetadataFromHead(html, canonical, tags = pageTags(html), profiles = new Set()) {
  return postMetadataFromHead(html,canonical,tags,profiles,(target,post)=>
    THREAD_HOSTS.has(target.hostname) && target.pathname.replace(/\/$/,'') === post.pathname.replace(/\/$/,''));
}

// Public HTML only: no provider API, credentials, browser impersonation or script execution.
const THREAD_HTML_MAX_BYTES = 3 * 1024 * 1024;
const THREAD_HOSTS = new Set(['threads.com','www.threads.com','threads.net','www.threads.net']);
function threadPost(value) {
  try {
    const url = sourceURL(value instanceof URL ? value.href : value);
    if (!THREAD_HOSTS.has(url.hostname)) return null;
    const match = url.pathname.match(/^\/(?:@([a-z0-9_.]+)\/post\/|t\/)([\w-]+)\/?$/i);
    return match ? {url, username:match[1]?.toLowerCase(), code:match[2]} : null;
  } catch (_) { return null; }
}
function sameThreadPost(a,b) {
  const left=threadPost(a), right=threadPost(b);
  return !!(left && right && left.code === right.code &&
    (!left.username || !right.username || left.username === right.username));
}
function cleanThreadURL(url) {
  const result = new URL(url.href); result.search=''; result.hash=''; return result;
}
function attributes(tag) {
  const result = new Map();
  const space=ch=>' \t\r\n\f'.includes(ch);
  let at=0;
  if (tag[0]==='<') {
    at=1;while(at<tag.length && !space(tag[at]) && tag[at]!=='>') at++;
  }
  while(at<tag.length) {
    while(at<tag.length && (space(tag[at]) || '/>'.includes(tag[at]))) at++;
    const start=at;
    while(at<tag.length && !space(tag[at]) && !'=\'/"<>'.includes(tag[at])) at++;
    if(at===start){at++;continue;}
    const key=tag.slice(start,at).toLowerCase();
    while(at<tag.length && space(tag[at]))at++;
    if(tag[at]!=='=')continue;
    at++;while(at<tag.length && space(tag[at]))at++;
    const quote=['"',"'"].includes(tag[at]) ? tag[at++] : null, begin=at;
    if(quote){while(at<tag.length && tag[at]!==quote)at++;}
    else{while(at<tag.length && !space(tag[at]) && tag[at]!=='>')at++;}
    if(!result.has(key))result.set(key,attributeText(tag.slice(begin,at)));
    if(quote)at++;
  }
  return result;
}
// Linear scans avoid regex backtracking on malformed upstream tags/attributes.
// Comments/raw-text elements are consumed as a whole; their fake tags are ignored.
function* pageTags(html) {
  const lower=html.toLowerCase();let at=0,count=0;
  while(at<html.length) {
    const start=html.indexOf('<',at);if(start<0)return;
    if(html.startsWith('<!--',start)){
      const end=html.indexOf('-->',start+4);if(end<0)return;at=end+3;continue;
    }
    let cursor=start+1;
    const closing=html[cursor]==='/';if(closing)cursor++;
    const begin=cursor;
    while(cursor<html.length && /[a-z0-9:-]/i.test(html[cursor]))cursor++;
    if(cursor===begin || !/[a-z]/i.test(html[begin])){at=start+1;continue;}
    const name=lower.slice(begin,cursor), attrStart=cursor;
    let quote=null;
    while(cursor<html.length && cursor-start<=65536){
      const ch=html[cursor];
      if(quote){if(ch===quote)quote=null;}
      else if(ch==='"' || ch==="'")quote=ch;
      else if(ch==='>')break;
      cursor++;
    }
    if(cursor>=html.length || cursor-start>65536)return;
    at=cursor+1;const tag=html.slice(start,at);
    if(!closing && ['script','style','title','textarea'].includes(name)){
      let close=lower.indexOf('</'+name,at);
      while(close>=0 && !/[\s>]/.test(html[close+name.length+2] || ''))close=lower.indexOf('</'+name,close+2);
      if(close<0)return;
      const end=html.indexOf('>',close+name.length+2);if(end<0)return;
      yield [tag,name,html.slice(attrStart,cursor),html.slice(at,close)];at=end+1;
    }else yield [tag];
    if(++count>=60000)return;
  }
}
function pageCanonical(html,tags=pageTags(html)) {
  let inside=false, link;
  for (const [tag] of tags) {
    if (/^<head\b/i.test(tag)) {inside=true;continue;}
    if (!inside) continue;
    if (/^<\/(?:head)\s*>|^<body\b/i.test(tag)) break;
    if (/^<meta\s/i.test(tag)) {
      const attr=attributes(tag);
      if (attr.get('property')?.toLowerCase()==='og:url') return attr.get('content') || '';
    } else if (/^<link\s/i.test(tag)) {
      const attr=attributes(tag);
      if (attr.get('rel')?.toLowerCase()==='canonical') link=attr.get('href');
    }
  }
  return link;
}
function bestCandidate(candidates,record,profiles) {
  if (!Array.isArray(candidates)) return null;
  const valid=candidates.slice(0,100).flatMap(candidate=>{
    const url=postImageURL(candidate?.url,profiles);
    return url ? [{url,width:Number(candidate.width)||0,height:Number(candidate.height)||0}] : [];
  });
  const ratio=Number(record.original_width)/Number(record.original_height);
  const sameAspect=valid.filter(value=>value.width>0 && value.height>0 &&
    Number.isFinite(ratio) && Math.abs(value.width/value.height-ratio)/ratio<0.03);
  return (sameAspect.length ? sameAspect : valid).sort((a,b)=>b.width*b.height-a.width*a.height)[0]?.url || null;
}
function recordMedia(record,profiles) {
  const poster=bestCandidate(record.image_versions2?.candidates,record,profiles);
  // A video record without a progressive source stays a poster; never fetch DASH/DRM.
  if (record.media_type===2 || Array.isArray(record.video_versions) && record.video_versions.length) {
    const versions=Array.isArray(record.video_versions) ?
      record.video_versions.slice(0,100).filter(value=>progressiveVideoURL(value?.url)) : [];
    const url=bestCandidate(versions,record,profiles);
    return url ? {type:'video',url,...(poster ? {thumbnailUrl:poster} : {})} :
      poster ? {type:'image',url:poster} : null;
  }
  return poster ? {type:'image',url:poster} : null;
}
function restrictedRecord(record) {
  return record.user?.text_post_app_is_private === true || record.user?.is_private === true ||
    record.is_private === true || record.is_internal_only === true || record.is_fb_only === true ||
    record.text_post_app_info?.is_post_unavailable === true;
}
function recordGallery(record,profiles) {
  const children=Array.isArray(record.carousel_media) ? record.carousel_media : [record];
  const media=[],indices=[],types=[],seen=new Set(); let failed=children.length>20, blocked=false;
  for (const [index,child] of children.slice(0,20).entries()) {
    if (child && typeof child==='object' && restrictedRecord(child)) {
      failed=true;blocked=true;continue;
    }
    const item=child && typeof child==='object' ? recordMedia(child,profiles) : null;
    if (!item) {failed=true;continue;}
    if (!seen.has(item.url)) {seen.add(item.url);media.push(item);indices.push(index);
      types.push(child.media_type===2 || item.type==='video'?'video':'image');}
    else failed=true;
    if (item.type==='image' && child.media_type===2) failed=true;
  }
  return {media,indices,types,failed,blocked};
}
function sharedGallery(record,profiles) {
  const share=record.text_post_app_info?.share_info;
  if (!share || typeof share!=='object') return null;
  if (share.quoted_attachment_post_unavailable === true) return {media:[],failed:true,blocked:true};
  // Only explicit attachments of the matched post qualify. Never select a
  // recommended post or search arbitrary descendants for someone else's media.
  for (const key of ['quoted_post','quoted_attachment_post','reposted_post']) {
    const child=share[key];
    if (!child || typeof child!=='object') continue;
    if (restrictedRecord(child)) return {media:[],failed:true,blocked:true};
    if (!(child.code || child.pk || child.id) || !child.user || typeof child.user!=='object' ||
        !(child.image_versions2 || child.video_versions || child.carousel_media)) continue;
    const gallery=recordGallery(child,profiles);
    if (gallery.media.length || gallery.blocked) return {...gallery,referencedPost:true};
  }
  return null;
}
function isTargetRecord(record,target) {
  if (record.code!==target.code && ![record.canonical_url,record.permalink].some(value=>
      typeof value==='string' && value && sameThreadPost(value,target.url))) return false;
  if (record.code && record.code!==target.code) return false;
  if (record.user?.username && target.username &&
      (typeof record.user.username!=='string' || record.user.username.toLowerCase()!==target.username)) return false;
  for (const value of [record.canonical_url,record.permalink]) {
    if (typeof value==='string' && value && !sameThreadPost(value,target.url)) return false;
  }
  return true;
}

function restrictedPage(tags) {
  let insideHead=false;
  for (const [tag,name,,text] of tags) {
    if (/^<head\b/i.test(tag)) insideHead=true;
    if (/^<\/head\s*>/i.test(tag)) insideHead=false;
    if (insideHead && name?.toLowerCase()==='title' &&
        /^\s*(?:just a moment|log ?in|sign ?in|checkpoint|access denied)\b/i.test(attributeText(text))) return true;
    if (/^<form\s/i.test(tag) && attributes(tag).get('id')==='challenge-form') return true;
  }
  return false;
}

function publicRecords(tags, matches) {
  const records=[],profiles=new Set(); let nodes=0, limited=false;
  for (const [,name,attrs,text] of tags) {
    if (name?.toLowerCase()!=='script') continue;
    const roots=[];
    if (attributes(attrs).get('type')?.toLowerCase()==='application/json') {
      try { roots.push(JSON.parse(text)); } catch (_) { /* malformed metadata */ }
    }
    // Public embed pages wrap their JSON in a JS call. Decode only the literal
    // contextJSON value; never evaluate scripts or execute the surrounding call.
    for (const match of text.matchAll(/"contextJSON"\s*:\s*("(?:\\.|[^"\\])*")/g)) {
      try { roots.push(JSON.parse(JSON.parse(match[1]))); } catch (_) { /* malformed embed */ }
    }
    const stack=roots.map(value=>({value,depth:0}));
    while (stack.length) {
      const {value,depth}=stack.pop();
      if (++nodes>60000) {limited=true;break;}
      if (!value || typeof value!=='object') continue;
      rememberProfileImages(value,profiles);
      if (matches(value)) records.push(value);
      if (depth>=60) continue;
      for (const child of Object.values(value)) {
        if (stack.length + nodes >= 60000) {limited=true;break;}
        if (child && typeof child==='object') stack.push({value:child,depth:depth+1});
      }
    }
    if (limited) break;
  }
  return {records,profiles,limited};
}

export function threadPageData(html,requested) {
  if (typeof html!=='string' || new TextEncoder().encode(html).length>THREAD_HTML_MAX_BYTES) return null;
  const target=threadPost(requested);
  if (!target) return null;
  const tags=[...pageTags(html)];
  const identity=pageCanonical(html,tags);
  if (identity && !sameThreadPost(identity,target.url)) return null;
  // Stop at explicit login/challenge responses; never solve, retry or switch identity.
  if (restrictedPage(tags)) return null;
  const canonical=cleanThreadURL(identity && threadPost(identity) ? new URL(identity) : target.url);
  const {records,profiles,limited}=publicRecords(tags,value=>isTargetRecord(value,target));
  // A target record explicitly marked restricted cannot be replaced by its OG cover.
  if (records.some(restrictedRecord)) return null;
  const metadata=threadMetadataFromHead(html,canonical,tags,profiles);
  let best=null, fallbackBlocked=false;
  for (const record of records) {
    if (!(record.image_versions2 || record.video_versions || record.carousel_media || record.caption || record.text_post_app_info)) continue;
    let gallery=recordGallery(record,profiles);
    if (!gallery.media.length && !gallery.blocked) gallery=sharedGallery(record,profiles) || gallery;
    fallbackBlocked ||= gallery.blocked;
    if (!best || gallery.media.length>best.media.length) best={record,...gallery};
  }
  const media=best?.media.length ? best.media : fallbackBlocked ? [] :
    metadata?.media || (metadata?.images || []).map(url=>({type:'image',url}));
  if (!best && !metadata) return null;
  const record=best?.record;
  return {parserVersion:3,canonicalUrl:canonical.href,media,
    ...(best?.referencedPost?{mediaScope:'referenced_post'}:{}),
    ...(best?.media.length?{mediaIndices:best.indices,mediaTypes:best.types}:{}),
    images:[...new Set(media.map(item=>item.type==='image' ? item.url : item.thumbnailUrl).filter(Boolean))],
    imageSource:best?.media.length ? 'public_page' : media.length ? 'open_graph' : 'none',
    galleryStatus:best?.media.length ? best.failed || limited ? 'partial' : 'available' : 'not_supported',
    title:metadata?.title || '',
    author:(typeof record?.user?.username==='string' ? '@'+record.user.username : target.username ? '@'+target.username : '').slice(0,300),
    excerpt:(typeof record?.caption?.text==='string' ? record.caption.text : metadata?.excerpt || '').trim().slice(0,600)};
}

const INSTAGRAM_HOSTS = new Set(['instagram.com','www.instagram.com']);
function instagramPost(value) {
  try {
    const url=sourceURL(value instanceof URL ? value.href : value);
    if (!INSTAGRAM_HOSTS.has(url.hostname)) return null;
    const match=url.pathname.match(/^\/(?:(?:([a-z0-9_.]+)\/)?(?:p|reel|reels|tv))\/([\w-]+)\/?$/i);
    if (match?.[1]?.toLowerCase()==='share') return null;
    return match ? {url,username:match[1]?.toLowerCase(),code:match[2]} : null;
  } catch (_) { return null; }
}
function sameInstagramPost(a,b) {
  const left=instagramPost(a),right=instagramPost(b);
  return !!(left && right && left.code===right.code &&
    (!left.username || !right.username || left.username===right.username));
}
function isInstagramRecord(record,target) {
  const codes=[record.code,record.shortcode].filter(value=>value!==undefined && value!==null);
  const links=[record.canonical_url,record.permalink,record.seo_canonical_url].filter(value=>typeof value==='string' && value);
  if (!codes.includes(target.code) && !links.some(value=>sameInstagramPost(value,target.url))) return false;
  if (codes.some(value=>value!==target.code) || links.some(value=>!sameInstagramPost(value,target.url))) return false;
  const username=record.user?.username || record.owner?.username;
  return !username || !target.username || typeof username==='string' && username.toLowerCase()===target.username;
}
function instagramMediaRecord(record) {
  const candidates=Array.isArray(record.image_versions2?.candidates) ? record.image_versions2.candidates :
    [...(Array.isArray(record.display_resources) ? record.display_resources.slice(0,100).map(value=>({
      url:value?.src,width:value?.config_width,height:value?.config_height})) : []),
    {url:record.display_url || record.display_src || record.thumbnail_src || record.display_uri,
      width:record.dimensions?.width,height:record.dimensions?.height}];
  const video=progressiveVideoURL(record.video_url);
  const versions=Array.isArray(record.video_versions) ? record.video_versions.slice(0,100).filter(value=>
    progressiveVideoURL(value?.url)) : [];
  return {...record,user:record.user || record.owner,
    original_width:record.original_width || record.dimensions?.width,
    original_height:record.original_height || record.dimensions?.height,
    media_type:record.is_video===true || record.__typename==='GraphVideo' ? 2 : record.media_type,
    image_versions2:{candidates},
    video_versions:versions.length ? versions :
      video ? [{url:video,width:record.dimensions?.width,height:record.dimensions?.height}] : []};
}
function instagramCaption(record) {
  const value=record.caption?.text || record.edge_media_to_caption?.edges?.[0]?.node?.text;
  return typeof value==='string' ? value : '';
}
function instagramGallery(record,profiles) {
  let children;
  if (Array.isArray(record.carousel_media)) children=record.carousel_media;
  else if (Array.isArray(record.edge_sidecar_to_children?.edges)) {
    children=record.edge_sidecar_to_children.edges.slice(0,21).map(value=>value?.node);
  } else children=[record];
  return recordGallery({carousel_media:children.slice(0,21).map(value=>
    value && typeof value==='object' ? instagramMediaRecord(value) : null)},profiles);
}
export function instagramPageData(html,requested) {
  if (typeof html!=='string' || new TextEncoder().encode(html).length>THREAD_HTML_MAX_BYTES) return null;
  const target=instagramPost(requested);
  if (!target) return null;
  const tags=[...pageTags(html)],identity=pageCanonical(html,tags);
  if ((identity && !sameInstagramPost(identity,target.url)) || restrictedPage(tags)) return null;
  const canonical=cleanThreadURL(identity ? new URL(identity) : target.url);
  const canonicalTarget=instagramPost(canonical);
  const {records,profiles,limited}=publicRecords(tags,value=>isInstagramRecord(value,canonicalTarget));
  if (records.some(record=>restrictedRecord(instagramMediaRecord(record)) ||
      Object.hasOwn(record,'if_not_gated_logged_out') && record.if_not_gated_logged_out===null)) return null;
  const metadata=postMetadataFromHead(html,canonical,tags,profiles,sameInstagramPost);
  let best=null,fallbackBlocked=false;
  for (const record of records) {
    if (!(record.image_versions2 || record.video_versions || record.video_url || record.carousel_media ||
        record.edge_sidecar_to_children || record.display_url || record.display_src || record.display_uri ||
        record.display_resources || instagramCaption(record))) continue;
    const gallery=instagramGallery(record,profiles);
    fallbackBlocked ||= gallery.blocked;
    const videos=gallery.media.filter(value=>value.type==='video').length;
    const bestVideos=best?.media.filter(value=>value.type==='video').length || 0;
    if (!best || gallery.media.length>best.media.length || gallery.media.length===best.media.length &&
        (videos>bestVideos || videos===bestVideos && !instagramCaption(best.record) && instagramCaption(record))) {
      best={record,...gallery};
    }
  }
  const media=best?.media.length ? best.media : fallbackBlocked ? [] :
    metadata?.media || (metadata?.images || []).map(url=>({type:'image',url}));
  const record=best?.record;
  const excerpt=(record && instagramCaption(record) || metadata?.excerpt || '').trim().slice(0,600);
  // A generic platform/login shell with a canonical link is not a post preview.
  if (!media.length && !excerpt) return null;
  const username=record?.user?.username || record?.owner?.username || target.username;
  return {parserVersion:1,canonicalUrl:canonical.href,media,
    ...(best?.media.length?{mediaIndices:best.indices,mediaTypes:best.types}:{}),
    images:[...new Set(media.map(item=>item.type==='image' ? item.url : item.thumbnailUrl).filter(Boolean))],
    imageSource:best?.media.length ? 'public_page' : media.length ? 'open_graph' : 'none',
    galleryStatus:best?.media.length ? best.failed || limited ? 'partial' : 'available' : 'not_supported',
    title:metadata?.title || '',author:typeof username==='string' ? ('@'+username).slice(0,300) : '',excerpt};
}

async function boundedHTML(response) {
  if (response.status!==200 || !response.headers.get('content-type')?.toLowerCase().includes('text/html')) {
    await response.body?.cancel();
    throw new PreviewFailure(response.status===429 ? 'rate_limited' : response.status>=500 ? 'provider_error' : 'source_unavailable',
      response.status===429 ? retrySeconds(response.headers.get('retry-after')) : undefined,
      {sourceHttpStatus:response.status,sourceOutcome:response.status===200 ? 'unexpected_content_type' : 'http_error'});
  }
  if (Number(response.headers.get('content-length'))>THREAD_HTML_MAX_BYTES) {
    await response.body?.cancel();throw new PreviewFailure('source_unavailable',undefined,
      {sourceHttpStatus:response.status,sourceOutcome:'response_too_large'});
  }
  const reader=response.body?.getReader(); if (!reader) return '';
  const decoder=new TextDecoder(); let html='',bytes=0;
  try {
    while (true) {
      const {done,value}=await reader.read(); if (done) break;
      bytes+=value.byteLength;
      if (bytes>THREAD_HTML_MAX_BYTES) throw new PreviewFailure('source_unavailable',undefined,
        {sourceHttpStatus:response.status,sourceOutcome:'response_too_large'});
      html+=decoder.decode(value,{stream:true});
    }
    return html+decoder.decode();
  } catch (error) {
    if (error instanceof PreviewFailure) throw error;
    const timeout=['TimeoutError','AbortError'].includes(error?.name);
    throw new PreviewFailure(timeout ? 'timeout' : 'service_error',undefined,
      {sourceHttpStatus:response.status,sourceOutcome:timeout ? 'timeout' : 'network_error'});
  } finally {await reader.cancel().catch(()=>{});}
}

function publicPageRestricted(html,url,{post,matches}) {
  const tags=[...pageTags(html)];
  if (restrictedPage(tags)) return true;
  try {
    const canonical=sourceURL(pageCanonical(html,tags));
    if (/^\/(?:accounts\/login|challenge|checkpoint)(?:\/|$)/.test(canonical.pathname)) return true;
  } catch (_) { /* Missing or invalid canonical is a parse failure, not proof of a restriction. */ }
  const target=post(url);
  return target && publicRecords(tags,value=>matches(value,target)).records.some(record=>
    restrictedRecord(record) || restrictedRecord({user:record.owner}) ||
    Object.hasOwn(record,'if_not_gated_logged_out') && record.if_not_gated_logged_out===null);
}

async function publicPostPreview(initial,fetcher,{post,samePost,hosts,share,parse,matches}) {
  let url=initial;
  const initialPost=post(initial), deadline=AbortSignal.timeout(150000);
  for (let redirects=0; ; redirects++) {
    const options=requestOptions('text/html'); options.signal=deadline;
    let response;
    //try { response=await fetcher(url.href,options); }
    //   catch (error) {
    //   const timeout=deadline.aborted || ['TimeoutError','AbortError'].includes(error?.name);
    //   throw new PreviewFailure(timeout ? 'timeout' : 'service_error',undefined,
    //     {sourceOutcome:timeout ? 'timeout' : 'network_error'});
    //  }
    const fetchStart = performance.now();

    try {
      response = await fetcher(url.href, options);

      console.log('[IG FETCH DEBUG]', {
        status: response.status,
        elapsedMs: Math.round(performance.now() - fetchStart),
        redirectHop: redirects,
        contentType: response.headers.get('content-type')
      });

    } catch (error) {
      const timeout =
        deadline.aborted ||
        ['TimeoutError', 'AbortError'].includes(error?.name);

      console.log('[IG FETCH ERROR]', {
        timeout,
        elapsedMs: Math.round(performance.now() - fetchStart),
        errorType: error?.name
      });

      throw new PreviewFailure(
        timeout ? 'timeout' : 'service_error',
        undefined,
        { sourceOutcome: timeout ? 'timeout' : 'network_error' }
      );
    }

    if ([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel();
      if (redirects>=4) throw new PreviewFailure('source_unavailable',undefined,
        {sourceHttpStatus:response.status,sourceOutcome:'redirect_rejected'});
      const location=response.headers.get('location');

      let redirectType = 'none';

      try {
        if (location) {
          const target = new URL(location, url);

          if (/^\/accounts\/login(?:\/|$)/.test(target.pathname)) {
            redirectType = 'login';
          } else if (/^\/challenge(?:\/|$)/.test(target.pathname)) {
            redirectType = 'challenge';
          } else if (/^\/checkpoint(?:\/|$)/.test(target.pathname)) {
            redirectType = 'checkpoint';
          } else if (hosts.has(target.hostname)) {
            redirectType = 'same_platform_other_path';
          } else {
            redirectType = 'external_redirect';
          }
        } else {
          redirectType = 'missing_location';
        }
      } catch {
        redirectType = 'invalid_location';
      }

      console.log('[IG REDIRECT DEBUG]', {
        status: response.status,
        redirectType,
        redirectHop: redirects
      });



      let next;try {next=sourceURL(new URL(location || '',url).href);} catch (_) {
        throw new PreviewFailure('source_unavailable',undefined,{sourceHttpStatus:response.status,sourceOutcome:'redirect_rejected'});
      }
      if (!location || !hosts.has(next.hostname) ||
          !(post(next) || share.test(next.pathname)) ||
          initialPost && !samePost(next,initialPost.url)) {
        const restricted=/^\/(?:accounts\/login|challenge|checkpoint)(?:\/|$)/.test(next.pathname);
        throw new PreviewFailure('source_unavailable',undefined,{sourceHttpStatus:response.status,
          sourceOutcome:restricted ? 'access_redirect' : 'redirect_rejected'});
      }

      url=next; continue;
    }
    const html=await boundedHTML(response);
    if (!post(url)) {
      const canonical=pageCanonical(html);
      // A 200 short-link page may name the real public permalink; never execute JS redirects.
      if (!post(canonical)) throw new PreviewFailure('source_unavailable',undefined,
        {sourceHttpStatus:200,sourceOutcome:publicPageRestricted(html,url,{post,matches}) ?
          'access_restricted' : 'no_public_media'});
      url=new URL(canonical);
    }
    const parsed=parse(html,url);
    if (!parsed) throw new PreviewFailure('source_unavailable',undefined,
      {sourceHttpStatus:200,sourceOutcome:publicPageRestricted(html,url,{post,matches}) ?
        'access_restricted' : 'no_public_media'});
    // This records HTML/metadata parsing only. Media delivery and device decoding
    // have their own checks; a text-only preview can still be available.
    return {...parsed,sourceHttpStatus:200,
      sourceOutcome:parsed.media?.length || parsed.images?.length ? 'public_media' : 'public_metadata'};
  }
}

export async function resolvePreview(value, fetcher = fetch, now = Date.now(), {timeoutMs=PREVIEW_SOURCE_TIMEOUT_MS}={}) {
  const u=sourceURL(value);
  const platform=u.hostname.includes('threads.') ? 'Threads' : u.hostname.includes('instagram.') ? 'Instagram' : 'YouTube';
  const fallback={platform,status:'unavailable',images:[],media:[],title:'',author:'',excerpt:'',
    expiresAt:new Date(now+60000).toISOString(),reason:'source_unavailable',
    message:'來源未提供可用預覽。仍可收藏網址、開啟原文，或選擇自己的封面。'};
  try {
    if (platform==='Threads') {
      if (!threadPost(u) && !/^\/share\/[\w-]+\/?$/.test(u.pathname)) return fallback;
      const data=await publicPostPreview(u,fetcher,{post:threadPost,samePost:sameThreadPost,
        hosts:THREAD_HOSTS,share:/^\/share\/[\w-]+\/?$/,parse:threadPageData,matches:isTargetRecord});
      return data ? {...fallback,...data,status:'available',reason:'',message:''} : fallback;
    }
    if (platform==='Instagram') {
      const share=/^\/share\/(?:(?:p|reel)\/)?[\w-]+\/?$/;
      if (!instagramPost(u) && !share.test(u.pathname)) return fallback;
      if (instagramPost(u) && /\/(?:reel|reels|tv)\//i.test(u.pathname)) {
        const data=await instagramVideoPreview(u,fetcher,timeoutMs);
        return {...fallback,...data,status:'available',reason:'',message:''};
      }
      const data=await publicPostPreview(u,fetcher,{post:instagramPost,samePost:sameInstagramPost,
        hosts:INSTAGRAM_HOSTS,share,parse:instagramPageData,matches:isInstagramRecord});
      return data ? {...fallback,...data,status:'available',reason:'',message:''} : fallback;
    }
    if (platform==='YouTube' && !(u.hostname==='youtu.be' ? /^\/[\w-]+$/.test(u.pathname) :
        u.pathname==='/watch' && /^[\w-]+$/.test(u.searchParams.get('v') || ''))) return fallback;
    const endpoint=new URL('https://www.youtube.com/oembed');
    endpoint.searchParams.set('url',u.href); endpoint.searchParams.set('format','json');
    const data=await boundedJSON(await fetcher(endpoint.href,requestOptions('application/json')));
    if (data.error || typeof data.html!=='string' || !data.html) return fallback;
    const thumbnail=coverURL(data.thumbnail_url,platform), images=thumbnail ? [thumbnail] : [];
    return {...fallback,status:'available',reason:'',message:'',canonicalUrl:u.href,images,
      imageSource:images.length ? 'thumbnail' : 'none',galleryStatus:'not_supported',
      title:typeof data.title==='string' ? data.title.slice(0,500) : '',
      author:typeof data.author_name==='string' ? data.author_name.slice(0,300) : ''};
  } catch (error) {
    const reason=error instanceof PreviewFailure ? error.reason :
      ['TimeoutError','AbortError'].includes(error?.name) ? 'timeout' : 'service_error';
    return {...fallback,reason,
      ...(error instanceof PreviewFailure && error.sourceDiagnostic ? error.sourceDiagnostic : {}),
      ...(reason==='rate_limited' ? {retryAfterSeconds:error.retryAfterSeconds || 60} : {}),
      message:reason==='source_unavailable' ? fallback.message : '預覽暫時無法取得來源回應，仍可收藏網址或開啟原文。'};
  }
}

// Public metadata and fixed access-denial diagnostics only, held for at most
// one minute in this isolate. Never cache cookies, HTML, account data or credentials. Coalescing and cooldowns
// reduce source requests; they do not retry or evade access restrictions.
function mediaCacheDeadline(result,platform) {
  if (!['Threads','Instagram'].includes(platform)) return Infinity;
  let deadline=Infinity;
  const urls=[...(Array.isArray(result.images) ? result.images : []),
    ...(Array.isArray(result.media) ? result.media.flatMap(item=>[item?.url,item?.thumbnailUrl]) : [])];
  for (const value of urls) {
    const allowed=coverURL(value,platform);
    if (!allowed) continue;
    const expiry=new URL(allowed).searchParams.get('oe');
    // Meta's known signed expiry is an eight-digit hexadecimal Unix timestamp.
    // Unknown signatures keep the existing short TTL; never guess their format.
    if (/^[0-9a-f]{8}$/i.test(expiry || '')) deadline=Math.min(deadline,parseInt(expiry,16)*1000-60000);
  }
  return deadline;
}
export function createPreviewCoordinator({resolver=resolvePreview, now=Date.now,
    maxEntries=64, maxPending=16, maxBytes=2*1024*1024}={}) {
  const saved=new Map(), pending=new Map(), cooldowns=new Map();
  let bytes=0;
  const remove=key=>{bytes-=saved.get(key)?.bytes || 0;saved.delete(key);};
  const sourceCooldown=platform=>Math.max(0,Math.ceil(((cooldowns.get(platform) || 0)-now())/1000));
  const limitSource=(platform,seconds)=>{
    if (!['Threads','Instagram','YouTube'].includes(platform)) return;
    const wait=retrySeconds(String(seconds || 60),now());
    cooldowns.set(platform,Math.max(cooldowns.get(platform) || 0,now()+wait*1000));
  };
  const coordinate=async (value, fetcher=fetch) => {
    const source=sourceURL(value), key=source.href;
    const platform=source.hostname.includes('threads.') ? 'Threads' :
      source.hostname.includes('instagram.') ? 'Instagram' : 'YouTube';
    const time=now(), previous=saved.get(key);
    if (previous?.until>time) return JSON.parse(previous.body);
    if (previous) remove(key);
    const fallback=reason=>({platform,status:'unavailable',reason,images:[],media:[],
      title:'',author:'',excerpt:'',expiresAt:new Date(time+60000).toISOString(),
      message:'預覽暫時無法取得來源回應，仍可收藏網址或開啟原文。'});
    if (pending.has(key)) return pending.get(key);
    const until=cooldowns.get(platform) || 0;
    if (until>time) return {...fallback('rate_limited'),cooldown:true,
      retryAfterSeconds:Math.ceil((until-time)/1000)};
    if (pending.size>=maxPending) return fallback('service_error');
    const work=Promise.resolve().then(()=>resolver(source.href,fetcher,time)).then(result=>{
      if (result.reason==='rate_limited') {
        limitSource(platform,result.retryAfterSeconds);
        return {...result,retryAfterSeconds:sourceCooldown(platform)};
      }
      // Explicit access denials are safe fixed diagnostics. Reuse them briefly
      // across album items rather than asking the same denied page once per
      // photo; transient network/provider/parse failures remain uncached.
      const denial=result.status==='unavailable' && result.reason==='source_unavailable' &&
        (['access_redirect','access_restricted'].includes(result.sourceOutcome) ||
          [401,403].includes(result.sourceHttpStatus));
      if (result.status==='available' || denial) {
        const body=JSON.stringify(result), size=new TextEncoder().encode(body).byteLength;
        const expires=Date.parse(result.expiresAt);
        const until=Math.min(now()+60000,Number.isFinite(expires) ? expires : now()+60000,
          mediaCacheDeadline(result,platform));
        if (size<=128*1024 && size<=maxBytes && until>now()) {
          for (const [key,entry] of saved) if (entry.until<=now()) remove(key);
          // A parsed share/direct URL may name a verified author-prefixed
          // canonical URL. Seed only that exact canonical after validation so
          // the first photo GET reuses metadata; never merge unverified authors.
          const canonical=result.status==='available' ? photoSource(result.canonicalUrl) : null,
            requested=photoSource(source.href);
          const keys=new Set([key]);
          if (canonical?.platform===platform && (!requested || requested.key===canonical.key)) keys.add(canonical.url);
          for (const alias of keys) {
            if (saved.has(alias)) remove(alias);
            while (saved.size && (saved.size>=maxEntries || bytes+size>maxBytes)) remove(saved.keys().next().value);
            saved.set(alias,{body,bytes:size,until,postKey:canonical?.key});bytes+=size;
          }
        }
      }
      return result;
    }).finally(()=>pending.delete(key));
    pending.set(key,work);
    return work;
  };
  return Object.assign(coordinate,{sourceCooldown,limitSource,
    invalidate:value=>{try {
      const url=sourceURL(value).href,postKey=saved.get(url)?.postKey;
      for (const [key,entry] of saved) if (key===url || postKey && entry.postKey===postKey) remove(key);
    } catch (_) { /* No source request. */ }}});
}
export const coordinatedPreview=createPreviewCoordinator();

export async function onRequest({request, env = {}}) {
  const origin = request.headers.get('Origin');
  const allowed = new Set([new URL(request.url).origin, ...(env.PREVIEW_ALLOWED_ORIGINS || '').split(',').map(x=>x.trim())]);
  const cors = origin && allowed.has(origin) ? {'Access-Control-Allow-Origin':origin, Vary:'Origin'} : {};
  const reply = (body, status=200) => new Response(JSON.stringify(body), {status,
    headers:{...headers,...cors,'X-SharedMark-Preview-Version':'reliability-2',
      ...(status===429 ? {'Retry-After':'60'} : {})}});
  if (origin && !allowed.has(origin)) return reply({message:'不允許此來源。'},403);
  if (request.method === 'OPTIONS') return new Response(null,{status:204,headers:{...headers,...cors,
    'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'}});
  if (request.method !== 'POST') return reply({message:'請使用 POST。'},405);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const minute = Math.floor(Date.now()/60000), previous = buckets.get(ip);
  if (previous?.minute === minute && previous.count >= 120) return reply({message:'預覽次數較多，請稍後重試。'},429);
  if (buckets.size > 4096) buckets.clear();
  buckets.set(ip,{minute,count:previous?.minute === minute ? previous.count+1 : 1});
  // 可另外綁定 Cloudflare Rate Limiting；本機 isolate 計數不是跨節點總額限制。
  if (env.PREVIEW_LIMITER && !(await env.PREVIEW_LIMITER.limit({key:ip})).success) return reply({message:'請稍後重試。'},429);
  try {
    const reader = request.body?.getReader(); if (!reader) return reply({message:'缺少網址。'},400);
    let body = '', size = 0;
    while (true) { const {done,value} = await reader.read(); if(done) break;
      size += value.byteLength; if(size > 16384) {await reader.cancel(); return reply({message:'請求過大。'},413);}
      body += new TextDecoder().decode(value); }
    const {url} = JSON.parse(body); sourceURL(url);
    return reply(await withPhotoEndpoints(await coordinatedPreview(url,fetch)));
  } catch (_) { return reply({message:'此來源暫不支援預覽，網址仍可收藏。'},400); }
}

// Reels expose progressive media in their public embed payload. Select this
// document up front, never retry a login/challenge/429 with another identity.
export async function instagramVideoPreview(value, fetcher = fetch, timeoutMs = PREVIEW_SOURCE_TIMEOUT_MS) {
  const post=instagramPost(value);
  if (!post) throw new PreviewFailure('source_unavailable');
  post.url.search='';
  const embed=new URL(`https://www.instagram.com/p/${post.code}/embed/captioned/`);
  const signal=AbortSignal.timeout(timeoutMs);
  const response=await awaitPreviewSignal(fetcher(embed.href,{...requestOptions('text/html'),signal}),signal);
  if ([301,302,303,307,308].includes(response.status)) {
    cancelPreviewBody(response);
    throw new PreviewFailure('source_unavailable',undefined,
      {sourceHttpStatus:response.status,sourceOutcome:'access_redirect'});
  }
  const html=await boundedHTML(response,signal);
  if (publicPageRestricted(html,post.url,{post:instagramPost,matches:isInstagramRecord})) {
    throw new PreviewFailure('source_unavailable',undefined,{sourceHttpStatus:200,sourceOutcome:'access_restricted'});
  }
  const data=instagramPageData(html,post.url);
  if (!data) throw new PreviewFailure('source_unavailable',undefined,{sourceHttpStatus:200,sourceOutcome:'no_public_media'});
  return {...data,canonicalUrl:post.url.href,sourceHttpStatus:200,
    sourceOutcome:data.media?.length?'public_media':'public_metadata'};
}
