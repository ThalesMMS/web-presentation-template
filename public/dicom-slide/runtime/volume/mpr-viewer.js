(function (global) {
  "use strict";

  const internal = global.__DicomSlideInternal || (global.__DicomSlideInternal = {});
  const volume = internal.volume || (internal.volume = {});

  if (!volume.transfer || !volume.geometry || !volume.webgl) throw new Error("DICOM Slide MPR dependencies are missing.");
  const {
    QUALITY_STEPS, DEFAULT_QUALITY_STEPS, MPR_TOOLS, VOLUME_TOOLS,
    MPR_DEFAULT_ZOOM, VOLUME_DEFAULT_ZOOM, TRANSFER_FUNCTIONS,
    DEFAULT_TRANSFER_FUNCTION_ID, ensureStyles, clamp, finiteOr,
    getTransferFunction, transferFunctionWindow, selectTransferFunction,
    computeWindowLevelMultiplier, applyVolumetricToolDrag,
  } = volume.transfer;
  const { buildPlaneDefinitions } = volume.geometry;
  const { WebGLVolumeRenderer } = volume.webgl;
  class VolumeViewer {
    constructor(container, volume, options) {
      if (!(container instanceof Element) && !(container instanceof ShadowRoot)) {
        throw new TypeError("VolumeViewer requires a DOM container");
      }
      this.container = container;
      this.volume = volume;
      this.options = Object.assign({
        initialMode: "mpr",
        initialSlice: null,
        center: null,
        width: null,
        onStateChange: null,
      }, options || {});
      ensureStyles(container.getRootNode ? container.getRootNode() : document);
      this.voxels = volume.voxels;
      this.dimensions = volume.dimensions;
      this.spacing = volume.spacing;
      this.range = volume.valueRange;
      this.coordinateSystem = String(volume.coordinateSystem || "LPS").toUpperCase();
      this.windowLevelMultiplier = computeWindowLevelMultiplier(this.voxels, this.dimensions, this.range);
      // HU-anchored presets only make sense for Hounsfield series; other series
      // remap the canonical domain over their value range.
      this.transferDomain = String(volume.windowing && volume.windowing.unit).toUpperCase() === "HU"
        ? null
        : { minimum: this.range[0], maximum: this.range[1] };
      this.planes = buildPlaneDefinitions(volume.affine, this.coordinateSystem);
      this.cameraFrame = this._buildCameraFrame();
      const windowing = volume.windowing || {};
      this.defaultWindow = {
        center: finiteOr(windowing.center, (this.range[0] + this.range[1]) / 2),
        width: Math.max(1, finiteOr(windowing.width, Math.max(1, this.range[1] - this.range[0]))),
      };
      const center = finiteOr(this.options.center, this.defaultWindow.center);
      const width = Math.max(1, finiteOr(this.options.width, this.defaultWindow.width));
      // 3D W/L starts in the default preset's native domain (the window inherited
      // from 2D remains valid for MPR).
      const volumeWindow = transferFunctionWindow(DEFAULT_TRANSFER_FUNCTION_ID, this.transferDomain);
      this.state = {
        mode: this.options.initialMode === "volume" ? "volume" : "mpr",
        maximizedMpr: null,
        crosshair: this.dimensions.map((value) => Math.floor(value / 2)),
        mprTool: "crosshair",
        mprTransforms: {
          axial: { panX: 0, panY: 0, zoom: MPR_DEFAULT_ZOOM },
          coronal: { panX: 0, panY: 0, zoom: MPR_DEFAULT_ZOOM },
          sagittal: { panX: 0, panY: 0, zoom: MPR_DEFAULT_ZOOM },
        },
        mprCenter: center,
        mprWidth: width,
        volumeTool: "rotate",
        volumeCenter: volumeWindow.center,
        volumeWidth: volumeWindow.width,
        volumePanX: 0,
        volumePanY: 0,
        volumeShift: 0,
        // Sliders are an advanced detail: they start hidden in both modes and
        // each panel's "Sliders" button reveals them.
        mprSlidersHidden: true,
        volumeSlidersHidden: true,
        transferFunctionId: DEFAULT_TRANSFER_FUNCTION_ID,
        shading: Boolean(getTransferFunction(DEFAULT_TRANSFER_FUNCTION_ID).shading),
        quality: DEFAULT_QUALITY_STEPS,
        yaw: 0,
        pitch: 0,
        zoom: VOLUME_DEFAULT_ZOOM,
      };
      const initialSlice = finiteOr(this.options.initialSlice, null);
      if (initialSlice !== null) {
        this.state.crosshair[2] = clamp(Math.round(initialSlice), 0, this.dimensions[2] - 1);
      }
      this.scratch = {};
      this.volumeRenderer = null;
      this.destroyed = false;
      this._build();
      this._bindControls();
      this._bindMpr();
      this.resizeObserver = new ResizeObserver(() => this.render());
      Object.values(this.canvases).forEach((canvas) => this.resizeObserver.observe(canvas));
      this.setMode(this.state.mode, false);
      this.syncControls();
      this.render();
    }

    _build() {
      const root = document.createElement("div");
      root.className = "dsv-volume-root";
      root.innerHTML = `
        <div class="dsv-volume-grid" aria-label="Volumetric reconstructions">
          ${["axial", "coronal", "sagittal", "volume"].map((plane) => {
            const title = plane === "axial" ? "Axial" : plane === "coronal" ? "Coronal" : plane === "sagittal" ? "Sagittal" : "3D Volume";
            return `<section class="dsv-volume-view" data-volume-view="${plane}">
              <h3 class="dsv-volume-title">${title}</h3>
              ${plane !== "volume" ? `<button class="dsv-volume-expand" type="button" data-volume-expand="${plane}" aria-label="Maximize ${title}" aria-pressed="false" title="Maximize ${title}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3H3v4M13 3h4v4M7 17H3v-4M13 17h4v-4"/></svg></button>` : ""}
              <canvas aria-label="${title}"></canvas>
              <div class="dsv-volume-meta"></div>
            </section>`;
          }).join("")}
        </div>
        <div class="dsv-volume-controls">
          <div class="dsv-volume-panel" data-volume-panel="mpr">
            <div class="dsv-volume-tool-group" aria-label="MPR tools">
              ${[["Crosshair", "crosshair", "Crosshair"], ["W/L", "window", "Window/Level (W)"], ["Pan", "pan", "Pan (M)"], ["Zoom", "zoom", "Zoom (Z)"], ["Scroll", "scroll", "Scroll (S)"]].map(([label, tool, title]) => `<button class="dsv-volume-control-button" type="button" data-volume-tool="${tool}" data-volume-tool-mode="mpr" aria-pressed="${tool === "crosshair"}" title="${title}">${label}</button>`).join("")}
            </div>
            <button class="dsv-volume-control-button" type="button" data-volume-action="toggle-mpr-sliders" aria-pressed="false" title="Show or hide the A/C/S/W/L sliders">Sliders</button>
            ${[["A", "axial"], ["C", "coronal"], ["S", "sagittal"]].map(([label, plane]) => `<label class="dsv-volume-range"><span>${label}</span><input type="range" data-volume-control="${plane}"><output class="dsv-volume-value" data-volume-output="${plane}">—</output></label>`).join("")}
            <label class="dsv-volume-range"><span>W</span><input type="range" data-volume-control="width"><output class="dsv-volume-value" data-volume-output="width">—</output></label>
            <label class="dsv-volume-range"><span>L</span><input type="range" data-volume-control="center"><output class="dsv-volume-value" data-volume-output="center">—</output></label>
          </div>
          <div class="dsv-volume-panel" data-volume-panel="volume" hidden>
            <div class="dsv-volume-tool-group" aria-label="3D tools">
              ${[["W/L", "window", "Window/Level (W)"], ["Pan", "pan", "Pan (M)"], ["Zoom", "zoom", "Zoom (Z)"], ["Rotate", "rotate", "Rotate (R)"]].map(([label, tool, title]) => `<button class="dsv-volume-control-button" type="button" data-volume-tool="${tool}" data-volume-tool-mode="volume" aria-pressed="${tool === "rotate"}" title="${title}">${label}</button>`).join("")}
            </div>
            <label class="dsv-volume-select-label"><span>TF</span><select class="dsv-volume-select" data-volume-control="transfer-function" aria-label="3D transfer function">${TRANSFER_FUNCTIONS.map((preset) => `<option value="${preset.id}">${preset.label}</option>`).join("")}</select></label>
            <button class="dsv-volume-control-button" type="button" data-volume-action="shading" aria-pressed="true" title="Blinn-Phong shading">Shade</button>
            <button class="dsv-volume-control-button" type="button" data-volume-action="toggle-sliders" aria-pressed="false" title="Show or hide the W/L/Sh sliders">Sliders</button>
            <label class="dsv-volume-range"><span>W</span><input type="range" data-volume-control="volume-width"><output class="dsv-volume-value" data-volume-output="volume-width">—</output></label>
            <label class="dsv-volume-range"><span>L</span><input type="range" data-volume-control="volume-center"><output class="dsv-volume-value" data-volume-output="volume-center">—</output></label>
            <label class="dsv-volume-range" title="Shifts the preset's opacity stops"><span>Sh</span><input type="range" data-volume-control="volume-shift"><output class="dsv-volume-value" data-volume-output="volume-shift">—</output></label>
            <div class="dsv-volume-quality" aria-label="Raycasting quality">
              ${[["Low", QUALITY_STEPS[0]], ["Medium", QUALITY_STEPS[1]], ["High", QUALITY_STEPS[2]]].map(([label, steps]) => `<button class="dsv-volume-control-button" type="button" data-volume-quality="${steps}" aria-pressed="${steps === DEFAULT_QUALITY_STEPS}">${label}</button>`).join("")}
            </div>
          </div>
        </div>`;
      this.container.replaceChildren(root);
      this.root = root;
      this.canvases = {};
      root.querySelectorAll("[data-volume-view]").forEach((view) => {
        this.canvases[view.dataset.volumeView] = view.querySelector("canvas");
      });
    }

    _buildCameraFrame() {
      const anteriorSign = this.coordinateSystem === "LPS" ? -1 : 1;
      const patientY = this.planes.axial.v;
      const patientZ = this.planes.axial.fixed;
      const offsetDirection = [0, 0, 0];
      const up = [0, 0, 0];
      offsetDirection[patientY.axis] = anteriorSign * patientY.sign;
      up[patientZ.axis] = patientZ.sign;
      return { offsetDirection, up };
    }

    _activeWindow(mode) {
      return mode === "volume"
        ? { center: this.state.volumeCenter, width: this.state.volumeWidth }
        : { center: this.state.mprCenter, width: this.state.mprWidth };
    }

    _applyWindow(mode, center, width) {
      if (mode === "volume") {
        this.state.volumeCenter = Number(center);
        this.state.volumeWidth = Math.max(1, Number(width));
      } else {
        this.state.mprCenter = Number(center);
        this.state.mprWidth = Math.max(1, Number(width));
      }
    }

    _setWindow(mode, center, width, emit) {
      this._applyWindow(mode, center, width);
      this.syncControls();
      this.render();
      if (emit !== false) this._notify();
    }

    setWindow(center, width) {
      this._setWindow(this.state.mode, center, width, true);
    }

    _bindControls() {
      const [minimum, maximum] = this.range;
      const widthMaximum = Math.max(1, Math.ceil((maximum - minimum) * 1.5));
      // The shift step follows OHIF VolumeShift: 10^floor(log10(span/500)).
      const shiftSpan = Math.max(1, maximum - minimum);
      const shiftStep = Math.max(Math.pow(10, Math.floor(Math.log10(shiftSpan / 500))), 0.01);
      const definitions = {
        width: [1, widthMaximum, 1],
        center: [minimum, maximum, 1],
        "volume-width": [1, widthMaximum, 1],
        "volume-center": [minimum, maximum, 1],
        "volume-shift": [-shiftSpan, shiftSpan, shiftStep],
        axial: [0, this.dimensions[this.planes.axial.fixed.axis] - 1, 1],
        coronal: [0, this.dimensions[this.planes.coronal.fixed.axis] - 1, 1],
        sagittal: [0, this.dimensions[this.planes.sagittal.fixed.axis] - 1, 1],
      };
      Object.entries(definitions).forEach(([key, [min, max, step]]) => {
        const input = this.root.querySelector(`[data-volume-control="${key}"]`);
        if (!input) return;
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.addEventListener("input", () => {
          const value = Number(input.value);
          if (key === "width") this._applyWindow("mpr", this.state.mprCenter, value);
          else if (key === "center") this._applyWindow("mpr", value, this.state.mprWidth);
          else if (key === "volume-width") this._applyWindow("volume", this.state.volumeCenter, value);
          else if (key === "volume-center") this._applyWindow("volume", value, this.state.volumeWidth);
          else if (key === "volume-shift") this.state.volumeShift = value;
          else this.state.crosshair[this.planes[key].fixed.axis] = value;
          this.syncControls();
          this.renderInteractive();
          this._notify();
        });
      });
      this.root.querySelectorAll("[data-volume-expand]").forEach((button) => {
        button.addEventListener("click", () => {
          const plane = button.dataset.volumeExpand;
          this.setMprMaximized(this.state.maximizedMpr === plane ? null : plane);
        });
      });
      this.root.querySelectorAll("[data-volume-quality]").forEach((button) => {
        button.addEventListener("click", () => {
          this.state.quality = Number(button.dataset.volumeQuality);
          this.syncControls();
          this.render();
          this._notify();
        });
      });
      this.root.querySelectorAll("[data-volume-tool]").forEach((button) => {
        button.addEventListener("click", () => {
          if (button.dataset.volumeToolMode === "mpr") this.state.mprTool = button.dataset.volumeTool;
          else this.state.volumeTool = button.dataset.volumeTool;
          this.syncControls();
          this._notify();
        });
      });
      const transferSelect = this.root.querySelector('[data-volume-control="transfer-function"]');
      transferSelect.addEventListener("change", () => {
        selectTransferFunction(this.state, transferSelect.value, this.transferDomain);
        this.syncControls();
        this.render();
        this._notify();
      });
      this.root.querySelector("[data-volume-action='shading']").addEventListener("click", () => {
        this.state.shading = !this.state.shading;
        this.syncControls();
        this.render();
        this._notify();
      });
      this.root.querySelector("[data-volume-action='toggle-sliders']").addEventListener("click", () => {
        this.state.volumeSlidersHidden = !this.state.volumeSlidersHidden;
        this.syncControls();
      });
      this.root.querySelector("[data-volume-action='toggle-mpr-sliders']").addEventListener("click", () => {
        this.state.mprSlidersHidden = !this.state.mprSlidersHidden;
        this.syncControls();
      });
    }

    _bindMpr() {
      ["axial", "coronal", "sagittal"].forEach((plane) => {
        const canvas = this.canvases[plane];
        let drag = null;
        const updateCrosshair = (event) => {
          const viewport = canvas.__viewport;
          if (!viewport) return;
          const rect = canvas.getBoundingClientRect();
          const px = clamp((event.clientX - rect.left - viewport.dx) / viewport.dw, 0, 1);
          const py = clamp((event.clientY - rect.top - viewport.dy) / viewport.dh, 0, 1);
          const definition = this.planes[plane];
          this.state.crosshair[definition.u.axis] = this._screenToVoxel(definition.u, px);
          this.state.crosshair[definition.v.axis] = this._screenToVoxel(definition.v, py);
          this.syncControls();
          this.render();
          this._notify();
        };
        canvas.addEventListener("contextmenu", (event) => event.preventDefault());
        canvas.addEventListener("pointerdown", (event) => {
          if (this.state.mode !== "mpr") return;
          if (event.button !== 0 && event.button !== 2) return;
          // Right mouse button or Alt: zoom, as in the 2D stack.
          const tool = event.button === 2 || event.altKey ? "zoom" : this.state.mprTool;
          const transform = this.state.mprTransforms[plane];
          const fixedAxis = this.planes[plane].fixed.axis;
          drag = {
            mode: "mpr",
            tool,
            plane,
            startX: event.clientX,
            startY: event.clientY,
            center: this.state.mprCenter,
            width: this.state.mprWidth,
            multiplier: this.windowLevelMultiplier,
            panX: transform.panX,
            panY: transform.panY,
            zoom: transform.zoom,
            axis: fixedAxis,
            axisSize: this.dimensions[fixedAxis],
            slice: this.state.crosshair[fixedAxis],
          };
          canvas.setPointerCapture(event.pointerId);
          if (drag.tool === "crosshair") updateCrosshair(event);
          if (drag.tool === "pan") canvas.style.cursor = "grabbing";
          event.preventDefault();
        });
        canvas.addEventListener("pointermove", (event) => {
          if (!drag) return;
          if (drag.tool === "crosshair") updateCrosshair(event);
          else {
            applyVolumetricToolDrag(this.state, drag, event.clientX - drag.startX, event.clientY - drag.startY);
            this.syncControls();
            this.render();
            this._notify();
          }
        });
        const finish = () => {
          drag = null;
          this._syncCursors();
        };
        canvas.addEventListener("pointerup", finish);
        canvas.addEventListener("pointercancel", finish);
        canvas.addEventListener("lostpointercapture", finish);
        canvas.addEventListener("wheel", (event) => {
          if (this.state.mode !== "mpr") return;
          event.preventDefault();
          event.stopPropagation();
          const axis = this.planes[plane].fixed.axis;
          this.state.crosshair[axis] = clamp(
            this.state.crosshair[axis] + (event.deltaY > 0 ? 1 : -1),
            0,
            this.dimensions[axis] - 1
          );
          this.syncControls();
          this.render();
          this._notify();
        }, { passive: false });
      });
    }

    _screenToVoxel(spec, fraction) {
      const worldFraction = spec.screenSign > 0 ? fraction : 1 - fraction;
      const voxelFraction = spec.sign > 0 ? worldFraction : 1 - worldFraction;
      return Math.round(clamp(voxelFraction, 0, 1) * (this.dimensions[spec.axis] - 1));
    }

    _voxelToScreen(spec, index) {
      const voxelFraction = index / Math.max(1, this.dimensions[spec.axis] - 1);
      const worldFraction = spec.sign > 0 ? voxelFraction : 1 - voxelFraction;
      return spec.screenSign > 0 ? worldFraction : 1 - worldFraction;
    }

    _voiLinear(value) {
      const width = Math.max(1, this.state.mprWidth);
      let normalized = width === 1
        ? (value > this.state.mprCenter - 0.5 ? 1 : 0)
        : clamp(((value - (this.state.mprCenter - 0.5)) / (width - 1)) + 0.5, 0, 1);
      if (this.volume.invert) normalized = 1 - normalized;
      return normalized;
    }

    setMode(mode, emit) {
      if (mode !== "mpr" && mode !== "volume") return;
      this.state.mode = mode;
      this.root.dataset.mode = mode;
      this.root.querySelectorAll("[data-volume-panel]").forEach((panel) => {
        panel.hidden = panel.dataset.volumePanel !== mode;
      });
      if (mode === "volume") this._ensureVolumeRenderer();
      this.syncControls();
      this.render();
      global.requestAnimationFrame(() => this.render());
      if (emit !== false) this._notify();
    }

    setMprMaximized(plane) {
      if (plane !== null && !["axial", "coronal", "sagittal"].includes(plane)) return;
      this.state.maximizedMpr = plane;
      if (plane) this.root.dataset.maximized = plane;
      else delete this.root.dataset.maximized;
      this.root.querySelectorAll("[data-volume-expand]").forEach((button) => {
        const active = button.dataset.volumeExpand === plane;
        button.setAttribute("aria-pressed", String(active));
        button.title = `${active ? "Restore" : "Maximize"} ${button.dataset.volumeExpand}`;
      });
      this.render();
      global.requestAnimationFrame(() => this.render());
    }

    setNativeSlice(value) {
      this.state.crosshair[2] = clamp(Math.round(Number(value)), 0, this.dimensions[2] - 1);
      this.syncControls();
      this.render();
    }

    getNativeSlice() {
      return this.state.crosshair[2];
    }

    stepAxial(delta) {
      const axis = this.planes.axial.fixed.axis;
      this.state.crosshair[axis] = clamp(this.state.crosshair[axis] + delta, 0, this.dimensions[axis] - 1);
      this.syncControls();
      this.render();
      this._notify();
    }

    resetCurrent() {
      if (this.state.mode === "volume") {
        this.state.volumeTool = "rotate";
        this.state.volumePanX = 0;
        this.state.volumePanY = 0;
        this.state.volumeShift = 0;
        // selectTransferFunction returns W/L to the preset's native domain.
        selectTransferFunction(this.state, DEFAULT_TRANSFER_FUNCTION_ID, this.transferDomain);
        this.state.quality = DEFAULT_QUALITY_STEPS;
        this.state.yaw = 0;
        this.state.pitch = 0;
        this.state.zoom = VOLUME_DEFAULT_ZOOM;
      } else {
        this.state.crosshair = this.dimensions.map((value) => Math.floor(value / 2));
        this.state.mprTool = "crosshair";
        this.state.mprTransforms = {
          axial: { panX: 0, panY: 0, zoom: MPR_DEFAULT_ZOOM },
          coronal: { panX: 0, panY: 0, zoom: MPR_DEFAULT_ZOOM },
          sagittal: { panX: 0, panY: 0, zoom: MPR_DEFAULT_ZOOM },
        };
        this.state.mprCenter = this.defaultWindow.center;
        this.state.mprWidth = this.defaultWindow.width;
        this.setMprMaximized(null);
      }
      this.syncControls();
      this.render();
      this._notify();
    }

    syncControls() {
      const values = {
        width: this.state.mprWidth,
        center: this.state.mprCenter,
        "volume-width": this.state.volumeWidth,
        "volume-center": this.state.volumeCenter,
        "volume-shift": this.state.volumeShift,
        axial: this.state.crosshair[this.planes.axial.fixed.axis],
        coronal: this.state.crosshair[this.planes.coronal.fixed.axis],
        sagittal: this.state.crosshair[this.planes.sagittal.fixed.axis],
      };
      Object.entries(values).forEach(([key, value]) => {
        const input = this.root.querySelector(`[data-volume-control="${key}"]`);
        const output = this.root.querySelector(`[data-volume-output="${key}"]`);
        if (input) input.value = String(Math.round(value));
        if (output) output.value = ["width", "center", "volume-width", "volume-center", "volume-shift"].includes(key)
          ? String(Math.round(value))
          : String(Math.round(value) + 1);
      });
      this.root.querySelectorAll("[data-volume-quality]").forEach((button) => {
        button.setAttribute("aria-pressed", String(Number(button.dataset.volumeQuality) === this.state.quality));
      });
      this.root.querySelectorAll("[data-volume-tool]").forEach((button) => {
        const activeTool = button.dataset.volumeToolMode === "mpr" ? this.state.mprTool : this.state.volumeTool;
        button.setAttribute("aria-pressed", String(button.dataset.volumeTool === activeTool));
      });
      const transferSelect = this.root.querySelector('[data-volume-control="transfer-function"]');
      if (transferSelect) transferSelect.value = this.state.transferFunctionId;
      const shadingButton = this.root.querySelector("[data-volume-action='shading']");
      if (shadingButton) shadingButton.setAttribute("aria-pressed", String(Boolean(this.state.shading)));
      const slidersButton = this.root.querySelector("[data-volume-action='toggle-sliders']");
      if (slidersButton) slidersButton.setAttribute("aria-pressed", String(!this.state.volumeSlidersHidden));
      const volumePanel = this.root.querySelector('[data-volume-panel="volume"]');
      if (volumePanel) volumePanel.dataset.hideSliders = String(Boolean(this.state.volumeSlidersHidden));
      const mprSlidersButton = this.root.querySelector("[data-volume-action='toggle-mpr-sliders']");
      if (mprSlidersButton) mprSlidersButton.setAttribute("aria-pressed", String(!this.state.mprSlidersHidden));
      const mprPanel = this.root.querySelector('[data-volume-panel="mpr"]');
      if (mprPanel) mprPanel.dataset.hideSliders = String(Boolean(this.state.mprSlidersHidden));
      this._syncCursors();
    }

    // Keyboard tool selection (forwarded by the 2D viewer) applies to the active
    // mode and ignores tools unavailable in that mode.
    setTool(tool) {
      if (this.state.mode === "mpr" && MPR_TOOLS.includes(tool)) this.state.mprTool = tool;
      else if (this.state.mode === "volume" && VOLUME_TOOLS.includes(tool)) this.state.volumeTool = tool;
      else return;
      this.syncControls();
      this._notify();
    }

    _syncCursors() {
      const cursorFor = (tool) => tool === "pan" || tool === "rotate" ? "grab" : tool === "zoom" ? "ns-resize" : tool === "scroll" ? "row-resize" : "crosshair";
      ["axial", "coronal", "sagittal"].forEach((plane) => {
        this.canvases[plane].style.cursor = cursorFor(this.state.mprTool);
      });
      this.canvases.volume.style.cursor = cursorFor(this.state.volumeTool);
    }

    render() {
      if (this.destroyed) return;
      if (this.state.mode === "mpr") {
        this._renderMpr("axial");
        this._renderMpr("coronal");
        this._renderMpr("sagittal");
      } else if (this.volumeRenderer) {
        this.volumeRenderer.render(this.state, false);
      }
    }

    // Drags and sliders pass through here: 3D renders a draft frame and returns
    // to full quality when interaction stops.
    renderInteractive() {
      if (this.destroyed) return;
      if (this.state.mode === "volume" && this.volumeRenderer) {
        this.volumeRenderer.renderInteractive(this.state);
        return;
      }
      this.render();
    }

    _renderMpr(plane) {
      const canvas = this.canvases[plane];
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const dpr = Math.min(global.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const context = canvas.getContext("2d", { alpha: false });
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.fillStyle = "#000";
      context.fillRect(0, 0, rect.width, rect.height);

      const definition = this.planes[plane];
      const sourceWidth = this.dimensions[definition.u.axis];
      const sourceHeight = this.dimensions[definition.v.axis];
      const physicalWidth = sourceWidth * this.spacing[definition.u.axis];
      const physicalHeight = sourceHeight * this.spacing[definition.v.axis];
      const transform = this.state.mprTransforms[plane];
      const fit = Math.min(rect.width / physicalWidth, rect.height / physicalHeight) * transform.zoom;
      const drawWidth = physicalWidth * fit;
      const drawHeight = physicalHeight * fit;
      const dx = (rect.width - drawWidth) / 2 + transform.panX;
      const dy = (rect.height - drawHeight) / 2 + transform.panY;

      let scratch = this.scratch[plane];
      if (!scratch || scratch.canvas.width !== sourceWidth || scratch.canvas.height !== sourceHeight) {
        const scratchCanvas = document.createElement("canvas");
        scratchCanvas.width = sourceWidth;
        scratchCanvas.height = sourceHeight;
        const scratchContext = scratchCanvas.getContext("2d", { alpha: false });
        scratch = {
          canvas: scratchCanvas,
          context: scratchContext,
          image: scratchContext.createImageData(sourceWidth, sourceHeight),
          uIndices: Int32Array.from(
            { length: sourceWidth },
            (_, column) => this._screenToVoxel(definition.u, column / Math.max(1, sourceWidth - 1))
          ),
          vIndices: Int32Array.from(
            { length: sourceHeight },
            (_, row) => this._screenToVoxel(definition.v, row / Math.max(1, sourceHeight - 1))
          ),
        };
        this.scratch[plane] = scratch;
      }

      const image = scratch.image;
      const [xSize, ySize] = this.dimensions;
      const coordinate = [0, 0, 0];
      coordinate[definition.fixed.axis] = this.state.crosshair[definition.fixed.axis];
      let target = 0;
      for (let row = 0; row < sourceHeight; row += 1) {
        coordinate[definition.v.axis] = scratch.vIndices[row];
        for (let column = 0; column < sourceWidth; column += 1) {
          coordinate[definition.u.axis] = scratch.uIndices[column];
          const [x, y, z] = coordinate;
          const value = this.voxels[(z * ySize + y) * xSize + x];
          const gray = Math.round(this._voiLinear(value) * 255);
          image.data[target] = gray;
          image.data[target + 1] = gray;
          image.data[target + 2] = gray;
          image.data[target + 3] = 255;
          target += 4;
        }
      }
      scratch.context.putImageData(image, 0, 0);
      context.imageSmoothingEnabled = false;
      context.drawImage(scratch.canvas, dx, dy, drawWidth, drawHeight);

      const crossX = dx + this._voxelToScreen(definition.u, this.state.crosshair[definition.u.axis]) * drawWidth;
      const crossY = dy + this._voxelToScreen(definition.v, this.state.crosshair[definition.v.axis]) * drawHeight;
      context.strokeStyle = "#22c7e5";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(dx, crossY + 0.5);
      context.lineTo(dx + drawWidth, crossY + 0.5);
      context.moveTo(crossX + 0.5, dy);
      context.lineTo(crossX + 0.5, dy + drawHeight);
      context.stroke();
      context.strokeRect(crossX - 4.5, crossY - 4.5, 9, 9);
      context.setTransform(1, 0, 0, 1, 0, 0);

      canvas.__viewport = { dx, dy, dw: drawWidth, dh: drawHeight };
      const meta = canvas.parentElement.querySelector(".dsv-volume-meta");
      const index = this.state.crosshair[definition.fixed.axis];
      const total = this.dimensions[definition.fixed.axis];
      const unit = this.volume.windowing && this.volume.windowing.unit ? ` ${this.volume.windowing.unit}` : "";
      meta.textContent = `${index + 1} / ${total}\nW ${Math.round(this.state.mprWidth)} · L ${Math.round(this.state.mprCenter)}${unit}\nZoom ${Math.round(transform.zoom * 100)}%`;
    }

    _ensureVolumeRenderer() {
      if (this.volumeRenderer) return;
      this.volumeRenderer = new WebGLVolumeRenderer(
        this.canvases.volume,
        this.volume,
        this.state,
        this.cameraFrame,
        () => {
          this.syncControls();
          this._notify();
        },
        this.windowLevelMultiplier,
        this.transferDomain
      );
    }

    getState() {
      const active = this._activeWindow(this.state.mode);
      return {
        mode: this.state.mode,
        center: active.center,
        width: active.width,
        nativeSlice: this.getNativeSlice(),
        crosshair: this.state.crosshair.slice(),
        mprTool: this.state.mprTool,
        mprTransforms: Object.fromEntries(Object.entries(this.state.mprTransforms).map(([plane, transform]) => [plane, Object.assign({}, transform)])),
        volumeTool: this.state.volumeTool,
        volumePanX: this.state.volumePanX,
        volumePanY: this.state.volumePanY,
        volumeShift: this.state.volumeShift,
        transferFunctionId: this.state.transferFunctionId,
        shading: this.state.shading,
        quality: this.state.quality,
        yaw: this.state.yaw,
        pitch: this.state.pitch,
        zoom: this.state.zoom,
      };
    }

    _notify() {
      if (typeof this.options.onStateChange === "function") this.options.onStateChange(this.getState());
    }

    destroy() {
      this.destroyed = true;
      if (this.resizeObserver) this.resizeObserver.disconnect();
      if (this.volumeRenderer) this.volumeRenderer.destroy();
      this.volumeRenderer = null;
      this.container.replaceChildren();
    }
  }


  volume.mpr = { VolumeViewer };
})(window);
