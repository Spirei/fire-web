/** Measure navigation to two painted frames after page code is ready; no telemetry leaves the browser. */
export function observeWorkspaceReady(element:HTMLElement,start:number,onReady:(ms:number,failed:boolean)=>void) {
  let frame=0,stopped=false;
  const observer=new MutationObserver(check);
  function check(){
    if(stopped||frame||element.querySelector(".workspace-view-loading"))return;
    frame=requestAnimationFrame(()=>{frame=requestAnimationFrame(()=>{
      frame=0;
      if(stopped)return;
      if(element.querySelector(".workspace-view-loading")){check();return;}
      stopped=true;observer.disconnect();
      onReady(Math.round(performance.now()-start),!!element.querySelector(".workspace-load-error"));
    });});
  }
  observer.observe(element,{childList:true,subtree:true});check();
  return()=>{stopped=true;observer.disconnect();cancelAnimationFrame(frame);};
}
