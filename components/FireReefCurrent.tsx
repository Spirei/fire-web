"use client";

import { useEffect, useRef, useState } from "react";

const REEF_TEXTURE = "/images/fire/coral-reef-transparent.png";

export default function FireReefCurrent() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      powerPreference: "low-power"
    });
    if (!gl) return;

    const vertexSource = `
      attribute vec2 a_position;
      varying vec2 v_uv;
      void main() {
        v_uv = a_position * 0.5 + 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;
    const fragmentSource = `
      #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
      #else
      precision mediump float;
      #endif
      uniform sampler2D u_texture;
      uniform float u_time;
      uniform float u_coverY;
      varying vec2 v_uv;

      float causticField(vec2 p, float t) {
        p *= vec2(18.0, 13.0);
        float a = sin(p.x + sin(p.y * 1.13 + t * .72) * 1.8);
        float b = sin(p.y * 1.31 - cos(p.x * .83 - t * .54) * 1.55);
        float c = sin((p.x + p.y) * .72 + t * .41);
        float ridge = abs(a + b + c * .42);
        return pow(1.0 - smoothstep(.08, 1.18, ridge), 3.6);
      }

      void main() {
        vec2 uv = vec2(v_uv.x, (v_uv.y - 0.5) * u_coverY + 0.5);
        vec4 anchor = texture2D(u_texture, uv);
        float edge = smoothstep(0.12, 0.48, abs(uv.x - 0.5));
        float freeTip = smoothstep(0.08, 0.82, uv.y);
        float coral = smoothstep(0.03, 0.72, anchor.a);
        // 慢洋流只做有界的相位调制。旧公式把 direction 再乘累计时间，
        // 相位导数会随运行时长持续增大，页面停留越久珊瑚就抖得越快。
        float direction = sin(u_time * 0.105) * 0.32;
        float current = sin(uv.y * 15.0 + u_time * 0.62 + direction * 0.85);
        current += sin(uv.y * 31.0 - u_time * 0.39 + uv.x * 4.0) * 0.48;
        current += sin((uv.x + uv.y) * 21.0 + u_time * 0.23) * 0.18;
        float sidePulse = sin(uv.x * 12.0 + u_time * 0.34) + sin(uv.x * 27.0 - u_time * 0.17) * 0.3;
        vec2 displaced = uv;
        displaced.x += current * 0.0062 * edge * freeTip * coral;
        displaced.y += sidePulse * 0.0017 * edge * freeTip * coral;
        vec4 color = texture2D(u_texture, displaced);
        float screenDepth = 1.0 - v_uv.y;
        float surfaceWarp = sin(v_uv.x * 31.0 + u_time * .72) * .006;
        surfaceWarp += sin(v_uv.x * 57.0 - u_time * .48) * .003;
        vec2 lightUv = vec2(v_uv.x + surfaceWarp * (1.0 + screenDepth), v_uv.y);

        // 水面折射后的体积光束：顶部集中，向海底逐渐扩散与衰减。
        float rayA = pow(max(0.0, sin((lightUv.x + screenDepth * .16) * 16.0 + u_time * .11)), 8.0);
        float rayB = pow(max(0.0, sin((lightUv.x - screenDepth * .1) * 25.0 - u_time * .075)), 12.0);
        float rays = (rayA * .72 + rayB * .38) * (1.0 - smoothstep(.08, 1.0, screenDepth));
        rays *= smoothstep(.02, .28, screenDepth);

        // 两组不同尺度的光网叠加，模拟波面折射到水体和礁石上的动态焦散。
        float causticNear = causticField(lightUv + vec2(u_time * .012, 0.0), u_time);
        float causticFar = causticField(lightUv * 1.67 + vec2(.31, .18), -u_time * .73);
        float caustics = causticNear * .72 + causticFar * .34;
        float causticDepth = mix(.92, .2, smoothstep(.05, .94, screenDepth));
        caustics *= causticDepth;

        float surface = exp(-pow((1.0 - v_uv.y) * 13.0, 2.0));
        surface *= .48 + .52 * sin(v_uv.x * 54.0 + sin(v_uv.x * 13.0 - u_time) * 2.2 + u_time * .9);
        surface = max(surface, 0.0);
        float causticA = sin((uv.x * 36.0 + uv.y * 17.0) + u_time * 0.72);
        float causticB = sin((uv.x * 23.0 - uv.y * 29.0) - u_time * 0.47);
        float caustic = pow(max(0.0, causticA * causticB), 3.0) * 0.075;
        float depthFog = smoothstep(0.12, 0.92, uv.y) * 0.025;
        color.rgb += vec3(.18, .76, .86) * (caustic + caustics * .17 + rays * .13) * color.a;
        color.rgb += vec3(0.0, 0.014, 0.022) * (0.5 + 0.5 * sin(u_time * 0.42 + uv.x * 8.0)) * color.a;

        vec3 shallowWater = vec3(.28, .86, .94);
        vec3 midWater = vec3(.045, .48, .72);
        vec3 deepWater = vec3(.025, .19, .39);
        vec3 waterTint = mix(shallowWater, midWater, smoothstep(.0, .48, screenDepth));
        waterTint = mix(waterTint, deepWater, smoothstep(.48, 1.0, screenDepth));
        float atmosphere = .44 + rays * .17 + caustics * .085 + surface * .2;
        atmosphere += smoothstep(.56, 1.0, screenDepth) * .05;
        vec3 atmosphereRgb = waterTint * atmosphere;
        atmosphereRgb += vec3(.58, .95, 1.0) * (rays * .1 + caustics * .045 + surface * .12);
        vec3 finalRgb = color.rgb + atmosphereRgb * (1.0 - color.a * .58);
        float finalAlpha = color.a + min(atmosphere, .78) * (1.0 - color.a);
        gl_FragColor = vec4(finalRgb, clamp(finalAlpha, 0.0, 1.0));
      }
    `;

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    if (!vertex || !fragment) return;
    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);

    const timeLocation = gl.getUniformLocation(program, "u_time");
    const coverLocation = gl.getUniformLocation(program, "u_coverY");
    const image = new Image();
    let frame = 0;
    let visible = true;
    let pageVisible = !document.hidden;
    let loaded = false;
    let elapsed = 0;
    let previousFrameAt = performance.now();
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 1.6);
      const width = Math.max(1, Math.round(rect.width * ratio));
      const height = Math.max(1, Math.round(rect.height * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
    };
    const draw = () => {
      if (!loaded) return;
      resize();
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const canvasAspect = canvas.width / Math.max(canvas.height, 1);
      const imageAspect = image.naturalWidth / Math.max(image.naturalHeight, 1);
      gl.uniform1f(timeLocation, reduceMotion.matches ? 0 : elapsed);
      gl.uniform1f(coverLocation, Math.min(1, imageAspect / Math.max(canvasAspect, 0.01)));
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    const loop = (now: number) => {
      // 浏览器后台节流、休眠恢复或主线程长任务都不应把一大段时间
      // 一次性灌进水流相位；最多推进 100ms，保持珊瑚运动连续。
      const delta = Math.min(Math.max(now - previousFrameAt, 0), 100) / 1000;
      elapsed += delta;
      previousFrameAt = now;
      draw();
      if (visible && pageVisible && !reduceMotion.matches) frame = requestAnimationFrame(loop);
    };
    const restart = () => {
      cancelAnimationFrame(frame);
      previousFrameAt = performance.now();
      if (visible && pageVisible && loaded && !reduceMotion.matches) frame = requestAnimationFrame(loop);
      else draw();
    };

    image.onload = () => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      loaded = true;
      setReady(true);
      restart();
    };
    image.src = REEF_TEXTURE;

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      restart();
    }, { rootMargin: "80px" });
    observer.observe(canvas);
    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(canvas);
    const handleVisibility = () => {
      pageVisible = !document.hidden;
      restart();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    reduceMotion.addEventListener("change", restart);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", handleVisibility);
      reduceMotion.removeEventListener("change", restart);
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    };
  }, []);

  return (
    <>
      <div className="fire-reef-depth" style={{ opacity: ready ? 0 : undefined }} />
      <canvas ref={canvasRef} className={`fire-reef-current ${ready ? "is-ready" : ""}`} />
    </>
  );
}
