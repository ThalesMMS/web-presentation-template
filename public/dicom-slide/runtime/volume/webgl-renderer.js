(function (global) {
  "use strict";

  const internal = global.__DicomSlideInternal || (global.__DicomSlideInternal = {});
  const volume = internal.volume || (internal.volume = {});

  if (!volume.transfer || !volume.geometry) throw new Error("DICOM Slide WebGL dependencies are missing.");
  const MAX_GPU_VOXELS = 24 * 1024 * 1024;
  const {
    MAX_TRANSFER_STOPS, MAX_RAY_STEPS, PREVIEW_RAY_STEPS, SETTLE_DELAY_MS,
    VOLUME_DEFAULT_ZOOM, VOLUME_MIN_ZOOM, VOLUME_MAX_ZOOM,
    clamp, packTransferFunction, applyVolumetricToolDrag,
  } = volume.transfer;
  const { buildOrbitCamera } = volume.geometry;
  function chooseTextureStride(dimensions, maximumTextureSize, maximumVoxels) {
    let stride = 1;
    const maxSize = Math.max(1, Number(maximumTextureSize) || 2048);
    const maxVoxels = Math.max(1, Number(maximumVoxels) || MAX_GPU_VOXELS);
    while (true) {
      const reduced = dimensions.map((value) => Math.ceil(value / stride));
      const voxels = reduced[0] * reduced[1] * reduced[2];
      if (reduced.every((value) => value <= maxSize) && voxels <= maxVoxels) return stride;
      stride += 1;
      if (stride > Math.max(...dimensions)) return stride;
    }
  }

  function downsampleNearest(voxels, dimensions, stride) {
    if (stride <= 1) return { voxels, dimensions: dimensions.slice() };
    const reduced = dimensions.map((value) => Math.ceil(value / stride));
    const output = new Int16Array(reduced[0] * reduced[1] * reduced[2]);
    const [sourceX, sourceY] = dimensions;
    const [targetX, targetY, targetZ] = reduced;
    let target = 0;
    for (let z = 0; z < targetZ; z += 1) {
      const sourceZ = Math.min(dimensions[2] - 1, z * stride);
      for (let y = 0; y < targetY; y += 1) {
        const sourceYIndex = Math.min(dimensions[1] - 1, y * stride);
        let source = (sourceZ * sourceY + sourceYIndex) * sourceX;
        for (let x = 0; x < targetX; x += 1) {
          output[target] = voxels[source + Math.min(dimensions[0] - 1, x * stride)];
          target += 1;
        }
      }
    }
    return { voxels: output, dimensions: reduced };
  }

  const HALF_FLOAT_SCRATCH = new Float32Array(1);
  const HALF_FLOAT_BITS = new Uint32Array(HALF_FLOAT_SCRATCH.buffer);

  function floatToHalf(value) {
    HALF_FLOAT_SCRATCH[0] = value;
    const bits = HALF_FLOAT_BITS[0];
    const sign = (bits >>> 16) & 0x8000;
    const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
    let mantissa = bits & 0x7fffff;
    if (exponent >= 0x1f) return sign | 0x7c00;
    if (exponent <= 0) {
      if (exponent < -10) return sign;
      mantissa |= 0x800000;
      return sign | (mantissa >>> (14 - exponent));
    }
    return sign | (exponent << 10) | (mantissa >>> 13);
  }

  // The raycaster samples the volume with trilinear filtering, which requires a
  // filterable texture: Int16 voxels become normalized half precision over
  // [minimum, maximum]. With only 65,536 possible Int16 values, conversion uses
  // a lookup table and the per-voxel loop is one indexed read.
  function encodeHalfVolume(voxels, minimum, maximum) {
    const span = Math.max(1, maximum - minimum);
    const lookup = new Uint16Array(65536);
    for (let raw = -32768; raw <= 32767; raw += 1) {
      lookup[raw & 0xffff] = floatToHalf(clamp((raw - minimum) / span, 0, 1));
    }
    const encoded = new Uint16Array(voxels.length);
    for (let index = 0; index < voxels.length; index += 1) {
      encoded[index] = lookup[voxels[index] & 0xffff];
    }
    return encoded;
  }

  function measureValueRange(voxels, fallback) {
    let minimum = Infinity;
    let maximum = -Infinity;
    for (let index = 0; index < voxels.length; index += 1) {
      const value = voxels[index];
      if (value < minimum) minimum = value;
      if (value > maximum) maximum = value;
    }
    if (!Number.isFinite(minimum) || maximum <= minimum) {
      return { minimum: Number(fallback[0]), maximum: Number(fallback[1]) };
    }
    return { minimum, maximum };
  }

  class WebGLVolumeRenderer {
    constructor(canvas, volume, state, cameraFrame, onStateChange, windowLevelMultiplier, transferDomain) {
      this.canvas = canvas;
      this.volume = volume;
      this.cameraFrame = cameraFrame;
      this.onStateChange = onStateChange;
      this.windowLevelMultiplier = windowLevelMultiplier;
      this.transferDomain = transferDomain || null;
      this.gl = canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        powerPreference: "high-performance",
        preserveDrawingBuffer: false,
      });
      if (!this.gl) {
        this._fallback("WebGL2 unavailable");
        return;
      }
      try {
        this._initialize();
        this._bindTools(state);
      } catch (error) {
        this._fallback(error && error.message ? error.message : String(error));
      }
    }

    _fallback(message) {
      this.failed = true;
      this.failureMessage = message;
      const context = this.canvas.getContext("2d");
      if (context) {
        const rect = this.canvas.getBoundingClientRect();
        this.canvas.width = Math.max(1, Math.round(rect.width));
        this.canvas.height = Math.max(1, Math.round(rect.height));
        context.fillStyle = "#000";
        context.fillRect(0, 0, this.canvas.width, this.canvas.height);
        context.fillStyle = "#ff9aa7";
        context.font = "12px system-ui";
        context.fillText(message, 16, 34);
      }
    }

    _compile(type, source) {
      const shader = this.gl.createShader(type);
      this.gl.shaderSource(shader, source);
      this.gl.compileShader(shader);
      if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
        throw new Error(this.gl.getShaderInfoLog(shader) || "Shader compile failure");
      }
      return shader;
    }

    _initialize() {
      const gl = this.gl;
      const vertex = `#version 300 es
        in vec2 aPosition;
        out vec2 vUv;
        void main(){vUv=aPosition;gl_Position=vec4(aPosition,0.0,1.0);}`;
      const fragment = `#version 300 es
        precision highp float;
        precision highp sampler3D;
        in vec2 vUv;
        out vec4 outColor;
        uniform sampler3D uVolume;
        uniform mat3 uRotation;
        uniform vec3 uScale;
        uniform vec3 uTexelStep;
        uniform vec3 uGradientWorld;
        uniform float uGradientVoxelScale;
        uniform vec2 uAspect;
        uniform vec2 uPan;
        uniform float uZoom;
        uniform float uLevel;
        uniform float uWidth;
        uniform float uValueMinimum;
        uniform float uValueSpan;
        uniform float uStepLength;
        uniform int uSteps;
        uniform bool uShading;
        uniform float uGradientOpacityScale;
        uniform int uColorStopCount;
        uniform int uOpacityStopCount;
        uniform vec4 uColorStops[${MAX_TRANSFER_STOPS}];
        uniform vec2 uOpacityStops[${MAX_TRANSFER_STOPS}];
        vec2 hitBox(vec3 ro, vec3 rd, vec3 halfSize){
          vec3 safeRd=mix(vec3(1e-6),rd,greaterThan(abs(rd),vec3(1e-6)));
          vec3 inv=1.0/safeRd;
          vec3 t0=(-halfSize-ro)*inv;
          vec3 t1=(halfSize-ro)*inv;
          vec3 lo=min(t0,t1);
          vec3 hi=max(t0,t1);
          return vec2(max(max(lo.x,lo.y),lo.z),min(min(hi.x,hi.y),hi.z));
        }
        float sampleValue(vec3 tc){
          return uValueMinimum+texture(uVolume,tc).r*uValueSpan;
        }
        vec3 transferColor(float value){
          vec4 left=uColorStops[0];
          for(int i=1;i<${MAX_TRANSFER_STOPS};i++){
            if(i>=uColorStopCount) break;
            vec4 right=uColorStops[i];
            if(value<=right.w){
              float fraction=clamp((value-left.w)/max(right.w-left.w,0.00001),0.0,1.0);
              return mix(left.rgb,right.rgb,fraction);
            }
            left=right;
          }
          return left.rgb;
        }
        float transferOpacity(float value){
          vec2 left=uOpacityStops[0];
          for(int i=1;i<${MAX_TRANSFER_STOPS};i++){
            if(i>=uOpacityStopCount) break;
            vec2 right=uOpacityStops[i];
            if(value<=right.x){
              float fraction=clamp((value-left.x)/max(right.x-left.x,0.00001),0.0,1.0);
              return mix(left.y,right.y,fraction);
            }
            left=right;
          }
          return left.y;
        }
        // DICOM VOI LINEAR. Following Isis (#1588), the windowed value indexes
        // the entire LUT: color and opacity come from the position selected by
        // the window, so W/L drag sweeps the preset through the volume.
        float windowedUnit(float value){
          return uWidth<=1.0
            ? step(uLevel-0.5,value)
            : clamp(((value-(uLevel-0.5))/(uWidth-1.0))+0.5,0.0,1.0);
        }
        vec3 gradientAt(vec3 tc){
          return vec3(
            sampleValue(tc+vec3(uTexelStep.x,0.0,0.0))-sampleValue(tc-vec3(uTexelStep.x,0.0,0.0)),
            sampleValue(tc+vec3(0.0,uTexelStep.y,0.0))-sampleValue(tc-vec3(0.0,uTexelStep.y,0.0)),
            sampleValue(tc+vec3(0.0,0.0,uTexelStep.z))-sampleValue(tc-vec3(0.0,0.0,uTexelStep.z))
          );
        }
        // Blinn-Phong with a headlight (light = eye): the normal is the outward
        // volume gradient corrected for spacing anisotropy.
        float shadeWithGradient(vec3 gradient, vec3 viewDirection){
          const float ambient=0.3;
          vec3 world=gradient*uGradientWorld;
          float length2=dot(world,world);
          if(length2<1e-12) return ambient;
          vec3 normal=-world*inversesqrt(length2);
          vec3 eye=-normalize(viewDirection);
          float diffuse=max(dot(normal,eye),0.0);
          float specular=pow(diffuse,20.0);
          return ambient+0.7*diffuse+0.3*specular;
        }
        vec3 linearToSRGB(vec3 color){
          vec3 value=clamp(color,0.0,1.0);
          return mix(12.92*value,1.055*pow(value,vec3(1.0/2.4))-0.055,step(vec3(0.0031308),value));
        }
        void main(){
          vec2 uv=(vUv-uPan)*uAspect;
          vec3 ro=uRotation*vec3(uv/uZoom,-1.45);
          vec3 rd=normalize(uRotation*vec3(0.0,0.0,1.0));
          vec3 halfSize=0.5*uScale;
          vec2 range=hitBox(ro,rd,halfSize);
          if(range.y<=max(range.x,0.0)){outColor=vec4(0.0,0.0,0.0,1.0);return;}
          // A pseudorandom offset up to one step distributes banding residue as
          // fine noise instead of concentric rings.
          float jitter=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453);
          float t=max(range.x,0.0)+jitter*uStepLength;
          vec3 accumulated=vec3(0.0);
          float coverage=0.0;
          for(int i=0;i<${MAX_RAY_STEPS};i++){
            if(i>=uSteps||t>range.y||coverage>0.95) break;
            vec3 tc=(ro+rd*t)/uScale+0.5;
            t+=uStepLength;
            float index=windowedUnit(sampleValue(tc));
            float alpha=transferOpacity(index);
            if(alpha<=0.0) continue;
            vec3 color=transferColor(index);
            if(uShading||uGradientOpacityScale>0.0){
              vec3 gradient=gradientAt(tc);
              if(uGradientOpacityScale>0.0){
                alpha*=clamp(length(gradient)*uGradientVoxelScale/uGradientOpacityScale,0.0,1.0);
                if(alpha<=0.0) continue;
              }
              if(uShading) color*=shadeWithGradient(gradient,rd);
            }
            float remaining=1.0-coverage;
            accumulated+=remaining*alpha*color;
            coverage+=remaining*alpha;
          }
          outColor=vec4(linearToSRGB(accumulated),1.0);
        }`;
      const program = gl.createProgram();
      gl.attachShader(program, this._compile(gl.VERTEX_SHADER, vertex));
      gl.attachShader(program, this._compile(gl.FRAGMENT_SHADER, fragment));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || "Shader link failure");
      }
      this.program = program;
      gl.useProgram(program);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
      const location = gl.getAttribLocation(program, "aPosition");
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);

      const maximumTextureSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
      this.stride = chooseTextureStride(this.volume.dimensions, maximumTextureSize, MAX_GPU_VOXELS);
      const prepared = downsampleNearest(this.volume.voxels, this.volume.dimensions, this.stride);
      this.textureDimensions = prepared.dimensions;
      this.textureSpacing = this.volume.spacing.map((value) => value * this.stride);
      // The actual range of uploaded voxels defines normalized half-precision
      // accuracy, so it is measured rather than inherited from the manifest.
      this.valueRange = measureValueRange(prepared.voxels, this.volume.valueRange);
      const encoded = encodeHalfVolume(prepared.voxels, this.valueRange.minimum, this.valueRange.maximum);
      this.texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, this.texture);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        gl.R16F,
        prepared.dimensions[0],
        prepared.dimensions[1],
        prepared.dimensions[2],
        0,
        gl.RED,
        gl.HALF_FLOAT,
        encoded
      );
      const uploadError = gl.getError();
      if (uploadError !== gl.NO_ERROR) throw new Error(`3D texture upload failed (WebGL ${uploadError})`);
      gl.uniform1i(gl.getUniformLocation(program, "uVolume"), 0);
      this.locations = Object.fromEntries(
        [
          "uRotation", "uScale", "uTexelStep", "uGradientWorld", "uGradientVoxelScale",
          "uAspect", "uPan", "uZoom", "uLevel", "uWidth", "uValueMinimum", "uValueSpan",
          "uStepLength", "uSteps", "uShading", "uGradientOpacityScale",
          "uColorStopCount", "uOpacityStopCount", "uColorStops", "uOpacityStops",
        ].map((name) => [name, gl.getUniformLocation(program, name)])
      );
    }

    _bindTools(state) {
      let drag = null;
      this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
      this.canvas.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 && event.button !== 2) return;
        drag = {
          mode: "volume",
          // Right mouse button or Alt: zoom, as in the 2D stack.
          tool: event.button === 2 || event.altKey ? "zoom" : state.volumeTool,
          startX: event.clientX,
          startY: event.clientY,
          center: state.volumeCenter,
          width: state.volumeWidth,
          multiplier: this.windowLevelMultiplier,
          panX: state.volumePanX,
          panY: state.volumePanY,
          zoom: state.zoom,
          yaw: state.yaw,
          pitch: state.pitch,
        };
        if (drag.tool === "pan" || drag.tool === "rotate") this.canvas.style.cursor = "grabbing";
        this.canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
      });
      this.canvas.addEventListener("pointermove", (event) => {
        if (!drag) return;
        applyVolumetricToolDrag(state, drag, event.clientX - drag.startX, event.clientY - drag.startY);
        this.renderInteractive(state);
        if (typeof this.onStateChange === "function") this.onStateChange();
      });
      const finish = () => {
        if (!drag) return;
        drag = null;
        const tool = state.volumeTool;
        this.canvas.style.cursor = tool === "pan" || tool === "rotate" ? "grab" : tool === "zoom" ? "ns-resize" : "crosshair";
        if (typeof this.onStateChange === "function") this.onStateChange();
      };
      this.canvas.addEventListener("pointerup", finish);
      this.canvas.addEventListener("pointercancel", finish);
      this.canvas.addEventListener("lostpointercapture", finish);
      this.canvas.addEventListener("wheel", (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.zoom = clamp(state.zoom * Math.exp(-event.deltaY * 0.001), VOLUME_MIN_ZOOM, VOLUME_MAX_ZOOM);
        this.renderInteractive(state);
        if (typeof this.onStateChange === "function") this.onStateChange();
      }, { passive: false });
    }

    // Draws a low-cost frame now and reschedules the full-quality frame for when
    // interaction stops.
    renderInteractive(state) {
      if (this.failed) return;
      this.render(state, true);
      global.clearTimeout(this.settleTimer);
      this.settleTimer = global.setTimeout(() => {
        if (!this.failed) this.render(state, false);
      }, SETTLE_DELAY_MS);
    }

    render(state, preview) {
      if (this.failed) return;
      if (!preview) global.clearTimeout(this.settleTimer);
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const gl = this.gl;
      const dpr = Math.min(global.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
      gl.useProgram(this.program);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const physical = this.textureDimensions.map((value, index) => value * this.textureSpacing[index]);
      const maximum = Math.max(...physical);
      const scale = physical.map((value) => value / maximum);
      const aspect = width >= height ? [width / height, 1] : [1, height / width];
      const transfer = packTransferFunction(state.transferFunctionId, this.transferDomain, state.volumeShift);
      const quality = clamp(Math.round(state.quality), 8, MAX_RAY_STEPS);
      const steps = preview ? Math.min(PREVIEW_RAY_STEPS, quality) : quality;
      // The step is constant in world units (physical diagonal / steps), so
      // accumulated opacity does not depend on traversed thickness or camera angle.
      const diagonal = Math.hypot(...scale);
      gl.uniformMatrix3fv(this.locations.uRotation, false, buildOrbitCamera(this.cameraFrame, state.yaw, state.pitch).rotation);
      gl.uniform3fv(this.locations.uScale, new Float32Array(scale));
      gl.uniform3fv(this.locations.uTexelStep, new Float32Array(this.textureDimensions.map((value) => 1 / value)));
      gl.uniform3fv(this.locations.uGradientWorld, new Float32Array(
        this.textureDimensions.map((value, index) => value / Math.max(1e-6, scale[index]))
      ));
      // The gradient is measured between GPU texture texels; dividing by stride
      // restores the "per original voxel" scale used to calibrate presets.
      gl.uniform1f(this.locations.uGradientVoxelScale, 1 / Math.max(1, this.stride));
      gl.uniform2fv(this.locations.uAspect, new Float32Array(aspect));
      gl.uniform2fv(this.locations.uPan, new Float32Array([
        2 * state.volumePanX / Math.max(1, rect.width),
        -2 * state.volumePanY / Math.max(1, rect.height),
      ]));
      gl.uniform1f(this.locations.uZoom, state.zoom);
      gl.uniform1f(this.locations.uLevel, state.volumeCenter);
      gl.uniform1f(this.locations.uWidth, state.volumeWidth);
      gl.uniform1f(this.locations.uValueMinimum, this.valueRange.minimum);
      gl.uniform1f(this.locations.uValueSpan, Math.max(1, this.valueRange.maximum - this.valueRange.minimum));
      gl.uniform1f(this.locations.uStepLength, diagonal / steps);
      gl.uniform1i(this.locations.uSteps, Math.min(MAX_RAY_STEPS, steps + 2));
      gl.uniform1i(this.locations.uShading, state.shading ? 1 : 0);
      gl.uniform1f(this.locations.uGradientOpacityScale, transfer.gradientOpacityScale);
      gl.uniform1i(this.locations.uColorStopCount, transfer.colorCount);
      gl.uniform1i(this.locations.uOpacityStopCount, transfer.opacityCount);
      gl.uniform4fv(this.locations.uColorStops, transfer.colorStops);
      gl.uniform2fv(this.locations.uOpacityStops, transfer.opacityStops);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      const meta = this.canvas.parentElement.querySelector(".dsv-volume-meta");
      const reduction = this.stride > 1 ? `\nGPU ${this.textureDimensions.join("×")} · ${this.stride}×` : "";
      const shading = state.shading ? " · shade" : "";
      const shift = state.volumeShift ? ` · shift ${Math.round(state.volumeShift)}` : "";
      meta.textContent = `${transfer.preset.label} · ${quality} steps${shading}${shift}\nyaw ${Math.round(state.yaw * 57.3)}° · pitch ${Math.round(state.pitch * 57.3)}°\nZoom ${Math.round(state.zoom / VOLUME_DEFAULT_ZOOM * 100)}%${reduction}`;
    }

    destroy() {
      global.clearTimeout(this.settleTimer);
      if (!this.failed && this.gl) {
        if (this.texture) this.gl.deleteTexture(this.texture);
        if (this.program) this.gl.deleteProgram(this.program);
      }
    }
  }

  volume.webgl = {
    WebGLVolumeRenderer,
    chooseTextureStride,
    downsampleNearest,
    encodeHalfVolume,
    measureValueRange,
  };
})(window);
