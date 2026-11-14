const filenames=new Set(['pcremotecommander-0.7.0-beta.27.tgz','pcremotecommander-0.7.0-beta.26.tgz','pcremotecommander-0.7.0-beta.25.tgz','pcremotecommander-0.7.0-beta.24.tgz','pcremotecommander-0.7.0-beta.23.tgz','pcremotecommander-speech-tiny-v1.zip','pcremotecommander-0.7.0-beta.22.tgz','pcremotecommander-0.7.0-beta.20.tgz','pcremotecommander-0.7.0-beta.19.tgz','pcremotecommander-0.7.0-beta.18.tgz','pcremotecommander-0.7.0-beta.17.tgz','pcremotecommander-0.7.0-beta.16.tgz','pc-remote-commander-preview-0.7.0-rc.3.tgz','pcremotecommander-0.7.0-beta.3.tgz','pcremotecommander-0.7.0-beta.4.tgz','pcremotecommander-0.7.0-beta.5.tgz','pcremotecommander-0.7.0-beta.6.tgz','pcremotecommander-0.7.0-beta.7.tgz','pcremotecommander-0.7.0-beta.8.tgz','pcremotecommander-0.7.0-beta.9.tgz','pcremotecommander-0.7.0-beta.11.tgz','pcremotecommander-0.7.0-beta.12.tgz','pcremotecommander-0.7.0-beta.13.tgz','pcremotecommander-0.7.0-beta.14.tgz','pcremotecommander-0.7.0-beta.15.tgz','pcremotecommander-0.7.0-beta.15-build.2.tgz']);

/** A fixed, versioned staging artifact. No caller-controlled object key. */
export async function downloadPackage(request: Request, env: {JAN_SITE_ROLE?: string; JAN_PUBLIC_ORIGIN: string; PACKAGE_BUCKET?: R2Bucket}, ctx?: Pick<ExecutionContext,'waitUntil'>): Promise<Response> {
  const url=new URL(request.url);
  const posix=url.pathname.startsWith('/downloads/posix/');
  const filename=url.pathname.startsWith('/downloads/windows/')?url.pathname.slice('/downloads/windows/'.length):posix?url.pathname.slice('/downloads/posix/'.length):'';
  const permitted=posix?['pcremotecommander-0.7.0-beta.43-posix.zip','pcremotecommander-0.7.0-beta.42-posix.zip','pcremotecommander-0.7.0-beta.41-posix.zip','pcremotecommander-0.7.0-beta.40-posix.zip','pcremotecommander-0.7.0-beta.39-posix.zip','pcremotecommander-0.7.0-beta.38-posix.zip','pcremotecommander-0.7.0-beta.37-posix.zip','pcremotecommander-0.7.0-beta.36-posix.zip','pcremotecommander-0.7.0-beta.35-build.2-posix.zip','pcremotecommander-0.7.0-beta.34-posix.zip','pcremotecommander-0.7.0-beta.33-build.2-posix.zip','pcremotecommander-0.7.0-beta.33-posix.zip','pcremotecommander-0.7.0-beta.32-posix.zip','pcremotecommander-0.7.0-beta.31-posix.zip','pcremotecommander-0.7.0-beta.29-posix.zip','pcremotecommander-0.7.0-beta.30-posix.zip'].includes(filename):filenames.has(filename)||['pcremotecommander-0.7.0-beta.43.tgz','pcremotecommander-0.7.0-beta.42.tgz','pcremotecommander-0.7.0-beta.41.tgz','pcremotecommander-0.7.0-beta.40.tgz','pcremotecommander-0.7.0-beta.39.tgz','pcremotecommander-0.7.0-beta.38.tgz','pcremotecommander-0.7.0-beta.37.tgz','pcremotecommander-0.7.0-beta.36.tgz','pcremotecommander-0.7.0-beta.35-build.2.tgz','pcremotecommander-0.7.0-beta.34.tgz','pcremotecommander-0.7.0-beta.33-build.2.tgz','pcremotecommander-0.7.0-beta.33.tgz','pcremotecommander-0.7.0-beta.32.tgz','pcremotecommander-0.7.0-beta.31.tgz','pcremotecommander-0.7.0-beta.29.tgz','pcremotecommander-0.7.0-beta.30.tgz'].includes(filename);
  if(env.JAN_SITE_ROLE!=='public'||url.origin!==env.JAN_PUBLIC_ORIGIN||!permitted||url.search)return new Response(null,{status:404});
  if(request.method!=='GET')return new Response(null,{status:405,headers:{Allow:'GET'}});
  if(!env.PACKAGE_BUCKET)return new Response('Installer is not available yet',{status:503,headers:{'Cache-Control':'no-store'}});
  const bucket=env.PACKAGE_BUCKET;
  const cache=ctx&&typeof caches!=='undefined'?caches.default:undefined;
  const cacheKey=new Request(url.href);
  if(cache) {
    try {
      const hit=await cache.match(cacheKey);
      if(hit) {const headers=new Headers(hit.headers);headers.set('X-PCRC-Download-Cache','HIT');return new Response(hit.body,{status:hit.status,headers});}
    } catch { /* A cache outage must not block the verified installer download. */ }
  }
  const key=(posix?'posix/':'windows/')+filename;
  const object=await bucket.get(key);
  if(!object)return new Response('Installer is not available yet',{status:503,headers:{'Cache-Control':'no-store'}});
  const response=new Response(object.body,{status:200,headers:{
    'Content-Type':'application/octet-stream',
    'Content-Disposition':'attachment; filename="'+filename+'"',
    'Content-Length':String(object.size),
    'Cache-Control':'public, max-age=3600, immutable',
    'X-Content-Type-Options':'nosniff',
    'Cross-Origin-Resource-Policy':'same-origin',
    'X-PCRC-Download-Cache':cache?'MISS':'BYPASS',
  }});
  if(cache&&ctx) ctx.waitUntil((async()=>{
    // A separate R2 stream avoids tee-buffering a large archive for a slow client.
    const fresh=await bucket.get(key);
    if(fresh)await cache.put(cacheKey,new Response(fresh.body,{headers:response.headers}));
  })().catch(()=>{}));
  return response;
}
