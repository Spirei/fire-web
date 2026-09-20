"use client";
import { useEffect } from "react";
import { glassDisplacement, stepGlassSpring, type GlassSpring } from "@/lib/liquidGlass";

// Shared presentation only: native click callbacks still own navigation and data changes.
export default function LiquidGlassInteractions({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    if (!enabled) return;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const selector = "button, a.fire-cap, a[role=tab], [role=button]";
    const groupSelector = "[data-glass-group], [role=tablist], .settings-primary-subnav, .sw-sidebar-nav, .asset-library-tabs, .chart-settings-segmented";
    let pending: ReturnType<typeof setTimeout> | undefined, pointer: number | null = null;
    let origin: HTMLElement | null = null, startX = 0, startY = 0, lastX = 0, lastY = 0;
    let raf = 0, lastTime = 0, held = false, pulse = 0, suppressUntil = 0, bypass = false;
    let layer: HTMLDivElement | null = null, copy: HTMLDivElement | null = null, source: HTMLElement | null = null;
    let previousClip = "", rect: DOMRect, boxes: { el: HTMLElement; rect: DOMRect }[] = [], selected: HTMLElement | null = null;
    const spring = (value: number): GlassSpring => ({ value, velocity: 0 });
    let x = spring(0), y = spring(0), w = spring(0), h = spring(0), lift = spring(0);
    let tx = 0, ty = 0, tw = 0, th = 0;
    const wake = () => { if (!raf && layer) raf=requestAnimationFrame(tick); };
    const eligible = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null;
      const el = target.closest<HTMLElement>(selector);
      if (!el || el.closest('.lg-control, [data-glass-ignore], [draggable="true"], [role="slider"], [contenteditable="true"]') || el.matches(':disabled, [aria-disabled="true"]') || el.querySelector('input,textarea,select')) return null;
      return el;
    };
    const clearPending = () => { clearTimeout(pending); pending = undefined; };
    const remove = () => {
      cancelAnimationFrame(raf); raf = 0; lastTime = 0;
      if (source) source.style.clipPath = previousClip;
      layer?.remove(); layer = copy = null; source = null;
    };
    const cancel = () => { clearPending(); pointer = null; origin = null; held = false; pulse = 0; remove(); };
    const targetBox = (box: DOMRect) => { tx = box.left + box.width / 2; ty = box.top + box.height / 2; tw = box.width; th = box.height; };
    const move = (px: number, py: number) => {
      if (!boxes.length) return;
      const nearest = boxes.reduce((a,b) => Math.hypot(px-a.rect.left-a.rect.width/2, py-a.rect.top-a.rect.height/2) < Math.hypot(px-b.rect.left-b.rect.width/2, py-b.rect.top-b.rect.height/2) ? a : b);
      selected = nearest.el; targetBox(nearest.rect);
      if (boxes.length > 1) {
        const horizontal=Math.max(...boxes.map(b=>b.rect.left))-Math.min(...boxes.map(b=>b.rect.left));
        if(horizontal<8)ty=Math.max(rect.top+th/2,Math.min(rect.bottom-th/2,py));
        else tx = Math.max(rect.left + tw / 2, Math.min(rect.right - tw / 2, px));
      }
    };
    const tick = (time: number) => {
      if (!layer || !copy || !source?.isConnected) { cancel(); return; }
      const dt = lastTime ? Math.min((time-lastTime)/1000, .064) : 1/60; lastTime = time;
      pulse = Math.max(0, pulse-dt);
      const targetLift = held ? 1 : pulse > 0 ? .92 : 0;
      x = stepGlassSpring(x, tx, dt, held ? 48 : 28); y = stepGlassSpring(y, ty, dt, 38);
      w = stepGlassSpring(w, tw, dt, 38); h = stepGlassSpring(h, th, dt, 38);
      lift = stepGlassSpring(lift, targetLift, dt, targetLift ? 42 : 26);
      const raised = Math.max(0, Math.min(1,lift.value));
      const speedX=Math.min(Math.abs(x.velocity)/1300,1),speedY=Math.min(Math.abs(y.velocity)/1300,1),motion=Math.max(speedX,speedY);
      const width = w.value*(1+.14*raised+.09*speedX*raised-.025*speedY*raised);
      const height=h.value*(1+.26*raised+.09*speedY*raised-.025*speedX*raised);
      const left=x.value-width/2, top=y.value-height/2;
      Object.assign(layer.style,{width:`${width}px`,height:`${height}px`,transform:`translate3d(${left}px,${top}px,0)`,opacity:String(Math.min(1,raised*10))});
      layer.style.setProperty('--lg-zoom',String(1+.16*raised));
      layer.style.setProperty('--lg-speed',String(motion));
      copy.style.transform=`translate3d(${rect.left-left}px,${rect.top-top}px,0)`;
      const a=Math.max(0,left-rect.left), b=Math.max(0,top-rect.top), c=Math.min(rect.width,left-rect.left+width), d=Math.min(rect.height,top-rect.top+height);
      // Cut out the original beneath the magnified copy; no double text.
      source.style.clipPath = raised > .02 ? `polygon(evenodd,0px 0px,${rect.width}px 0px,${rect.width}px ${rect.height}px,0px ${rect.height}px,0px 0px,${a}px ${b}px,${a}px ${d}px,${c}px ${d}px,${c}px ${b}px,${a}px ${b}px)` : previousClip;
      if (!held && !pulse && raised < .002) { remove(); return; }
      if (held && raised > .999 && Math.abs(x.value-tx)+Math.abs(y.value-ty)+Math.abs(w.value-tw)+Math.abs(h.value-th)<.01 && Math.abs(x.velocity)+Math.abs(y.velocity)<.05) { raf=0;lastTime=0;return; }
      raf=requestAnimationFrame(tick);
    };
    const begin = (el: HTMLElement, long: boolean) => {
      remove();
      const group=el.closest<HTMLElement>(groupSelector);
      source=group ?? el; rect=source.getBoundingClientRect(); previousClip=source.style.clipPath;
      boxes=(group ? Array.from(group.querySelectorAll<HTMLElement>(selector)) : [el]).filter(node=>eligible(node)===node).map(node=>({el:node,rect:node.getBoundingClientRect()})).filter(b=>b.rect.width>0&&b.rect.height>0);
      if (!boxes.some(b=>b.el===el)) { remove(); return; }
      selected=el;
      layer=document.createElement('div'); layer.className='lg-global-lens'; layer.inert=true; layer.setAttribute('aria-hidden','true');
      const style=getComputedStyle(el);
      for(const name of ['--site-surface','--site-ink','--site-accent']) layer.style.setProperty(name,style.getPropertyValue(name));
      const magnify=document.createElement('div'); magnify.className='lg-global-magnify'; copy=document.createElement('div');
      copy.style.cssText=`position:absolute;left:0;top:0;width:${rect.width}px;height:${rect.height}px`;
      // Snapshot only the small control group, once per gesture, never per frame.
      for(const box of boxes) {
        const clone=box.el.cloneNode(true) as HTMLElement;
        const original=[box.el,...box.el.querySelectorAll<HTMLElement>('*')], cloned=[clone,...clone.querySelectorAll<HTMLElement>('*')];
        original.forEach((node,i)=>{
          const computed=getComputedStyle(node);
          for(const property of ['display','position','align-items','justify-content','gap','flex-direction','flex-shrink','padding','width','height','min-width','max-width','font','font-size','font-weight','line-height','letter-spacing','white-space','text-align','color','fill','stroke','stroke-width','background','border','border-radius','box-sizing','vertical-align','opacity']) cloned[i].style.setProperty(property,computed.getPropertyValue(property));
          cloned[i].removeAttribute('id'); cloned[i].removeAttribute('name'); cloned[i].removeAttribute('autofocus');
          cloned[i].style.transition='none'; cloned[i].style.animation='none';
        });
        Object.assign(clone.style,{position:'absolute',left:`${box.rect.left-rect.left}px`,top:`${box.rect.top-rect.top}px`,width:`${box.rect.width}px`,height:`${box.rect.height}px`,margin:'0',transform:'none',background:'transparent',boxShadow:'none',borderColor:'transparent',color:'rgb(var(--site-accent))',clipPath:'none'});
        copy.append(clone);
      }
      magnify.append(copy);layer.append(magnify);document.body.append(layer);
      const canvas=document.createElement('canvas');canvas.width=Math.max(2,Math.round(el.clientWidth));canvas.height=Math.max(2,Math.round(el.clientHeight));
      const ctx=canvas.getContext('2d');
      if(ctx){
        const pixels=ctx.createImageData(canvas.width,canvas.height);pixels.data.set(glassDisplacement(canvas.width,canvas.height));ctx.putImageData(pixels,0,0);
        const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),filterId=`glass-global-${Math.round(performance.now()*1000)}`;
        svg.setAttribute('width','0');svg.setAttribute('height','0');
        svg.innerHTML=`<defs><filter id="${filterId}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feImage href="${canvas.toDataURL()}" width="100%" height="100%" preserveAspectRatio="none" result="rim"/><feDisplacementMap in="SourceGraphic" in2="rim" scale="1.6" xChannelSelector="R" yChannelSelector="G"/></filter></defs>`;
        layer.append(svg);magnify.style.filter=`url(#${filterId})`;
      }
      const from=boxes.find(b=>b.el.matches('[aria-selected="true"], [aria-pressed="true"], [data-active="true"], .seg-active, .is-active')) ?? boxes.find(b=>b.el===el)!;
      targetBox(from.rect); x=spring(tx);y=spring(ty);w=spring(tw);h=spring(th);lift=spring(0);
      targetBox(boxes.find(b=>b.el===el)!.rect);held=long;pulse=long?0:.24;
      if(long)move(lastX,lastY);
      raf=requestAnimationFrame(tick);
    };
    const down=(e: PointerEvent)=>{
      if(media.matches||!e.isPrimary||e.button!==0||pointer!==null)return;
      const el=eligible(e.target);if(!el)return;
      cancel();suppressUntil=0;origin=el;pointer=e.pointerId;startX=lastX=e.clientX;startY=lastY=e.clientY;
      pending=setTimeout(()=>{pending=undefined;if(origin?.isConnected)begin(origin,true)},320);
    };
    const drag=(e: PointerEvent)=>{
      if(pointer!==e.pointerId)return;lastX=e.clientX;lastY=e.clientY;
      if(held) {move(lastX,lastY);wake();e.preventDefault();}
      else if(Math.hypot(lastX-startX,lastY-startY)>8){clearPending();origin=null;}
    };
    const up=(e: PointerEvent)=>{
      if(pointer!==e.pointerId)return;clearPending();pointer=null;
      if(!held){origin=null;return;}
      held=false;suppressUntil=performance.now()+400;
      move(e.clientX,e.clientY);
      wake();
      const el=selected;
      if(el?.isConnected && e.clientX>=rect.left-16&&e.clientX<=rect.right+16&&e.clientY>=rect.top-16&&e.clientY<=rect.bottom+16){
        targetBox(boxes.find(b=>b.el===el)!.rect);
        bypass=true;try{el.click()}finally{bypass=false}
      }
      origin=null;
    };
    const click=(e: MouseEvent)=>{
      if(bypass)return;
      if(performance.now()<suppressUntil&&e.detail!==0){e.preventDefault();e.stopImmediatePropagation();return;}
      if(media.matches||e.button!==0)return;
      const el=eligible(e.target);if(el)begin(el,false);
    };
    const context=(e: Event)=>{if(held){e.preventDefault();}};
    document.addEventListener('pointerdown',down,true);document.addEventListener('pointermove',drag,{capture:true,passive:false});
    document.addEventListener('pointerup',up,true);document.addEventListener('pointercancel',cancel,true);
    document.addEventListener('click',click,true);document.addEventListener('contextmenu',context,true);
    window.addEventListener('blur',cancel);window.addEventListener('resize',cancel);window.addEventListener('scroll',cancel,true);media.addEventListener('change',cancel);
    return()=>{cancel();document.removeEventListener('pointerdown',down,true);document.removeEventListener('pointermove',drag,true);document.removeEventListener('pointerup',up,true);document.removeEventListener('pointercancel',cancel,true);document.removeEventListener('click',click,true);document.removeEventListener('contextmenu',context,true);window.removeEventListener('blur',cancel);window.removeEventListener('resize',cancel);window.removeEventListener('scroll',cancel,true);media.removeEventListener('change',cancel);};
  }, [enabled]);
  return null;
}
