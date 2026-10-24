import {Readable} from 'node:stream';

export async function handleInternalHTTP(req,res,handler){
 const controller=new AbortController();
 const abort=()=>controller.abort();req.once('aborted',abort);
 const close=()=>{if(!res.writableEnded)abort();};res.once('close',close);
 try{
  const headers=new Headers();
  // Pass only protocol fields. No JWT, browser cookies or host-derived URL.
  for(const key of ['content-type','content-length','x-sharedmark-render-secret','origin']){
   if(typeof req.headers[key]==='string')headers.set(key,req.headers[key]);
  }
  const request=new Request('http://internal.invalid'+req.url,{method:req.method,headers,signal:controller.signal,
   ...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
  const response=await handler(request);
  res.writeHead(response.status,Object.fromEntries(response.headers));
  const bytes=Buffer.from(await response.arrayBuffer());res.end(bytes);
 }catch{
  if(!res.headersSent)res.writeHead(502,{'Content-Type':'application/json','Cache-Control':'private, no-store'});
  res.end('{"reason":"service_error"}');
 }finally{req.off('aborted',abort);res.off('close',close);}
}
