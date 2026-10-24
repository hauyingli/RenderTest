// Lightweight scheduled probe of this project's fixed Render health endpoint.
// This never calls Instagram, preview/photo APIs, or a user-supplied URL.
const HEALTH_URL='https://rendertest-gmdr.onrender.com/health';
export async function checkRenderHealth(env,{fetcher=fetch,now=Date.now}={}){
 if(env?.RENDER_HEALTH_CHECK_ENABLED!=='true')return {outcome:'disabled'};
 const started=now(),signal=AbortSignal.timeout(10000);
 try{
  const response=await fetcher(HEALTH_URL,{method:'GET',redirect:'manual',signal,
   cf:{cacheTtlByStatus:{'100-599':-1}},headers:{Accept:'application/json','Cache-Control':'no-store',Pragma:'no-cache'}});
  const summary={httpStatus:response.status,elapsedMs:now()-started};
  if(response.status!==200){await response.body?.cancel();return {...summary,outcome:'http_error'};}
  if(!(response.headers.get('content-type')||'').toLowerCase().startsWith('application/json')){
   await response.body?.cancel();return {...summary,outcome:'invalid_health_response'};
  }
  const reader=response.body?.getReader();if(!reader)return {...summary,outcome:'invalid_health_response'};
  let size=0,text='',onAbort;
  const expired=new Promise((_,reject)=>{onAbort=()=>reject(new DOMException('timeout','TimeoutError'));signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();});
  try{while(true){const {done,value}=await Promise.race([reader.read(),expired]);if(done)break;size+=value.byteLength;
   if(size>1024)return {...summary,outcome:'invalid_health_response'};text+=new TextDecoder().decode(value);}}
  finally{signal.removeEventListener('abort',onAbort);void reader.cancel().catch(()=>{});}
  let valid=false;try{valid=JSON.parse(text)?.ok===true;}catch{}
  return {...summary,elapsedMs:now()-started,outcome:valid?'ok':'invalid_health_response'};
 }catch(error){return {outcome:signal.aborted||['AbortError','TimeoutError'].includes(error?.name)?'timeout':'network_error',elapsedMs:now()-started};}
}
