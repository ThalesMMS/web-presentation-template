(function (global) {
  "use strict";

  const EVENT_MAP = Object.freeze({
    serieschange: "dicom-series-change",
    slicechange: "dicom-state-change",
    windowchange: "dicom-state-change",
    viewchange: "dicom-state-change",
    toolchange: "dicom-state-change",
    modechange: "dicom-mode-change",
    volumeprogress: "dicom-volume-progress",
    expandrequest: "dicom-expand-request",
  });
  const FORWARDED_EVENTS = Object.keys(EVENT_MAP);

  class DicomStudyViewerElement extends HTMLElement {
    static get observedAttributes() {
      return ["study-id", "src", "series", "mode", "preset", "slice", "tool", "controls"];
    }

    constructor() {
      super();
      this._generation = 0;
      this._studyViewer = null;
      this._eventHandlers = [];
      this._connected = false;
      this.ready = Promise.resolve(this);
      this.attachShadow({ mode: "open" });

      const stylesheet = document.createElement("link");
      stylesheet.rel = "stylesheet";
      stylesheet.href = new URL("styles/dicom-study-viewer.css", global.DicomSlide.baseUrl).href;
      const host = document.createElement("div");
      host.className = "dicom-slide-component";
      this.shadowRoot.append(stylesheet, host);
      this._host = host;
    }

    connectedCallback() {
      this._connected = true;
      this._reload();
    }

    disconnectedCallback() {
      this._connected = false;
      this.destroy();
    }

    attributeChangedCallback(name, oldValue, newValue) {
      if (!this._connected || oldValue === newValue) return;
      if (name === "study-id" || name === "src" || name === "controls") {
        this._reload();
        return;
      }
      this.ready.then(() => this._applyAttribute(name, newValue)).catch(() => {});
    }

    _reload() {
      const generation = ++this._generation;
      this._teardownViewer();
      this._host.replaceChildren();
      this.ready = this._load(generation);
      this.ready.catch(() => {});
      return this.ready;
    }

    async _load(generation) {
      try {
        await global.DicomSlide.ready;
        if (!this._connected || generation !== this._generation) return this;
        const studyId = (this.getAttribute("study-id") || "").trim();
        const source = (this.getAttribute("src") || "").trim();
        if (!studyId || !source) {
          throw new TypeError('<dicom-study-viewer> requires non-empty "study-id" and "src" attributes.');
        }

        const viewer = new global.DicomSlideStudy.StudyViewer(this._host, {
          studyId,
          manifestUrl: source,
          initialSeries: this.getAttribute("series") || null,
          controls: this.getAttribute("controls") === "external" ? "external" : "internal",
        });
        this._studyViewer = viewer;
        this._bindViewerEvents(viewer);
        await viewer.ready;
        if (!this._connected || generation !== this._generation) {
          viewer.destroy();
          return this;
        }
        await this._applyInitialState();
        this.dispatchEvent(new CustomEvent("dicom-ready", {
          bubbles: true,
          composed: true,
          detail: this.getState(),
        }));
        return this;
      } catch (error) {
        if (generation === this._generation) this._reportError(error);
        throw error;
      }
    }

    _bindViewerEvents(viewer) {
      for (const sourceName of FORWARDED_EVENTS) {
        const handler = (event) => {
          const detail = event.detail || this.getState();
          this.dispatchEvent(new CustomEvent(EVENT_MAP[sourceName], {
            bubbles: true,
            composed: true,
            detail,
          }));
        };
        viewer.root.addEventListener(sourceName, handler);
        this._eventHandlers.push([viewer.root, sourceName, handler]);
      }
    }

    async _applyInitialState() {
      for (const name of ["mode", "preset", "slice", "tool"]) {
        if (this.hasAttribute(name)) await this._applyAttribute(name, this.getAttribute(name));
      }
    }

    _applyAttribute(name, value) {
      if (!this._studyViewer || value == null) return undefined;
      if (name === "series") return this._studyViewer.setSeries(value);
      if (name === "mode") return this._studyViewer.setMode(value);
      if (name === "preset") return this._studyViewer.setPreset(value);
      if (name === "slice") return this._studyViewer.setSlice(Number(value));
      if (name === "tool") return this._studyViewer.setActiveTool(value);
      return undefined;
    }

    _reportError(error) {
      const message = error && error.message ? error.message : String(error);
      const panel = document.createElement("div");
      panel.className = "dicom-slide-component-error";
      panel.textContent = `Failed to initialize DICOM viewer\n${message}`;
      this._host.replaceChildren(panel);
      this.dispatchEvent(new CustomEvent("dicom-error", {
        bubbles: true,
        composed: true,
        detail: { message, error },
      }));
    }

    _teardownViewer() {
      for (const [target, type, handler] of this._eventHandlers.splice(0)) {
        target.removeEventListener(type, handler);
      }
      if (this._studyViewer) this._studyViewer.destroy();
      this._studyViewer = null;
    }

    get viewer() { return this._studyViewer; }
    getState() { return this._studyViewer ? this._studyViewer.getState() : {}; }
    setSeries(value) { return this.ready.then(() => this._studyViewer && this._studyViewer.setSeries(value)); }
    setMode(value) { return this.ready.then(() => this._studyViewer && this._studyViewer.setMode(value)); }
    setSlice(value) { return this.ready.then(() => this._studyViewer && this._studyViewer.setSlice(Number(value))); }
    setPreset(value) { return this.ready.then(() => this._studyViewer && this._studyViewer.setPreset(value)); }
    setWindow(center, width) { return this.ready.then(() => this._studyViewer && this._studyViewer.setWindow(center, width)); }
    setTool(value) { return this.ready.then(() => this._studyViewer && this._studyViewer.setActiveTool(value)); }
    setExpanded(value) { return this.ready.then(() => this._studyViewer && this._studyViewer.setExpanded(Boolean(value))); }
    reset() { return this.ready.then(() => this._studyViewer && this._studyViewer.reset()); }

    destroy() {
      this._generation += 1;
      this._teardownViewer();
      this._host.replaceChildren();
    }
  }

  if (!customElements.get("dicom-study-viewer")) {
    customElements.define("dicom-study-viewer", DicomStudyViewerElement);
  }
  global.DicomSlide.DicomStudyViewerElement = DicomStudyViewerElement;
})(window);
