(function (global) {
  "use strict";

  const internal = global.__DicomSlideInternal || (global.__DicomSlideInternal = {});
  const volume = internal.volume || (internal.volume = {});

  const MAX_TRANSFER_STOPS = 8;
  // The step must remain below one voxel to avoid "wood grain" rings from
  // coarse sampling; interaction uses fewer steps and the settled frame
  // returns to the selected quality.
  const MAX_RAY_STEPS = 512;
  const PREVIEW_RAY_STEPS = 96;
  const SETTLE_DELAY_MS = 130;
  const QUALITY_STEPS = Object.freeze([128, 256, 512]);
  const DEFAULT_QUALITY_STEPS = 256;
  const VIEW_MODES = Object.freeze(["stack", "mpr", "volume"]);
  const MPR_TOOLS = Object.freeze(["crosshair", "window", "pan", "zoom", "scroll"]);
  const VOLUME_TOOLS = Object.freeze(["window", "pan", "zoom", "rotate"]);

  // Start with a tighter zoom in every mode, with a high inspection limit.
  const MPR_DEFAULT_ZOOM = 1.3;
  const MPR_MIN_ZOOM = 0.25;
  const MPR_MAX_ZOOM = 40;
  const VOLUME_DEFAULT_ZOOM = 2.2;
  const VOLUME_MIN_ZOOM = 0.62;
  const VOLUME_MAX_ZOOM = 8;

  // 3D transfer functions are anchored in modality units (HU), matching the
  // reference renderer: windowing only modulates each sample's opacity without
  // repositioning transfer stops. Non-HU series remap this canonical domain to
  // the volume value range.
  const TRANSFER_HU_DOMAIN = Object.freeze([-1000, 1800]);

  const BONE_OPACITY_STOPS = Object.freeze([
    { position: 150, value: 0 },
    { position: 300, value: 0.2 },
    { position: 700, value: 0.65 },
    { position: 1800, value: 0.95 },
  ]);

  function bonesAndSkinPreset(id, label, skinAlpha) {
    return {
      id,
      label,
      colors: [
        { position: -1000, value: [0, 0, 0] },
        { position: -200, value: [0.85, 0.7, 0.6] },
        { position: 300, value: [0.72, 0.48, 0.38] },
        { position: 700, value: [0.92, 0.82, 0.72] },
        { position: 1800, value: [1, 0.98, 0.92] },
      ],
      opacity: [
        { position: -250, value: 0 },
        { position: -150, value: skinAlpha },
        { position: 100, value: skinAlpha * 0.6 },
        { position: 150, value: 0.05 },
        { position: 300, value: 0.4 },
        { position: 700, value: 0.75 },
        { position: 1800, value: 0.95 },
      ],
      shading: true,
      // Gradient modulation keeps the skin shell and skull clean instead of
      // accumulating a soft-tissue blur.
      gradientOpacityScale: 220,
    };
  }

  const TRANSFER_FUNCTIONS = Object.freeze([
    {
      id: "angio",
      label: "Angio",
      colors: [
        { position: 100, value: [0.5, 0, 0] },
        { position: 250, value: [0.9, 0.3, 0.1] },
        { position: 450, value: [1, 0.7, 0.4] },
        { position: 700, value: [1, 1, 1] },
      ],
      opacity: [
        { position: 150, value: 0 },
        { position: 250, value: 0.25 },
        { position: 500, value: 0.85 },
      ],
      shading: true,
      gradientOpacityScale: 0,
    },
    {
      id: "airways",
      label: "Airways",
      colors: [
        { position: -1000, value: [0, 0, 0] },
        { position: -600, value: [0.4, 0.6, 0.9] },
        { position: 350, value: [1, 0.96, 0.88] },
      ],
      opacity: [
        { position: -900, value: 0.05 },
        { position: -600, value: 0.18 },
        { position: -200, value: 0.05 },
        { position: 350, value: 0.3 },
      ],
      shading: false,
      gradientOpacityScale: 0,
    },
    bonesAndSkinPreset("bones-skin-1", "Bones and skin 1", 0.05),
    bonesAndSkinPreset("bones-skin-2", "Bones and skin 2", 0.12),
    bonesAndSkinPreset("bones-skin-3", "Bones and skin 3", 0.22),
    {
      id: "bones-bw",
      label: "Bones B/W",
      colors: [
        { position: 150, value: [0.2, 0.2, 0.2] },
        { position: 700, value: [0.8, 0.8, 0.8] },
        { position: 1800, value: [1, 1, 1] },
      ],
      opacity: BONE_OPACITY_STOPS.slice(),
      shading: true,
      gradientOpacityScale: 0,
    },
    {
      id: "skin-bw",
      label: "Skin B/W",
      colors: [
        { position: -200, value: [0.3, 0.3, 0.3] },
        { position: 100, value: [0.8, 0.8, 0.8] },
        { position: 400, value: [1, 1, 1] },
      ],
      opacity: [
        { position: -250, value: 0 },
        { position: -150, value: 0.15 },
        { position: 100, value: 0.35 },
        { position: 400, value: 0.6 },
      ],
      shading: false,
      gradientOpacityScale: 180,
    },
  ]);

  const DEFAULT_TRANSFER_FUNCTION_ID = "angio";
  const PACKED_TRANSFER_CACHE = new Map();
  const MAX_PACKED_TRANSFER_CACHE_ENTRIES = 64;

  const STYLE_TEXT = `
.dsv-volume-layer{position:absolute;inset:0;z-index:4;overflow:hidden;background:#000}.dsv-volume-layer[hidden]{display:none}
.dsv-volume-root{position:absolute;inset:0;display:grid;grid-template-rows:minmax(0,1fr) 56px;overflow:hidden;background:#000;color:#edf5f8;font:500 12px/1.25 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.dsv-volume-grid{min-width:0;min-height:0;display:grid;gap:3px;padding:3px;background:#05070a}
.dsv-volume-root[data-mode="mpr"] .dsv-volume-grid{grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:minmax(0,1fr)}
.dsv-volume-root[data-mode="mpr"] [data-volume-view="volume"]{display:none}
.dsv-volume-root[data-mode="mpr"][data-maximized] .dsv-volume-grid{grid-template-columns:minmax(0,1fr)}
.dsv-volume-root[data-mode="mpr"][data-maximized] [data-volume-view="axial"],.dsv-volume-root[data-mode="mpr"][data-maximized] [data-volume-view="coronal"],.dsv-volume-root[data-mode="mpr"][data-maximized] [data-volume-view="sagittal"]{display:none}
.dsv-volume-root[data-mode="mpr"][data-maximized="axial"] [data-volume-view="axial"],.dsv-volume-root[data-mode="mpr"][data-maximized="coronal"] [data-volume-view="coronal"],.dsv-volume-root[data-mode="mpr"][data-maximized="sagittal"] [data-volume-view="sagittal"]{display:block}
.dsv-volume-root[data-mode="volume"] .dsv-volume-grid{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr)}
.dsv-volume-root[data-mode="volume"] [data-volume-view="axial"],.dsv-volume-root[data-mode="volume"] [data-volume-view="coronal"],.dsv-volume-root[data-mode="volume"] [data-volume-view="sagittal"]{display:none}
.dsv-volume-view{position:relative;min-width:0;min-height:0;overflow:hidden;border:1px solid #26313a;border-radius:3px;background:#000}
.dsv-volume-view canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:crosshair}
.dsv-volume-root[data-mode="volume"] [data-volume-view="volume"] canvas{cursor:grab}
.dsv-volume-title{position:absolute;z-index:3;top:8px;left:10px;margin:0;color:#f3f8fb;font-size:12px;font-weight:750;text-shadow:0 1px 3px #000;pointer-events:none}
.dsv-volume-meta{position:absolute;z-index:3;right:9px;bottom:8px;color:#bac8d1;font:500 10px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;text-align:right;white-space:pre-line;text-shadow:0 1px 3px #000;pointer-events:none}
.dsv-volume-expand{position:absolute;z-index:4;top:6px;right:6px;width:27px;height:27px;display:grid;place-items:center;padding:0;border:1px solid rgba(103,123,137,.7);border-radius:4px;background:rgba(13,19,24,.82);color:#c8d4db;cursor:pointer}.dsv-volume-expand:hover,.dsv-volume-expand[aria-pressed="true"]{border-color:#38bdf8;color:#fff;background:#112b37}.dsv-volume-expand svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.dsv-volume-controls{min-width:0;display:flex;align-items:center;gap:9px;padding:6px 9px;border-top:1px solid #27313b;background:#0d1218;color:#93a5b2;overflow-x:auto;scrollbar-width:thin}
.dsv-volume-panel{min-width:max-content;width:100%;display:flex;align-items:center;gap:9px}.dsv-volume-panel[hidden]{display:none}
.dsv-volume-hint{min-width:max-content;color:#8fa2af;font-size:10px}.dsv-volume-range{min-width:100px;display:grid;grid-template-columns:auto minmax(68px,1fr) auto;align-items:center;gap:5px;color:#aab9c3;font:650 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace}.dsv-volume-range input{width:100%;min-width:68px;accent-color:#38bdf8}.dsv-volume-value{min-width:36px;color:#dbe6ec;text-align:right;font-variant-numeric:tabular-nums}
.dsv-volume-panel[data-volume-panel="volume"] .dsv-volume-range{min-width:72px;grid-template-columns:auto minmax(42px,1fr) auto}.dsv-volume-panel[data-volume-panel="volume"] .dsv-volume-range input{min-width:42px}
.dsv-volume-panel[data-hide-sliders="true"] .dsv-volume-range{display:none}
.dsv-volume-quality,.dsv-volume-tool-group{display:flex;align-items:center;gap:3px}.dsv-volume-control-button{appearance:none;min-height:28px;padding:4px 7px;border:1px solid #34414d;border-radius:5px;background:#17202a;color:#dce5ec;font:inherit;white-space:nowrap;cursor:pointer}.dsv-volume-control-button:hover{background:#22303d}.dsv-volume-control-button[aria-pressed="true"]{border-color:#38bdf8;background:#0d3345;color:#e6f8ff}.dsv-volume-select-label{display:flex;align-items:center;gap:5px;color:#aab9c3;white-space:nowrap}.dsv-volume-select{min-height:28px;max-width:150px;border:1px solid #34414d;border-radius:5px;background:#17202a;color:#e6eef3;padding:3px 24px 3px 7px;font:inherit}
.dsv-volume-loading{position:absolute;inset:0;z-index:8;display:grid;place-items:center;padding:24px;background:rgba(0,0,0,.78);color:#edf7fb;text-align:center}.dsv-volume-loading[hidden]{display:none}.dsv-volume-loading-card{width:min(420px,82%);padding:18px;border:1px solid #34414d;border-radius:8px;background:#101820;box-shadow:0 16px 42px rgba(0,0,0,.45)}.dsv-volume-loading strong{display:block;margin-bottom:10px}.dsv-volume-progress{height:6px;overflow:hidden;border-radius:999px;background:#26323b}.dsv-volume-progress span{display:block;width:0;height:100%;background:#38bdf8;transition:width .12s linear}.dsv-volume-loading small{display:block;margin-top:9px;color:#9fb0bc}.dsv-volume-loading[data-error="true"]{color:#ffd7dc}.dsv-volume-loading[data-error="true"] .dsv-volume-progress{display:none}
@media(max-width:720px){.dsv-volume-root[data-mode="mpr"] .dsv-volume-grid{grid-template-columns:repeat(3,minmax(150px,1fr));overflow-x:auto}.dsv-volume-hint{display:none}.dsv-volume-range{min-width:92px}.dsv-volume-controls{gap:6px;padding-inline:6px}}
`;

  function ensureStyles(root) {
    const owner = root instanceof Document || root instanceof ShadowRoot ? root : document;
    if (owner.querySelector("style[data-dicom-slide-volume-style]")) return;
    const style = document.createElement("style");
    style.dataset.dicomSlideVolumeStyle = "true";
    style.textContent = STYLE_TEXT;
    if (owner instanceof Document) owner.head.appendChild(style);
    else owner.appendChild(style);
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  // `Number(null)` is 0 and passes isFinite, so missing options must be
  // discarded before conversion to avoid becoming a C 0 / W 1 window.
  function finiteOr(value, fallback) {
    if (value === null || value === undefined || value === "") return fallback;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  function getTransferFunction(id) {
    return TRANSFER_FUNCTIONS.find((preset) => preset.id === id)
      || TRANSFER_FUNCTIONS.find((preset) => preset.id === DEFAULT_TRANSFER_FUNCTION_ID)
      || TRANSFER_FUNCTIONS[0];
  }

  // Preset colors are authored in display sRGB; DVR compositing happens in
  // linear light and returns to sRGB only in the final fragment write.
  function srgbToLinear(value) {
    const channel = clamp(Number(value), 0, 1);
    return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  }

  // Repositions canonical HU-domain stops over the value range of a non-HU
  // series (such as MR).
  function transferDomainMapping(domain) {
    if (!domain) return { scale: 1, offset: 0 };
    const [huMinimum, huMaximum] = TRANSFER_HU_DOMAIN;
    const minimum = Number(domain.minimum);
    const maximum = Number(domain.maximum);
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) {
      return { scale: 1, offset: 0 };
    }
    const scale = (maximum - minimum) / (huMaximum - huMinimum);
    return { scale, offset: minimum - huMinimum * scale };
  }

  function interpolateTransferValue(left, right, fraction) {
    if (Array.isArray(left) && Array.isArray(right)) {
      return left.map((value, index) => value + (right[index] - value) * fraction);
    }
    return Number(left) + (Number(right) - Number(left)) * fraction;
  }

  function sampleTransferStops(stops, value) {
    if (!Array.isArray(stops) || stops.length === 0) throw new TypeError("Transfer stops are required");
    const position = Number(value);
    if (position <= stops[0].position) return interpolateTransferValue(stops[0].value, stops[0].value, 0);
    for (let index = 1; index < stops.length; index += 1) {
      const left = stops[index - 1];
      const right = stops[index];
      if (position <= right.position) {
        const span = Math.max(Number.EPSILON, right.position - left.position);
        return interpolateTransferValue(left.value, right.value, (position - left.position) / span);
      }
    }
    const last = stops[stops.length - 1];
    return interpolateTransferValue(last.value, last.value, 0);
  }

  // Native preset domain — the smallest range containing all color and opacity
  // stops — expressed in volume units through `domain`.
  function transferFunctionDomain(id, domain) {
    const preset = getTransferFunction(typeof id === "string" ? id : id && id.id);
    const mapping = transferDomainMapping(domain);
    let minimum = Infinity;
    let maximum = -Infinity;
    preset.colors.concat(preset.opacity).forEach((stop) => {
      if (stop.position < minimum) minimum = stop.position;
      if (stop.position > maximum) maximum = stop.position;
    });
    const lower = minimum * mapping.scale + mapping.offset;
    const upper = maximum * mapping.scale + mapping.offset;
    return { minimum: lower, maximum: upper, span: Math.max(1, upper - lower) };
  }

  // A preset's native window covers its exact domain, equivalent to OHIF
  // applyPreset where absolute preset positions define the window.
  function transferFunctionWindow(id, domain) {
    const extent = transferFunctionDomain(id, domain);
    return { center: (extent.minimum + extent.maximum) / 2, width: extent.span };
  }

  // Packs a preset for raycaster uniforms following the Isis model
  // (volume_compute.metal, #1588): the WINDOWED value indexes the LUT, and
  // color and opacity come from the preset position selected by the window.
  // Both ramps normalize to 0..1 over the shared native domain; W/L drag sweeps
  // the preset through the volume. `shift` translates only opacity (OHIF
  // VolumeShift), in volume units. Colors use linear light.
  function packTransferFunction(id, domain, shift) {
    const preset = getTransferFunction(typeof id === "string" ? id : id && id.id);
    const mapping = transferDomainMapping(domain);
    const numericShift = Number(shift) || 0;
    const cacheKey = `${preset.id}|${mapping.scale}|${mapping.offset}|${numericShift}`;
    const cached = PACKED_TRANSFER_CACHE.get(cacheKey);
    if (cached) return cached;
    const extent = transferFunctionDomain(preset.id, domain);
    const colors = preset.colors.slice(0, MAX_TRANSFER_STOPS);
    const opacity = preset.opacity.slice(0, MAX_TRANSFER_STOPS);
    const colorStops = new Float32Array(MAX_TRANSFER_STOPS * 4);
    const opacityStops = new Float32Array(MAX_TRANSFER_STOPS * 2);
    const normalize = (position) => (position * mapping.scale + mapping.offset - extent.minimum) / extent.span;
    const opacityShift = numericShift / extent.span;
    for (let index = 0; index < MAX_TRANSFER_STOPS; index += 1) {
      const color = colors[Math.min(index, colors.length - 1)];
      const alpha = opacity[Math.min(index, opacity.length - 1)];
      colorStops.set([
        srgbToLinear(color.value[0]),
        srgbToLinear(color.value[1]),
        srgbToLinear(color.value[2]),
        normalize(color.position),
      ], index * 4);
      opacityStops.set([normalize(alpha.position) + opacityShift, alpha.value], index * 2);
    }
    const packed = {
      preset,
      colorCount: colors.length,
      opacityCount: opacity.length,
      colorStops,
      opacityStops,
      shading: Boolean(preset.shading),
      window: transferFunctionWindow(preset.id, domain),
      // The gradient threshold is measured in values per voxel, so it follows
      // the domain's scale factor.
      gradientOpacityScale: Math.max(0, Number(preset.gradientOpacityScale) || 0) * mapping.scale,
    };
    if (PACKED_TRANSFER_CACHE.size >= MAX_PACKED_TRANSFER_CACHE_ENTRIES) {
      PACKED_TRANSFER_CACHE.delete(PACKED_TRANSFER_CACHE.keys().next().value);
    }
    PACKED_TRANSFER_CACHE.set(cacheKey, packed);
    return packed;
  }

  function selectTransferFunction(state, id, domain) {
    const preset = getTransferFunction(id);
    state.transferFunctionId = preset.id;
    // As in the reference viewer, selecting a preset restores its recommended
    // shading; the user can disable it afterward.
    state.shading = Boolean(preset.shading);
    // As with OHIF applyPreset, the preset supplies its own window: 3D W/L
    // returns to its native domain, from which drag sweeps the preset volume.
    const window = transferFunctionWindow(preset.id, domain);
    state.volumeCenter = window.center;
    state.volumeWidth = window.width;
    return state.transferFunctionId;
  }

  const DEFAULT_WINDOW_MULTIPLIER = 4;
  const DEFAULT_IMAGE_DYNAMIC_RANGE = 1024;

  // W/L drag sensitivity, like cornerstone3D's WindowLevelTool: one multiplier
  // for both axes, fixed per volume — the central slice dynamic range (bounded
  // by the series' declared range) divided by 1024, rounded above 1; invalid or
  // empty input falls back to 4.
  function computeWindowLevelMultiplier(voxels, dimensions, valueRange) {
    const plane = dimensions[0] * dimensions[1];
    const start = Math.floor(dimensions[2] / 2) * plane;
    let minimum = Infinity;
    let maximum = -Infinity;
    for (let index = start; index < start + plane; index += 1) {
      const value = voxels[index];
      if (value < minimum) minimum = value;
      if (value > maximum) maximum = value;
    }
    const measuredSpan = maximum - minimum;
    const declaredSpan = Number(valueRange[1]) - Number(valueRange[0]);
    const span = Math.min(
      Number.isFinite(measuredSpan) ? measuredSpan : Infinity,
      Number.isFinite(declaredSpan) ? declaredSpan : Infinity
    );
    const ratio = span / DEFAULT_IMAGE_DYNAMIC_RANGE;
    if (!Number.isFinite(ratio) || ratio <= 0) return DEFAULT_WINDOW_MULTIPLIER;
    return ratio > 1 ? Math.round(ratio) : ratio;
  }

  function windowDragMultiplier(drag) {
    const multiplier = Number(drag.multiplier);
    return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : DEFAULT_WINDOW_MULTIPLIER;
  }

  function applyVolumetricToolDrag(state, drag, dx, dy) {
    if (!state || !drag) return state;
    if (drag.mode === "mpr") {
      if (drag.tool === "window") {
        const rate = windowDragMultiplier(drag);
        state.mprWidth = Math.max(1, drag.width + dx * rate);
        state.mprCenter = drag.center + dy * rate;
      } else if (drag.tool === "pan" && state.mprTransforms && state.mprTransforms[drag.plane]) {
        state.mprTransforms[drag.plane].panX = drag.panX + dx;
        state.mprTransforms[drag.plane].panY = drag.panY + dy;
      } else if (drag.tool === "zoom" && state.mprTransforms && state.mprTransforms[drag.plane]) {
        state.mprTransforms[drag.plane].zoom = clamp(drag.zoom * Math.exp(-dy * 0.01), MPR_MIN_ZOOM, MPR_MAX_ZOOM);
      } else if (drag.tool === "scroll" && Array.isArray(state.crosshair)) {
        // Vertical drag traverses plane slices: about 8 px per slice.
        state.crosshair[drag.axis] = clamp(Math.round(drag.slice + dy / 8), 0, drag.axisSize - 1);
      }
      return state;
    }
    if (drag.mode === "volume") {
      if (drag.tool === "window") {
        const rate = windowDragMultiplier(drag);
        state.volumeWidth = Math.max(1, drag.width + dx * rate);
        state.volumeCenter = drag.center + dy * rate;
      } else if (drag.tool === "pan") {
        state.volumePanX = drag.panX + dx;
        state.volumePanY = drag.panY + dy;
      } else if (drag.tool === "zoom") {
        state.zoom = clamp(drag.zoom * Math.exp(-dy * 0.01), VOLUME_MIN_ZOOM, VOLUME_MAX_ZOOM);
      } else if (drag.tool === "rotate") {
        state.yaw = drag.yaw - dx * 0.008;
        state.pitch = clamp(drag.pitch - dy * 0.008, -1.35, 1.35);
      }
    }
    return state;
  }


  volume.transfer = {
    MAX_TRANSFER_STOPS,
    MAX_RAY_STEPS,
    PREVIEW_RAY_STEPS,
    SETTLE_DELAY_MS,
    QUALITY_STEPS,
    DEFAULT_QUALITY_STEPS,
    VIEW_MODES,
    MPR_TOOLS,
    VOLUME_TOOLS,
    MPR_DEFAULT_ZOOM,
    VOLUME_DEFAULT_ZOOM,
    VOLUME_MIN_ZOOM,
    VOLUME_MAX_ZOOM,
    TRANSFER_FUNCTIONS,
    TRANSFER_HU_DOMAIN,
    DEFAULT_TRANSFER_FUNCTION_ID,
    STYLE_TEXT,
    ensureStyles,
    clamp,
    finiteOr,
    getTransferFunction,
    srgbToLinear,
    transferDomainMapping,
    sampleTransferStops,
    transferFunctionDomain,
    transferFunctionWindow,
    packTransferFunction,
    selectTransferFunction,
    computeWindowLevelMultiplier,
    applyVolumetricToolDrag,
  };
})(window);
