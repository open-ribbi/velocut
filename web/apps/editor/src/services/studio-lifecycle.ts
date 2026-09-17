/** Keep an automatically launched local Studio alive while this editor page is open. */
export function keepStudioAlive(){
  let controller:AbortController,timer:ReturnType<typeof setInterval>|undefined;
  const start=()=>{
    const active=new AbortController();controller=active;
    const ping=()=>fetch('/__velocut/health',{signal:active.signal,cache:'no-store'});
    void ping().then(async response=>{
      if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))return;
      const info=await response.json();if(info.app!=='velocut'||info.managed!==true||active.signal.aborted)return;
      timer=setInterval(()=>void ping().catch(()=>{}),30_000);
    }).catch(()=>{});
  };
  const stop=()=>{clearInterval(timer);controller.abort();};
  const restore=(event:PageTransitionEvent)=>{if(event.persisted)start();};
  window.addEventListener('pagehide',stop);window.addEventListener('pageshow',restore);start();
  return ()=>{stop();window.removeEventListener('pagehide',stop);window.removeEventListener('pageshow',restore);};
}
