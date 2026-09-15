(function (global) {
  "use strict";

  const STYLE_TEXT = `
.dsv-root{--dsv-bg:#05070a;--dsv-panel:#10151b;--dsv-line:#27313b;--dsv-text:#f4f7fa;--dsv-muted:#9aa8b5;--dsv-accent:#38bdf8;position:relative;width:100%;height:100%;min-height:280px;display:grid;grid-template-rows:auto minmax(0,1fr) auto;overflow:hidden;background:var(--dsv-bg);color:var(--dsv-text);font:500 13px/1.3 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;border-radius:inherit;outline:none}
.dsv-root:focus-visible{box-shadow:inset 0 0 0 2px var(--dsv-accent)}
.dsv-toolbar{min-height:42px;display:flex;align-items:center;gap:6px;padding:6px 8px;background:linear-gradient(180deg,#151b22,#0c1015);border-bottom:1px solid var(--dsv-line);overflow-x:auto;scrollbar-width:thin}
.dsv-title{min-width:0;max-width:260px;margin-right:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#dce6ee;font-weight:700}
.dsv-group{display:flex;align-items:center;gap:4px;padding-left:6px;border-left:1px solid var(--dsv-line)}
.dsv-volume-modes{border-left-color:#36515f}.dsv-root:not([data-view-mode="stack"]) .dsv-tool-group{display:none}.dsv-root:not([data-view-mode="stack"]) .dsv-footer{display:none}.dsv-root:not([data-view-mode="stack"]) .dsv-stage>.dsv-canvas,.dsv-root:not([data-view-mode="stack"]) .dsv-stage>.dsv-overlay{visibility:hidden}
.dsv-button{appearance:none;border:1px solid #34414d;background:#17202a;color:#dce5ec;border-radius:6px;padding:5px 8px;font:inherit;line-height:1;white-space:nowrap;cursor:pointer}
.dsv-button:hover{background:#22303d}.dsv-button[aria-pressed="true"]{border-color:var(--dsv-accent);background:#0d3345;color:#e6f8ff}.dsv-button:disabled{opacity:.45;cursor:default}
.dsv-stage{position:relative;min-height:0;overflow:hidden;background:#000;touch-action:none;user-select:none;cursor:crosshair}
.dsv-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.dsv-overlay{position:absolute;z-index:2;pointer-events:none;padding:8px 10px;color:#eaf6ff;text-shadow:0 1px 2px #000,0 0 4px #000;font-size:12px;white-space:pre-line}
.dsv-overlay-left{top:0;left:0}.dsv-overlay-right{top:0;right:0;text-align:right}.dsv-overlay-bottom{bottom:0;left:0;color:#c4d2dc}
.dsv-loading{position:absolute;inset:0;z-index:3;display:grid;place-items:center;background:rgba(0,0,0,.42);color:#fff;font-weight:700;letter-spacing:.02em;transition:opacity .15s}.dsv-loading[hidden]{display:none}
.dsv-footer{display:grid;grid-template-columns:auto minmax(80px,1fr) auto;align-items:center;gap:8px;padding:6px 10px;background:#0d1218;border-top:1px solid var(--dsv-line);color:var(--dsv-muted)}
.dsv-root[data-controls="external"]{grid-template-rows:minmax(0,1fr) auto}
.dsv-root[data-controls="external"] .dsv-toolbar{display:none}
.dsv-slider{width:100%;accent-color:var(--dsv-accent)}.dsv-counter{font-variant-numeric:tabular-nums;color:#d7e0e7}.dsv-hint{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsv-error{position:absolute;inset:0;z-index:5;display:grid;place-items:center;padding:24px;background:#12080a;color:#ffd7dc;text-align:center;white-space:pre-wrap}
.dsv-volume-toast{position:absolute;z-index:12;left:50%;bottom:18px;max-width:min(520px,86%);transform:translateX(-50%);padding:10px 13px;border:1px solid #72414a;border-radius:7px;background:rgba(38,12,17,.96);color:#ffd7dc;text-align:center;box-shadow:0 10px 32px rgba(0,0,0,.48)}
@media(max-width:700px){.dsv-title{display:none}.dsv-hint{display:none}.dsv-toolbar{gap:4px}.dsv-button{padding:5px 7px}.dsv-group{padding-left:4px}}
`;

  function ensureStyles(root) {
    if (!root || !root.querySelector) return;
    if (root.querySelector("style[data-dicom-slide-viewer-style]")) return;
    const style = document.createElement("style");
    style.dataset.dicomSlideViewerStyle = "true";
    style.textContent = STYLE_TEXT;
    if (root instanceof Document) root.head.appendChild(style);
    else root.appendChild(style);
  }


  const data = global.__DicomSlideInternal && global.__DicomSlideInternal.data;
  if (!data) throw new Error("DICOM Slide data registry must load before the 2D viewer.");
  const { loadManifest, loadChunk, findChunk, hasDecodedChunk } = data;
  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  const STACK_MIN_ZOOM = 0.1;
  const STACK_MAX_ZOOM = 40;
  const STACK_DEFAULT_ZOOM = 1.3;

  // Fixed window presets in the toolbar; "default" resolves to the series'
  // default window (defaultWindow in the manifest). Shortcuts: keys 1 through 5.
  const WINDOW_PRESETS = Object.freeze([
    { id: "default", label: "Default", center: null, width: null },
    { id: "abdomen", label: "Abdomen", center: 60, width: 400 },
    { id: "lung", label: "Lung", center: -600, width: 1500 },
    { id: "bone", label: "Bone", center: 400, width: 1800 },
    { id: "brain", label: "Brain", center: 40, width: 80 },
  ]);

  function roundDisplay(value) {
    if (Math.abs(value) >= 100) return Math.round(value).toString();
    return (Math.round(value * 10) / 10).toString();
  }

  class Viewer {
    constructor(container, options) {
      if (!(container instanceof Element) && !(container instanceof ShadowRoot)) {
        throw new TypeError("Viewer requires a DOM container.");
      }
      this.container = container;
      this.options = Object.assign(
        {
          caseId: null,
          manifestUrl: null,
          initialPreset: null,
          smoothing: true,
          compact: false,
          controls: "internal",
          studyTitle: null,
          seriesTitle: null,
          seriesNumber: null,
        },
        options || {}
      );
      if (!this.options.caseId || !this.options.manifestUrl) {
        throw new TypeError("Viewer requires caseId and manifestUrl options.");
      }
      ensureStyles(container.getRootNode ? container.getRootNode() : document);
      this.state = {
        slice: 0,
        center: 40,
        width: 80,
        zoom: STACK_DEFAULT_ZOOM,
        panX: 0,
        panY: 0,
        activeTool: "window",
        preset: "default",
        expanded: false,
        mode: "stack",
      };
      this.manifest = null;
      this.pixelData = null;
      this.loadToken = 0;
      this.renderPending = false;
      this.remapNeeded = true;
      this.drag = null;
      this.destroyed = false;
      this.wheelAccumulator = 0;
      this.volumeCapability = { supported: false, reason: "Volumetric module has not been initialized yet" };
      this.volumeData = null;
      this.volumeView = null;
      this.volumeLoadPromise = null;
      this.volumeAbortController = null;
      this.volumeModeToken = 0;
      this._build();
      this._bind();
      this.ready = this._initialize();
    }

    _build() {
      const root = document.createElement("div");
      root.className = "dsv-root";
      root.tabIndex = 0;
      root.setAttribute("role", "application");
      root.setAttribute("aria-label", "Interactive medical viewer");
      root.dataset.viewMode = "stack";
      root.dataset.controls = this.options.controls === "external" ? "external" : "internal";
      root.innerHTML = `
        <div class="dsv-toolbar">
          <div class="dsv-title">Loading study…</div>
          <div class="dsv-group dsv-tool-group" aria-label="Interaction tool">
            <button class="dsv-button" type="button" data-tool="window" aria-pressed="true" title="Window/Level (W)">W/L</button>
            <button class="dsv-button" type="button" data-tool="pan" aria-pressed="false" title="Pan (M)">Pan</button>
            <button class="dsv-button" type="button" data-tool="zoom" aria-pressed="false" title="Zoom (Z)">Zoom</button>
            <button class="dsv-button" type="button" data-tool="scroll" aria-pressed="false" title="Scroll (S)">Scroll</button>
          </div>
          <div class="dsv-group dsv-presets" aria-label="Window presets"></div>
          <div class="dsv-group dsv-volume-modes" aria-label="View mode">
            <button class="dsv-button" type="button" data-view-mode="stack" aria-pressed="true" title="2D view">2D</button>
            <button class="dsv-button" type="button" data-view-mode="mpr" aria-pressed="false" disabled title="MPR unavailable">MPR</button>
            <button class="dsv-button" type="button" data-view-mode="volume" aria-pressed="false" disabled title="3D unavailable">3D</button>
          </div>
          <div class="dsv-group">
            <button class="dsv-button" type="button" data-action="reset" title="Reset">Reset</button>
            <button class="dsv-button" type="button" data-action="expand" aria-label="Expand viewer" aria-pressed="false" title="Expand viewer on the slide">⛶</button>
          </div>
        </div>
        <div class="dsv-stage">
          <canvas class="dsv-canvas"></canvas>
          <div class="dsv-overlay dsv-overlay-left"></div>
          <div class="dsv-overlay dsv-overlay-right"></div>
          <div class="dsv-overlay dsv-overlay-bottom">Left drag: tool · wheel: slices · right drag: zoom · middle/Shift: pan</div>
          <div class="dsv-loading">Loading pixels…</div>
          <div class="dsv-volume-layer" hidden></div>
        </div>
        <div class="dsv-footer">
          <span class="dsv-counter">0 / 0</span>
          <input class="dsv-slider" type="range" min="0" max="0" value="0" step="1" aria-label="Slice" />
          <span class="dsv-hint">W/M/Z/S/R · D: 2D/MPR/3D · 1–5: presets</span>
        </div>`;
      this.container.replaceChildren(root);
      this.root = root;
      this.stage = root.querySelector(".dsv-stage");
      this.canvas = root.querySelector(".dsv-canvas");
      this.context = this.canvas.getContext("2d", { alpha: false });
      this.titleElement = root.querySelector(".dsv-title");
      this.leftOverlay = root.querySelector(".dsv-overlay-left");
      this.rightOverlay = root.querySelector(".dsv-overlay-right");
      this.loadingElement = root.querySelector(".dsv-loading");
      this.counterElement = root.querySelector(".dsv-counter");
      this.slider = root.querySelector(".dsv-slider");
      this.presetsElement = root.querySelector(".dsv-presets");
      this.volumeLayer = root.querySelector(".dsv-volume-layer");
      this.offscreen = document.createElement("canvas");
      this.offscreenContext = this.offscreen.getContext("2d", { alpha: false });
    }

    _bind() {
      this.onPointerDown = (event) => this._pointerDown(event);
      this.onPointerMove = (event) => this._pointerMove(event);
      this.onPointerUp = (event) => this._pointerUp(event);
      this.onWheel = (event) => this._wheel(event);
      this.onKeyDown = (event) => this._keyDown(event);
      this.onDoubleClick = () => this.reset();
      this.onContextMenu = (event) => event.preventDefault();
      this.stage.addEventListener("pointerdown", this.onPointerDown);
      this.stage.addEventListener("pointermove", this.onPointerMove);
      this.stage.addEventListener("pointerup", this.onPointerUp);
      this.stage.addEventListener("pointercancel", this.onPointerUp);
      this.stage.addEventListener("wheel", this.onWheel, { passive: false });
      this.stage.addEventListener("dblclick", this.onDoubleClick);
      this.stage.addEventListener("contextmenu", this.onContextMenu);
      this.root.addEventListener("keydown", this.onKeyDown);
      this.root.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (!button) return;
        if (button.dataset.tool) this.setActiveTool(button.dataset.tool);
        if (button.dataset.preset) this.setPreset(button.dataset.preset);
        if (button.dataset.viewMode) this.setMode(button.dataset.viewMode).catch((error) => this._showVolumeError(error));
        if (button.dataset.action === "reset") this.reset();
        if (button.dataset.action === "expand") this.requestExpandedToggle();
      });
      this.slider.addEventListener("input", () => this.setSlice(Number(this.slider.value)));
      this.resizeObserver = new ResizeObserver(() => this.scheduleRender(false));
      this.resizeObserver.observe(this.stage);
    }

    async _initialize() {
      try {
        this.manifest = await loadManifest(this.options.caseId, this.options.manifestUrl);
        const dimensions = this.manifest.dimensions;
        this.offscreen.width = dimensions.columns;
        this.offscreen.height = dimensions.rows;
        this.imageData = this.offscreenContext.createImageData(dimensions.columns, dimensions.rows);
        this.slider.max = String(dimensions.slices - 1);
        this.titleElement.textContent = this.manifest.title || this.options.caseId;
        this.isColor = this.manifest.pixelType === "rgb8";
        this._buildPresetButtons();
        this._configureVolumeButtons();
        if (this.isColor) {
          this.root.querySelector("[data-tool='window']").style.display = "none";
          this.presetsElement.style.display = "none";
          this.root.querySelector(".dsv-overlay-bottom").textContent = "Drag: pan · wheel: images · right drag: zoom";
          this.root.querySelector(".dsv-hint").textContent = "M/Z/S · arrows · MPR/3D unavailable";
          this.setActiveTool("pan");
        }
        this.state.center = Number(this.manifest.defaultWindow.center);
        this.state.width = Number(this.manifest.defaultWindow.width);
        const requestedPreset = this.options.initialPreset;
        if (requestedPreset) {
          const preset = WINDOW_PRESETS.find((entry) => entry.id === requestedPreset);
          if (preset) {
            this.state.preset = preset.id;
            if (preset.center !== null) {
              this.state.center = Number(preset.center);
              this.state.width = Number(preset.width);
            }
          }
        }
        this.state.slice = clamp(Number(this.manifest.initialSlice || 0), 0, dimensions.slices - 1);
        await this.setSlice(this.state.slice);
        this.loadingElement.hidden = true;
        this._emit("viewerready", this.getState());
        return this;
      } catch (error) {
        this._showError(error);
        throw error;
      }
    }

    _buildPresetButtons() {
      this.presetsElement.replaceChildren();
      WINDOW_PRESETS.forEach((preset, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "dsv-button";
        button.dataset.preset = preset.id;
        button.textContent = preset.label;
        button.title = preset.center === null
          ? `Series default window (${index + 1})`
          : `WL ${roundDisplay(preset.center)} WW ${roundDisplay(preset.width)} (${index + 1})`;
        this.presetsElement.appendChild(button);
      });
    }

    _configureVolumeButtons() {
      const api = global.DicomSlideVolume;
      this.volumeCapability = api && typeof api.canLoadManifest === "function"
        ? api.canLoadManifest(this.manifest)
        : { supported: false, reason: "MPR/3D module was not loaded" };
      this.root.querySelectorAll("[data-view-mode]").forEach((button) => {
        const isStack = button.dataset.viewMode === "stack";
        button.disabled = !isStack && !this.volumeCapability.supported;
        const label = isStack
          ? "2D view"
          : button.dataset.viewMode === "mpr" ? "multiplanar MPR" : "3D volume rendering";
        button.title = this.volumeCapability.supported
          ? `Open ${label} (D)`
          : isStack ? "Open 2D view (D)" : `${label} unavailable: ${this.volumeCapability.reason}`;
      });
    }

    _showVolumeLoading(progress) {
      if (!this.volumeLayer) return;
      let panel = this.volumeLayer.querySelector(".dsv-volume-loading");
      if (!panel) {
        panel = document.createElement("div");
        panel.className = "dsv-volume-loading";
        panel.innerHTML = `<div class="dsv-volume-loading-card"><strong>Preparing MPR/3D…</strong><div class="dsv-volume-progress"><span></span></div><small>Assembling the volume from the active series chunks.</small></div>`;
        this.volumeLayer.replaceChildren(panel);
      }
      panel.dataset.error = "false";
      const fraction = clamp(Number(progress && progress.fraction) || 0, 0, 1);
      const bar = panel.querySelector(".dsv-volume-progress span");
      const strong = panel.querySelector("strong");
      const detail = panel.querySelector("small");
      if (bar) bar.style.width = `${Math.round(fraction * 100)}%`;
      if (strong) strong.textContent = progress && progress.phase ? progress.phase : "Preparing MPR/3D…";
      if (detail) {
        const loaded = Number(progress && progress.loadedBytes) || 0;
        const total = Number(progress && progress.totalBytes) || 0;
        detail.textContent = total > 0
          ? `${(loaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MiB compressed`
          : "Assembling the volume from the active series chunks.";
      }
      this._emit("volumeprogress", Object.assign(this.getState(), { progress: progress || null }));
    }

    _showVolumeError(error) {
      if (!this.root || this.destroyed) return;
      const existing = this.stage.querySelector(".dsv-volume-toast");
      if (existing) existing.remove();
      const toast = document.createElement("div");
      toast.className = "dsv-volume-toast";
      toast.setAttribute("role", "alert");
      toast.textContent = `MPR/3D unavailable: ${error && error.message ? error.message : String(error)}`;
      this.stage.appendChild(toast);
      global.setTimeout(() => toast.remove(), 6000);
      console.error(error);
    }

    _updateModeUi() {
      const mode = this.state.mode;
      this.root.dataset.viewMode = mode;
      this.volumeLayer.hidden = mode === "stack";
      this.root.querySelectorAll("[data-view-mode]").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.viewMode === mode));
      });
      if (mode === "stack") {
        this.stage.style.cursor = this._stackToolCursor(this.state.activeTool);
      } else {
        this.stage.style.cursor = "default";
        this.loadingElement.hidden = true;
      }
    }

    _onVolumeStateChange(volumeState) {
      if (!volumeState || this.destroyed) return;
      const previousSlice = this.state.slice;
      const previousCenter = this.state.center;
      const previousWidth = this.state.width;
      this.state.slice = clamp(Math.round(Number(volumeState.nativeSlice)), 0, this.manifest.dimensions.slices - 1);
      this.state.center = Number(volumeState.center);
      this.state.width = Math.max(1, Number(volumeState.width));
      this._updateOverlay();
      if (this.state.slice !== previousSlice) this._emit("slicechange", this.getState());
      if (this.state.center !== previousCenter || this.state.width !== previousWidth) this._emit("windowchange", this.getState());
      this._emit("viewchange", this.getState());
    }

    async setMode(requestedMode) {
      if (!this.manifest || this.destroyed) return;
      const mode = ["stack", "mpr", "volume"].includes(requestedMode) ? requestedMode : "stack";
      const token = ++this.volumeModeToken;

      if (mode === "stack") {
        this.state.mode = "stack";
        if (this.volumeAbortController && !this.volumeData) {
          const controller = this.volumeAbortController;
          this.volumeAbortController = null;
          this.volumeLoadPromise = null;
          controller.abort();
        }
        if (this.volumeView) this._onVolumeStateChange(this.volumeView.getState());
        this._updateModeUi();
        await this.setSlice(this.state.slice);
        if (!this.destroyed && token === this.volumeModeToken) this._emit("modechange", this.getState());
        return this;
      }

      if (!this.volumeCapability.supported) {
        const error = new Error(this.volumeCapability.reason || "Series is not compatible with MPR/3D");
        this._showVolumeError(error);
        return this;
      }

      this.state.mode = mode;
      this._updateModeUi();
      if (this.volumeView) {
        this.volumeView.setMode(mode);
        this._emit("modechange", this.getState());
        return this;
      }

      this._showVolumeLoading({ phase: "Preparing MPR/3D", fraction: 0 });
      try {
        if (!this.volumeData) {
          if (!this.volumeLoadPromise) {
            const controller = new AbortController();
            this.volumeAbortController = controller;
            const api = global.DicomSlideVolume;
            const promise = api.loadFromManifest(this.manifest, {
              signal: controller.signal,
              onProgress: (progress) => this._showVolumeLoading(progress),
            });
            let trackedPromise;
            trackedPromise = promise.then(
              (volume) => {
                if (this.volumeLoadPromise === trackedPromise) {
                  this.volumeData = volume;
                  this.volumeLoadPromise = null;
                  this.volumeAbortController = null;
                }
                return volume;
              },
              (error) => {
                if (this.volumeLoadPromise === trackedPromise) {
                  this.volumeLoadPromise = null;
                  this.volumeAbortController = null;
                }
                throw error;
              }
            );
            this.volumeLoadPromise = trackedPromise;
          }
          await this.volumeLoadPromise;
        }
        if (this.destroyed || token !== this.volumeModeToken || this.state.mode === "stack") return this;
        this.volumeView = new global.DicomSlideVolume.VolumeViewer(this.volumeLayer, this.volumeData, {
          initialMode: mode,
          initialSlice: this.state.slice,
          center: this.state.center,
          width: this.state.width,
          onStateChange: (state) => this._onVolumeStateChange(state),
        });
        this.volumeView.setMode(mode, false);
        this._onVolumeStateChange(this.volumeView.getState());
        this._emit("modechange", this.getState());
      } catch (error) {
        if (error && error.name === "AbortError") return this;
        if (token !== this.volumeModeToken) return this;
        this.state.mode = "stack";
        this._updateModeUi();
        this._showVolumeError(error);
        this._emit("modechange", this.getState());
      }
      return this;
    }

    _showError(error) {
      this.loadingElement.hidden = true;
      const panel = document.createElement("div");
      panel.className = "dsv-error";
      panel.textContent = `Viewer error\n${error && error.message ? error.message : String(error)}`;
      this.root.appendChild(panel);
      console.error(error);
    }

    _emit(type, detail) {
      this.root.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, detail }));
    }

    getState() {
      return {
        caseId: this.options.caseId,
        slice: this.state.slice,
        center: this.state.center,
        width: this.state.width,
        zoom: this.state.zoom,
        panX: this.state.panX,
        panY: this.state.panY,
        activeTool: this.state.activeTool,
        preset: this.state.preset,
        expanded: this.state.expanded,
        mode: this.state.mode,
        volumeReady: Boolean(this.volumeView),
        volumeMetrics: this.volumeData ? this.volumeData.metrics : null,
        volumeSupported: Boolean(this.volumeCapability.supported),
        volumeReason: this.volumeCapability.reason || null,
        isColor: Boolean(this.isColor),
        totalSlices: this.manifest ? this.manifest.dimensions.slices : 0,
      };
    }

    _stackToolCursor(tool) {
      return tool === "pan" ? "grab" : tool === "zoom" ? "ns-resize" : tool === "scroll" ? "row-resize" : "crosshair";
    }

    setActiveTool(tool) {
      if (!["window", "pan", "zoom", "scroll"].includes(tool)) return;
      if (this.isColor && tool === "window") return;
      this.state.activeTool = tool;
      this.root.querySelectorAll("[data-tool]").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.tool === tool));
      });
      this.stage.style.cursor = this._stackToolCursor(tool);
      this._updateOverlay();
      this._emit("toolchange", this.getState());
    }

    async setSlice(value) {
      if (!this.manifest) return;
      const slice = clamp(Math.round(value), 0, this.manifest.dimensions.slices - 1);
      this.state.slice = slice;
      this.slider.value = String(slice);
      this._updateOverlay();
      if (this.state.mode !== "stack") {
        if (this.volumeView) this.volumeView.setNativeSlice(slice);
        this._emit("slicechange", this.getState());
        return;
      }
      const token = ++this.loadToken;
      const chunkIndex = findChunk(this.manifest, slice);
      if (chunkIndex < 0) throw new Error(`No chunk contains slice ${slice}.`);
      if (!hasDecodedChunk(this.manifest.caseId, chunkIndex)) this.loadingElement.hidden = false;
      const chunk = await loadChunk(this.manifest, chunkIndex);
      if (this.destroyed || token !== this.loadToken) return;
      const spec = this.manifest.chunks[chunkIndex];
      const pixelsPerSlice = this.manifest.dimensions.columns * this.manifest.dimensions.rows * (this.isColor ? 3 : 1);
      const local = slice - spec.firstSlice;
      const start = local * pixelsPerSlice;
      this.pixelData = chunk.subarray(start, start + pixelsPerSlice);
      this.loadingElement.hidden = true;
      this.scheduleRender(true);
      this._emit("slicechange", this.getState());
      this._prefetch(chunkIndex, local, spec.sliceCount);
    }

    _prefetch(chunkIndex, localIndex, count) {
      const candidates = [];
      if (localIndex >= count - 3) candidates.push(chunkIndex + 1);
      if (localIndex <= 2) candidates.push(chunkIndex - 1);
      candidates.forEach((index) => {
        if (index >= 0 && index < this.manifest.chunks.length) {
          setTimeout(() => loadChunk(this.manifest, index).catch(() => {}), 20);
        }
      });
    }

    setWindow(center, width) {
      if (this.isColor) return;
      this.state.center = Number(center);
      this.state.width = Math.max(1, Number(width));
      if (this.state.mode !== "stack" && this.volumeView) {
        this.volumeView.setWindow(this.state.center, this.state.width);
        return;
      }
      this.scheduleRender(true);
      this._emit("windowchange", this.getState());
    }

    setPreset(id) {
      if (this.isColor || !this.manifest) return;
      const preset = WINDOW_PRESETS.find((entry) => entry.id === id);
      if (!preset) return;
      this.state.preset = preset.id;
      if (preset.center === null) {
        this.setWindow(this.manifest.defaultWindow.center, this.manifest.defaultWindow.width);
      } else {
        this.setWindow(preset.center, preset.width);
      }
    }

    setZoom(value) {
      if (this.state.mode !== "stack") return;
      this.state.zoom = clamp(Number(value), STACK_MIN_ZOOM, STACK_MAX_ZOOM);
      this.scheduleRender(false);
      this._emit("viewchange", this.getState());
    }

    reset() {
      if (!this.manifest) return;
      if (this.state.mode !== "stack" && this.volumeView) {
        this.volumeView.resetCurrent();
        return;
      }
      this.state.zoom = STACK_DEFAULT_ZOOM;
      this.state.panX = 0;
      this.state.panY = 0;
      this.state.preset = "default";
      if (!this.isColor) {
        this.state.center = Number(this.manifest.defaultWindow.center);
        this.state.width = Number(this.manifest.defaultWindow.width);
      }
      this.scheduleRender(true);
      this._emit("viewchange", this.getState());
    }

    requestExpandedToggle() {
      this._emit("expandrequest", Object.assign(this.getState(), { expanded: !this.state.expanded }));
    }

    setExpanded(value) {
      this.state.expanded = Boolean(value);
      const button = this.root.querySelector("[data-action='expand']");
      if (button) {
        button.setAttribute("aria-pressed", String(this.state.expanded));
        button.setAttribute("aria-label", this.state.expanded ? "Restore viewer on the slide" : "Expand viewer");
        button.title = this.state.expanded ? "Restore viewer on the slide" : "Expand viewer on the slide";
        button.textContent = this.state.expanded ? "↙" : "⛶";
      }
      this.scheduleRender(false);
    }

    _pointerDown(event) {
      if (this.state.mode !== "stack" || !this.pixelData) return;
      this.root.focus({ preventScroll: true });
      this.stage.setPointerCapture(event.pointerId);
      let tool = this.state.activeTool;
      if (event.button === 2 || event.altKey) tool = "zoom";
      else if (event.button === 1 || event.shiftKey) tool = "pan";
      else if (this.isColor && tool === "window") tool = "pan";
      this.drag = {
        pointerId: event.pointerId,
        tool,
        x: event.clientX,
        y: event.clientY,
        center: this.state.center,
        width: this.state.width,
        zoom: this.state.zoom,
        panX: this.state.panX,
        panY: this.state.panY,
        slice: this.state.slice,
      };
      if (tool === "pan") this.stage.style.cursor = "grabbing";
      event.preventDefault();
    }

    _pointerMove(event) {
      if (!this.drag || event.pointerId !== this.drag.pointerId) return;
      const dx = event.clientX - this.drag.x;
      const dy = event.clientY - this.drag.y;
      if (this.drag.tool === "window") {
        const widthRate = Math.max(1.5, this.drag.width / 220);
        const centerRate = Math.max(0.75, this.drag.width / 440);
        this.state.width = Math.max(1, this.drag.width + dx * widthRate);
        this.state.center = this.drag.center + dy * centerRate;
        this.scheduleRender(true);
      } else if (this.drag.tool === "pan") {
        this.state.panX = this.drag.panX + dx;
        this.state.panY = this.drag.panY + dy;
        this.scheduleRender(false);
      } else if (this.drag.tool === "zoom") {
        this.state.zoom = clamp(this.drag.zoom * Math.exp(-dy * 0.01), STACK_MIN_ZOOM, STACK_MAX_ZOOM);
        this.scheduleRender(false);
      } else if (this.drag.tool === "scroll") {
        // Vertical drag navigates slices: about 12 px per slice.
        const target = this.drag.slice + Math.round(dy / 12);
        if (target !== this.state.slice) this.setSlice(target).catch(() => {});
      }
      event.preventDefault();
    }

    _pointerUp(event) {
      if (!this.drag || event.pointerId !== this.drag.pointerId) return;
      try {
        this.stage.releasePointerCapture(event.pointerId);
      } catch (_) {}
      this.drag = null;
      this.stage.style.cursor = this._stackToolCursor(this.state.activeTool);
      this._emit("viewchange", this.getState());
    }

    _wheel(event) {
      if (this.state.mode !== "stack") return;
      event.preventDefault();
      this.root.focus({ preventScroll: true });
      if (event.ctrlKey || event.metaKey) {
        const factor = Math.exp(-event.deltaY * 0.0025);
        this.setZoom(this.state.zoom * factor);
        return;
      }
      this.wheelAccumulator += event.deltaY;
      if (Math.abs(this.wheelAccumulator) < 20) return;
      const step = this.wheelAccumulator > 0 ? 1 : -1;
      this.wheelAccumulator = 0;
      this.setSlice(this.state.slice + step).catch((error) => this._showError(error));
    }

    // Selects the active tool for the current mode: 2D uses the stack toolbar,
    // while MPR and 3D forward the selection to VolumeViewer.
    _setToolShortcut(tool) {
      if (this.state.mode === "stack") this.setActiveTool(tool);
      else if (this.volumeView) this.volumeView.setTool(tool);
    }

    _keyDown(event) {
      const key = event.key.toLowerCase();
      if (event.target && /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return;
      if (key === "escape" && this.state.mode !== "stack") {
        this.setMode("stack");
        event.preventDefault();
        return;
      }
      if (key === "d") {
        // Alterna 2D → MPR → 3D → 2D.
        const order = ["stack", "mpr", "volume"];
        let next = order[(order.indexOf(this.state.mode) + 1) % order.length];
        if (!this.volumeCapability.supported) next = "stack";
        this.setMode(next).catch((error) => this._showVolumeError(error));
        event.preventDefault();
        return;
      }
      if (["arrowdown", "arrowright", "]", "pagedown"].includes(key)) {
        if (this.state.mode !== "stack" && this.volumeView) this.volumeView.stepAxial(1);
        else this.setSlice(this.state.slice + 1);
        event.preventDefault();
      } else if (["arrowup", "arrowleft", "[", "pageup"].includes(key)) {
        if (this.state.mode !== "stack" && this.volumeView) this.volumeView.stepAxial(-1);
        else this.setSlice(this.state.slice - 1);
        event.preventDefault();
      } else if (key === "home") {
        this.setSlice(0);
        event.preventDefault();
      } else if (key === "end") {
        this.setSlice(this.manifest.dimensions.slices - 1);
        event.preventDefault();
      } else if (key === "w" && !this.isColor) this._setToolShortcut("window");
      else if (key === "m") this._setToolShortcut("pan");
      else if (key === "z") this._setToolShortcut("zoom");
      else if (key === "s") this._setToolShortcut("scroll");
      else if (key === "r") this._setToolShortcut("rotate");
      else if (key === "+" || key === "=") this.setZoom(this.state.zoom * 1.15);
      else if (key === "-") this.setZoom(this.state.zoom / 1.15);
      else if (["1", "2", "3", "4", "5"].includes(key)) {
        const preset = WINDOW_PRESETS[Number(key) - 1];
        if (preset) this.setPreset(preset.id);
      }
    }

    scheduleRender(remap) {
      if (remap) this.remapNeeded = true;
      this._updateOverlay();
      if (this.renderPending) return;
      this.renderPending = true;
      requestAnimationFrame(() => {
        this.renderPending = false;
        this._render();
      });
    }

    _render() {
      if (!this.pixelData || !this.manifest || this.destroyed) return;
      if (this.remapNeeded) {
        const target = this.imageData.data;
        if (this.isColor) {
          for (let index = 0, output = 0; index < this.pixelData.length; index += 3, output += 4) {
            target[output] = this.pixelData[index];
            target[output + 1] = this.pixelData[index + 1];
            target[output + 2] = this.pixelData[index + 2];
            target[output + 3] = 255;
          }
        } else {
          const center = this.state.center;
          const width = Math.max(1, this.state.width);
          const low = center - width / 2;
          const factor = 255 / width;
          for (let index = 0, output = 0; index < this.pixelData.length; index += 1, output += 4) {
            let value = Math.round((this.pixelData[index] - low) * factor);
            if (value < 0) value = 0;
            else if (value > 255) value = 255;
            if (this.manifest.invert) value = 255 - value;
            target[output] = value;
            target[output + 1] = value;
            target[output + 2] = value;
            target[output + 3] = 255;
          }
        }
        this.offscreenContext.putImageData(this.imageData, 0, 0);
        this.remapNeeded = false;
      }
      this._drawDisplay();
    }

    _drawDisplay() {
      const rect = this.stage.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(2, global.devicePixelRatio || 1);
      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(height * dpr));
      if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
        this.canvas.width = pixelWidth;
        this.canvas.height = pixelHeight;
      }
      const context = this.context;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.fillStyle = "#000";
      context.fillRect(0, 0, width, height);
      context.imageSmoothingEnabled = Boolean(this.options.smoothing);
      const columns = this.manifest.dimensions.columns;
      const rows = this.manifest.dimensions.rows;
      const fit = Math.min(width / columns, height / rows);
      const scale = fit * this.state.zoom;
      const drawWidth = columns * scale;
      const drawHeight = rows * scale;
      const x = (width - drawWidth) / 2 + this.state.panX;
      const y = (height - drawHeight) / 2 + this.state.panY;
      context.drawImage(this.offscreen, x, y, drawWidth, drawHeight);
      context.setTransform(1, 0, 0, 1, 0, 0);
    }

    _updateOverlay() {
      if (!this.manifest) return;
      const total = this.manifest.dimensions.slices;
      const coordinate = this.manifest.sliceCoordinates ? this.manifest.sliceCoordinates[this.state.slice] : null;
      const identifiers = [];
      if (this.options.studyTitle) identifiers.push(this.options.studyTitle);
      if (this.options.seriesTitle) {
        const prefix = this.options.seriesNumber == null ? "Series" : `Series ${this.options.seriesNumber}`;
        identifiers.push(`${prefix} · ${this.options.seriesTitle}`);
      }
      identifiers.push(
        this.manifest.modality || "IMG",
        `${this.manifest.dimensions.columns} × ${this.manifest.dimensions.rows}`,
        `${this.manifest.spacing.slice} mm`,
      );
      this.leftOverlay.textContent = identifiers.join("\n");
      const pixelStatus = this.isColor ? "RGB 8-bit" : `WL ${roundDisplay(this.state.center)}  WW ${roundDisplay(this.state.width)}`;
      this.rightOverlay.textContent = `Image ${this.state.slice + 1} / ${total}\n${pixelStatus}\nZoom ${Math.round(this.state.zoom * 100)}%${coordinate == null ? "" : `\nZ ${roundDisplay(coordinate)}`}`;
      this.counterElement.textContent = `${this.state.slice + 1} / ${total}`;
      this.slider.value = String(this.state.slice);
    }

    destroy() {
      this.destroyed = true;
      this.loadToken += 1;
      this.volumeModeToken += 1;
      if (this.volumeAbortController) this.volumeAbortController.abort();
      if (this.volumeView) this.volumeView.destroy();
      this.volumeView = null;
      this.volumeData = null;
      if (this.resizeObserver) this.resizeObserver.disconnect();
      this.stage.removeEventListener("pointerdown", this.onPointerDown);
      this.stage.removeEventListener("pointermove", this.onPointerMove);
      this.stage.removeEventListener("pointerup", this.onPointerUp);
      this.stage.removeEventListener("pointercancel", this.onPointerUp);
      this.stage.removeEventListener("wheel", this.onWheel);
      this.stage.removeEventListener("dblclick", this.onDoubleClick);
      this.stage.removeEventListener("contextmenu", this.onContextMenu);
      this.root.removeEventListener("keydown", this.onKeyDown);
      this.container.replaceChildren();
    }
  }


  global.DicomSlideViewer = {
    Viewer,
    WINDOW_PRESETS,
    styles: STYLE_TEXT,
    ensureStyles,
    loadManifest,
    version: "2.0.0",
  };
})(window);
