(function (global) {
  "use strict";

  const params = new URLSearchParams(global.location.search);
  const requestedOrigin = params.get("origin");
  let targetOrigin = "*";
  if (requestedOrigin) {
    const parsedOrigin = new URL(requestedOrigin);
    if (!["http:", "https:"].includes(parsedOrigin.protocol)) {
      throw new TypeError("The iframe origin parameter must use HTTP or HTTPS.");
    }
    targetOrigin = parsedOrigin.origin;
  }

  global.DicomSlide.ready.then(() => {
    const element = document.createElement("dicom-study-viewer");
    for (const [parameter, attribute] of [
      ["study-id", "study-id"], ["study", "src"], ["series", "series"],
      ["mode", "mode"], ["preset", "preset"], ["slice", "slice"], ["tool", "tool"],
    ]) {
      const value = params.get(parameter);
      if (value != null && value !== "") element.setAttribute(attribute, value);
    }
    document.body.appendChild(element);
    global.dicomStudyViewer = element;

    function report(type, detail) {
      global.parent.postMessage({
        source: "dicom-slide-viewer",
        type,
        state: detail || element.getState(),
      }, targetOrigin);
    }

    function runCommand(action) {
      try {
        Promise.resolve(action()).catch((error) => {
          report("error", { message: error && error.message ? error.message : String(error) });
        });
      } catch (error) {
        report("error", { message: error && error.message ? error.message : String(error) });
      }
    }

    for (const [eventName, type] of [
      ["dicom-ready", "ready"],
      ["dicom-series-change", "series"],
      ["dicom-state-change", "state"],
      ["dicom-mode-change", "mode"],
      ["dicom-volume-progress", "volume-progress"],
    ]) {
      element.addEventListener(eventName, (event) => report(type, event.detail));
    }
    element.addEventListener("dicom-expand-request", (event) => report("toggle-expand", event.detail));
    element.addEventListener("dicom-error", (event) => report("error", event.detail));

    element.ready.then(() => {
      global.viewer = element.viewer;
      document.title = element.getState().studyTitle || "DICOM study viewer";
      report("ready");
    }).catch(() => {});

    global.addEventListener("message", (event) => {
      const message = event.data;
      if (event.source !== global.parent) return;
      if (targetOrigin !== "*" && event.origin !== targetOrigin) return;
      if (!message || message.source !== "dicom-slide-host") return;
      if (message.command === "setSeries") runCommand(() => element.setSeries(message.value));
      else if (message.command === "setPreset") runCommand(() => element.setPreset(message.value));
      else if (message.command === "setMode") runCommand(() => element.setMode(message.value));
      else if (message.command === "setSlice") runCommand(() => element.setSlice(message.value));
      else if (message.command === "setTool") runCommand(() => element.setTool(message.value));
      else if (message.command === "setExpanded") runCommand(() => element.setExpanded(message.value));
      else if (message.command === "reset") runCommand(() => element.reset());
      else if (message.command === "setWindow") runCommand(() => element.setWindow(message.center, message.width));
    });
  }).catch((error) => console.error(error));
})(window);
