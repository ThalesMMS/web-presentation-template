(function (global) {
  "use strict";

  const STYLE_TEXT = `
.dss-root{--dss-bg:#05070a;--dss-panel:#17212b;--dss-line:#2a3743;--dss-text:#eef5fa;--dss-muted:#96a8b6;--dss-accent:#38bdf8;width:100%;height:100%;min-height:320px;display:grid;grid-template-rows:auto minmax(0,1fr);overflow:hidden;background:var(--dss-bg);color:var(--dss-text);font:500 13px/1.3 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.dss-toolbar{min-width:0;min-height:42px;display:flex;align-items:center;gap:5px;padding:4px 6px;border-bottom:1px solid var(--dss-line);background:linear-gradient(180deg,#17212b,#0d1319);overflow-x:auto;overflow-y:hidden;scrollbar-width:thin}
.dss-group{min-width:0;display:flex;align-items:center;gap:3px;padding-left:5px;border-left:1px solid var(--dss-line)}
.dss-toolbar>.dss-group:first-child{padding-left:0;border-left:0}
.dss-series-group{flex:1 1 230px;min-width:150px;max-width:420px}
.dss-actions{margin-left:auto}
.dss-button,.dss-select{flex:0 0 auto;height:32px;border:1px solid #354450;border-radius:6px;color:#dce6ed;background:var(--dss-panel);font:700 12px/1 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.dss-button{min-width:32px;padding:0 8px;cursor:pointer;white-space:nowrap}
.dss-button:hover:not(:disabled),.dss-select:hover:not(:disabled){border-color:#4b6472;background:#20303b}
.dss-button[aria-pressed="true"]{border-color:var(--dss-accent);background:#0d3345;color:#e6f8ff}
.dss-button:disabled,.dss-select:disabled{opacity:.58;cursor:default}
.dss-icon-button{width:32px;padding:0;display:inline-grid;place-items:center}
.dss-icon-button svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.dss-select{min-width:0;padding:0 28px 0 8px;cursor:pointer}
.dss-preset-select{width:104px}
.dss-series-select{width:100%}
.dss-visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.dss-viewer{min-height:0;overflow:hidden;background:#000}
.dss-root[data-controls="external"]{grid-template-rows:minmax(0,1fr)}
.dss-root[data-controls="external"] .dss-toolbar{display:none}
.dss-error{display:grid;place-items:center;height:100%;padding:24px;background:#14080a;color:#ffd5dc;text-align:center;white-space:pre-wrap}
@media(max-width:700px){.dss-toolbar{gap:4px}.dss-group{padding-left:4px}.dss-series-group{min-width:130px}.dss-button,.dss-select{height:30px}.dss-icon-button{width:30px}.dss-preset-select{width:96px}}
`;

  const scriptPromises = new Map();

  function ensureStyles(root) {
    const owner = root instanceof Document || root instanceof ShadowRoot ? root : document;
    if (owner.querySelector("style[data-dicom-study-viewer-style]")) return;
    const style = document.createElement("style");
    style.dataset.dicomStudyViewerStyle = "true";
    style.textContent = STYLE_TEXT;
    if (owner instanceof Document) owner.head.appendChild(style);
    else owner.appendChild(style);
  }

  function loadScript(url) {
    const absolute = new URL(url, document.baseURI).href;
    if (scriptPromises.has(absolute)) return scriptPromises.get(absolute);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = absolute;
      script.async = true;
      script.onload = () => resolve(absolute);
      script.onerror = () => reject(new Error(`Could not load study manifest: ${absolute}`));
      document.head.appendChild(script);
    });
    scriptPromises.set(absolute, promise);
    return promise;
  }

  async function loadStudy(studyId, manifestUrl) {
    const registry = global.__DICOM_SLIDE_STUDIES__ || {};
    if (!registry[studyId]) await loadScript(manifestUrl);
    const study = (global.__DICOM_SLIDE_STUDIES__ || {})[studyId];
    if (!study) throw new Error(`Study manifest did not register “${studyId}”.`);
    if (!Array.isArray(study.series) || study.series.length === 0) {
      throw new Error(`Study “${studyId}” has no series.`);
    }
    return study;
  }

  class StudyViewer {
    constructor(container, options) {
      if (!(container instanceof Element)) throw new TypeError("StudyViewer requires a DOM container.");
      this.container = container;
      this.options = Object.assign({ initialSeries: null, controls: "internal" }, options || {});
      if (!this.options.studyId || !this.options.manifestUrl) {
        throw new TypeError("StudyViewer requires studyId and manifestUrl options.");
      }
      this.study = null;
      this.viewer = null;
      this.seriesIndex = -1;
      this.expanded = false;
      this.activePreset = "default";
      this.loadToken = 0;
      this.destroyed = false;
      this._build();
      this._bind();
      this.ready = this._initialize();
    }

    _build() {
      ensureStyles(this.container.getRootNode ? this.container.getRootNode() : document);
      const root = document.createElement("div");
      root.className = "dss-root";
      root.dataset.controls = this.options.controls === "external" ? "external" : "internal";
      root.innerHTML = `
        <div class="dss-toolbar" aria-label="Viewer controls">
          <div class="dss-group dss-tool-group" aria-label="2D interaction tool">
            <button class="dss-button dss-icon-button" type="button" data-tool="window"
                    aria-label="Window and level" aria-pressed="true" title="Window/Level (W)" disabled>
              <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><path d="M12 5a7 7 0 0 1 0 14zM12 2v2m0 16v2M2 12h2m16 0h2"/></svg>
            </button>
            <button class="dss-button dss-icon-button" type="button" data-tool="pan"
                    aria-label="Pan" aria-pressed="false" title="Pan (M)" disabled>
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8.5 11V6.5a1.5 1.5 0 0 1 3 0V10m0-4.5a1.5 1.5 0 0 1 3 0V10m0-3a1.5 1.5 0 0 1 3 0v4m0-2a1.5 1.5 0 0 1 3 0v5c0 4.2-2.8 7-7 7h-1.2a6 6 0 0 1-4.8-2.4L4.2 14a1.7 1.7 0 0 1 2.5-2.3l1.8 1.8z"/></svg>
            </button>
            <button class="dss-button dss-icon-button" type="button" data-tool="zoom"
                    aria-label="Zoom" aria-pressed="false" title="Zoom (Z)" disabled>
              <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5M10.5 7.5v6m-3-3h6"/></svg>
            </button>
            <button class="dss-button dss-icon-button" type="button" data-tool="scroll"
                    aria-label="Scroll images" aria-pressed="false" title="Scroll images (S)" disabled>
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 6h10M7 12h10M7 18h10M4 8V4m0 0L2 6m2-2 2 2m14 10v4m0 0-2-2m2 2 2-2"/></svg>
            </button>
          </div>
          <div class="dss-group">
            <label class="dss-visually-hidden" for="dss-window-preset">Window preset</label>
            <select class="dss-select dss-preset-select" id="dss-window-preset"
                    aria-label="Window preset" title="Window preset" disabled>
              <option value="default">Default</option>
              <option value="abdomen">Abdomen</option>
              <option value="lung">Lung</option>
              <option value="bone">Bone</option>
              <option value="brain">Brain</option>
            </select>
          </div>
          <div class="dss-group dss-series-group">
            <label class="dss-visually-hidden" for="dss-series-select">Series</label>
            <select class="dss-select dss-series-select" id="dss-series-select"
                    aria-label="Study series" title="Series" disabled></select>
          </div>
          <div class="dss-group dss-mode-group" aria-label="View mode">
            <button class="dss-button" type="button" data-view-mode="stack"
                    aria-pressed="true" title="2D view" disabled>2D</button>
            <button class="dss-button" type="button" data-view-mode="mpr"
                    aria-pressed="false" title="MPR unavailable" disabled>MPR</button>
            <button class="dss-button" type="button" data-view-mode="volume"
                    aria-pressed="false" title="3D unavailable" disabled>3D</button>
          </div>
          <div class="dss-group dss-actions">
            <button class="dss-button" type="button" data-action="reset" title="Reset view" disabled>Reset</button>
            <button class="dss-button dss-icon-button" type="button" data-action="expand"
                    aria-label="Expand viewer to fill the slide" aria-pressed="false"
                    title="Expand viewer to fill the slide" disabled>
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5m11 5h5v-5"/></svg>
            </button>
          </div>
        </div>
        <div class="dss-viewer"></div>`;
      this.container.replaceChildren(root);
      this.root = root;
      this.select = root.querySelector(".dss-series-select");
      this.presetSelect = root.querySelector(".dss-preset-select");
      this.viewerHost = root.querySelector(".dss-viewer");
    }

    _bind() {
      this.select.addEventListener("change", () => this.setSeries(this.select.value));
      this.presetSelect.addEventListener("change", () => this.setPreset(this.presetSelect.value));
      this.root.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (!button || button.disabled || !this.viewer) return;
        if (button.dataset.tool) this.setActiveTool(button.dataset.tool);
        else if (button.dataset.viewMode) {
          this.setMode(button.dataset.viewMode).catch((error) => this._showError(error));
        } else if (button.dataset.action === "reset") this.reset();
        else if (button.dataset.action === "expand") this.viewer.requestExpandedToggle();
      });
      for (const eventName of ["viewerready", "toolchange", "modechange", "windowchange", "viewchange"]) {
        this.root.addEventListener(eventName, (event) => this._syncToolbar(event.detail || this.getState()));
      }
    }

    async _initialize() {
      try {
        this.study = await loadStudy(this.options.studyId, this.options.manifestUrl);
        this.select.replaceChildren();
        this.study.series.forEach((series, index) => {
          const option = document.createElement("option");
          option.value = series.id;
          option.textContent = `${series.number || index + 1} · ${series.title} · ${series.slices} images`;
          option.disabled = series.available === false;
          this.select.appendChild(option);
        });
        const firstAvailableIndex = this.study.series.findIndex((series) => series.available !== false);
        if (firstAvailableIndex < 0) {
          const reason = this.study.series.find((series) => series.unavailableReason)?.unavailableReason
            || "Pixel payload is not included for this study.";
          throw new Error(reason);
        }
        const requested = this.options.initialSeries;
        const requestedIndex = requested == null
          ? -1
          : this.study.series.findIndex((series) => series.id === requested || String(series.number) === String(requested));
        const initialIndex = requestedIndex >= 0 && this.study.series[requestedIndex].available !== false
          ? requestedIndex
          : firstAvailableIndex;
        await this.setSeries(initialIndex);
        this.root.dispatchEvent(new CustomEvent("studyready", { bubbles: true, detail: this.getState() }));
        return this;
      } catch (error) {
        this._showError(error);
        throw error;
      }
    }

    async setSeries(value) {
      if (!this.study || this.destroyed) return;
      let index = typeof value === "number"
        ? Math.round(value)
        : this.study.series.findIndex((series) => series.id === value || String(series.number) === String(value));
      index = Math.max(0, Math.min(this.study.series.length - 1, index));
      const series = this.study.series[index];
      if (!series) return;
      if (series.available === false) {
        throw new Error(series.unavailableReason || `Series “${series.title}” is unavailable.`);
      }
      const token = ++this.loadToken;
      if (this.viewer) this.viewer.destroy();
      this.viewer = null;
      this.seriesIndex = index;
      this.select.value = series.id;
      this._updateSeriesControls(true);

      try {
        const viewer = new global.DicomSlideViewer.Viewer(this.viewerHost, {
          caseId: series.caseId,
          manifestUrl: new URL(series.manifest, this.study.baseUrl).href,
          controls: "external",
          studyTitle: this.study.title || this.options.studyId,
          seriesTitle: series.title,
          seriesNumber: series.number || index + 1,
        });
        this.viewer = viewer;
        await viewer.ready;
        if (this.destroyed || token !== this.loadToken) {
          viewer.destroy();
          return;
        }
        viewer.setExpanded(this.expanded);
        this._updateSeriesControls(false);
        this._syncToolbar(this.getState());
        this.root.dispatchEvent(new CustomEvent("serieschange", { bubbles: true, detail: this.getState() }));
        return viewer;
      } catch (error) {
        if (token === this.loadToken) this._showError(error);
        throw error;
      }
    }

    _updateSeriesControls(loading) {
      this.select.disabled = loading || !this.study.series.some((series) => series.available !== false);
    }

    _syncToolbar(state) {
      const current = state || {};
      const active = Boolean(this.viewer && this.viewer.manifest);
      const mode = current.mode || "stack";
      const tool = current.activeTool || "window";
      const preset = current.preset || this.activePreset || "default";
      this.activePreset = preset;
      this.root.dataset.viewMode = mode;
      this.root.querySelectorAll("[data-tool]").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.tool === tool));
        button.disabled = !active || mode !== "stack" || (button.dataset.tool === "window" && Boolean(current.isColor));
      });
      this.presetSelect.disabled = !active || Boolean(current.isColor);
      this.presetSelect.value = preset;
      this.select.disabled = !active || !this.study?.series.some((series) => series.available !== false);
      this.root.querySelectorAll("[data-view-mode]").forEach((button) => {
        const stack = button.dataset.viewMode === "stack";
        button.setAttribute("aria-pressed", String(button.dataset.viewMode === mode));
        button.disabled = !active || (!stack && current.volumeSupported !== true);
        button.title = stack
          ? "Open 2D view (D)"
          : current.volumeSupported === true
            ? `Open ${button.dataset.viewMode === "mpr" ? "multiplanar MPR" : "3D volume rendering"} (D)`
            : `${button.textContent} unavailable: ${current.volumeReason || "series is not compatible"}`;
      });
      const resetButton = this.root.querySelector("[data-action='reset']");
      const expandButton = this.root.querySelector("[data-action='expand']");
      resetButton.disabled = !active;
      expandButton.disabled = !active && !this.expanded;
      expandButton.setAttribute("aria-pressed", String(this.expanded));
      expandButton.setAttribute(
        "aria-label",
        this.expanded ? "Restore viewer size" : "Expand viewer to fill the slide"
      );
      expandButton.title = this.expanded ? "Restore viewer size" : "Expand viewer to fill the slide";
    }

    _showError(error) {
      this.viewerHost.innerHTML = `<div class="dss-error"></div>`;
      this.viewerHost.firstElementChild.textContent = `Failed to load study\n${error && error.message ? error.message : String(error)}`;
      console.error(error);
    }

    getState() {
      const series = this.study && this.study.series[this.seriesIndex];
      return Object.assign(
        {
          studyId: this.options.studyId,
          studyTitle: this.study ? this.study.title : null,
          seriesIndex: this.seriesIndex,
          seriesId: series ? series.id : null,
          seriesNumber: series ? series.number : null,
          seriesTitle: series ? series.title : null,
          totalSeries: this.study ? this.study.series.length : 0,
          seriesOptions: this.study ? this.study.series.map((entry, index) => ({
            id: entry.id,
            number: entry.number || index + 1,
            title: entry.title,
            slices: entry.slices,
            available: entry.available !== false,
          })) : [],
        },
        this.viewer ? this.viewer.getState() : {}
      );
    }

    setSlice(value) { return this.viewer && this.viewer.setSlice(value); }
    setPreset(value) {
      this.activePreset = value;
      const result = this.viewer && this.viewer.setPreset(value);
      this._syncToolbar(this.getState());
      return result;
    }
    setMode(value) { return this.viewer && this.viewer.setMode(value); }
    setWindow(center, width) { return this.viewer && this.viewer.setWindow(center, width); }
    setActiveTool(value) {
      const result = this.viewer && this.viewer.setActiveTool(value);
      this._syncToolbar(this.getState());
      return result;
    }
    setExpanded(value) {
      this.expanded = Boolean(value);
      const result = this.viewer && this.viewer.setExpanded(this.expanded);
      this._syncToolbar(this.getState());
      return result;
    }
    reset() {
      this.activePreset = "default";
      const result = this.viewer && this.viewer.reset();
      this._syncToolbar(this.getState());
      return result;
    }

    destroy() {
      this.destroyed = true;
      this.loadToken += 1;
      if (this.viewer) this.viewer.destroy();
      this.viewer = null;
      this.container.replaceChildren();
    }
  }

  global.DicomSlideStudy = { StudyViewer, loadStudy, version: "2.0.0" };
})(window);
