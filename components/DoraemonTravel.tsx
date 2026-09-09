"use client";

import { useEffect, useRef, useState } from "react";

export const DORAEMON_IMAGE = "/uploads/background/哆啦A梦时光机Doraemon.png";

/** Animate the supplied artwork itself. The foreground stays stable while the
 * tunnel and distant scenes move in depth. No generated particles or flashes. */
export default function DoraemonTravel() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const canvas = ref.current;
    const gl = canvas?.getContext("webgl", { alpha: false, antialias: false, powerPreference: "low-power" });
    if (!canvas || !gl) return;
    let frame = 0;
    let disposed = false;
    const shaders: WebGLShader[] = [];
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
      return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
    };
    const vertex = compile(gl.VERTEX_SHADER, `attribute vec2 position; varying vec2 uv;
      void main(){ uv=position*.5+.5; gl_Position=vec4(position,0.,1.); }`);
    const fragment = compile(gl.FRAGMENT_SHADER, `precision mediump float;
      varying vec2 uv; uniform sampler2D artwork; uniform vec2 viewport; uniform float elapsed;
      void main(){
        float aspect=viewport.x/viewport.y;
        vec2 fit=aspect>1.5 ? vec2(1.,1.5/aspect) : vec2(aspect/1.5,1.);
        vec2 p=(vec2(uv.x,1.-uv.y)-.5)*fit+vec2(.5,.5);
        float t=min(elapsed,2.2);
        // Camera advances gently; the figures on the machine stay in focus.
        vec2 center=vec2(.53,.56);
        p=center+(p-center)/(1.+.023*t);
        vec2 figure=(p-vec2(.50,.65))/vec2(.32,.31);
        float background=smoothstep(.75,1.35,length(figure));
        vec2 tunnel=vec2(.73,.53);
        vec2 ray=p-tunnel;
        float angle=.017*sin(t*.8)*background;
        mat2 turn=mat2(cos(angle),-sin(angle),sin(angle),cos(angle));
        vec2 depth=tunnel+turn*ray*(1.-.036*t*background);
        // Local parallax gives the surrounding scenes depth without bending faces.
        depth+=background*sin(t*.6)*vec2(.002*sin(t*1.3+p.y*5.),.003*sin(t+p.x*4.));
        gl_FragColor=texture2D(artwork,clamp(depth,vec2(.001),vec2(.999)));
      }`);
    const program = gl.createProgram();
    const buffer = gl.createBuffer();
    const texture = gl.createTexture();
    const cleanup = () => {
      disposed = true; cancelAnimationFrame(frame);
      if (texture) gl.deleteTexture(texture);
      if (buffer) gl.deleteBuffer(buffer);
      if (program) gl.deleteProgram(program);
      shaders.forEach(shader => gl.deleteShader(shader));
    };
    if (!vertex || !fragment || !program || !buffer || !texture) { cleanup(); return; }
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { cleanup(); return; }
    gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const time = gl.getUniformLocation(program, "elapsed"), viewport = gl.getUniformLocation(program, "viewport");
    const image = new Image();
    image.onload = () => {
      if (disposed) return;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      const started = performance.now();
      const draw = (now: number) => {
        if (disposed) return;
        const width = innerWidth, height = innerHeight, dpr = Math.min(devicePixelRatio || 1, 1.5);
        const w = Math.round(width*dpr), h = Math.round(height*dpr);
        if (canvas.width !== w || canvas.height !== h) { canvas.width=w; canvas.height=h; gl.viewport(0,0,w,h); }
        gl.uniform2f(viewport,width,height); gl.uniform1f(time,(now-started)/1000);
        gl.drawArrays(gl.TRIANGLES,0,6);
        frame=requestAnimationFrame(draw);
      };
      draw(started); setReady(true);
    };
    const lost = (event: Event) => { event.preventDefault(); cancelAnimationFrame(frame); setReady(false); };
    canvas.addEventListener("webglcontextlost", lost);
    image.src = DORAEMON_IMAGE;
    return () => { image.onload=null; canvas.removeEventListener("webglcontextlost", lost); cleanup(); };
  }, []);
  return <>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img className="fire-time-picture" src={DORAEMON_IMAGE} alt="" />
    <canvas ref={ref} className={`fire-time-artwork ${ready ? "is-ready" : ""}`} aria-hidden="true" />
  </>;
}
