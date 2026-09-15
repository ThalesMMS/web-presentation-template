(function (global) {
  "use strict";

  const currentScript = document.currentScript;
  if (!currentScript || !currentScript.src) {
    throw new Error("DICOM Slide must be loaded from a script with a resolvable src attribute.");
  }

  const state = global.__DICOM_SLIDE_RUNTIME__ || (global.__DICOM_SLIDE_RUNTIME__ = {});
  const baseUrl = state.baseUrl || new URL("./", currentScript.src).href;
  state.baseUrl = baseUrl;

  const scripts = [
    "core/data-registry.js",
    "volume/transfer-functions.js",
    "volume/geometry.js",
    "volume/volume-loader.js",
    "volume/webgl-renderer.js",
    "volume/mpr-viewer.js",
    "volume/volume-viewer.js",
    "core/viewer.js",
    "study/study-viewer.js",
    "components/dicom-study-viewer.js",
  ];

  function loadScript(relativePath) {
    const url = new URL(relativePath, baseUrl).href;
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.async = false;
      script.dataset.dicomSlideRuntimeModule = relativePath;
      script.onload = () => resolve(url);
      script.onerror = () => reject(new Error(`Failed to load DICOM Slide runtime module: ${url}`));
      (document.head || document.documentElement).appendChild(script);
    });
  }

  if (!state.ready) {
    state.ready = scripts.reduce(
      (ready, relativePath) => ready.then(() => loadScript(relativePath)),
      Promise.resolve()
    );
  }

  global.DicomSlide = Object.assign(global.DicomSlide || {}, {
    baseUrl,
    ready: state.ready,
    version: "2.0.0",
  });
})(window);
