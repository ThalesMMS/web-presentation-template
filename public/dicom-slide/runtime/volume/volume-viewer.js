(function (global) {
  "use strict";

  const volume = global.__DicomSlideInternal && global.__DicomSlideInternal.volume;
  const requiredFunctions = volume && [
    [volume.loader, "loadFromManifest"],
    [volume.loader, "canLoadManifest"],
    [volume.geometry, "buildAffineLPS"],
    [volume.geometry, "buildPlaneDefinitions"],
    [volume.geometry, "buildOrbitCamera"],
    [volume.mpr, "VolumeViewer"],
    [volume.webgl, "chooseTextureStride"],
    [volume.webgl, "downsampleNearest"],
    [volume.webgl, "encodeHalfVolume"],
    [volume.webgl, "measureValueRange"],
    [volume.transfer, "ensureStyles"],
    [volume.transfer, "computeWindowLevelMultiplier"],
    [volume.transfer, "applyVolumetricToolDrag"],
    [volume.transfer, "getTransferFunction"],
    [volume.transfer, "sampleTransferStops"],
    [volume.transfer, "packTransferFunction"],
    [volume.transfer, "selectTransferFunction"],
    [volume.transfer, "transferFunctionDomain"],
    [volume.transfer, "transferFunctionWindow"],
    [volume.transfer, "srgbToLinear"],
    [volume.transfer, "transferDomainMapping"],
  ];
  if (!volume || requiredFunctions.some(([module, name]) => !module || typeof module[name] !== "function")) {
    throw new Error("DICOM Slide volume modules were loaded out of order.");
  }
  const transfer = volume.transfer;
  const geometry = volume.geometry;
  const loader = volume.loader;
  const webgl = volume.webgl;
  global.DicomSlideVolume = {
    VIEW_MODES: transfer.VIEW_MODES,
    MPR_TOOLS: transfer.MPR_TOOLS,
    VOLUME_TOOLS: transfer.VOLUME_TOOLS,
    TRANSFER_FUNCTIONS: transfer.TRANSFER_FUNCTIONS,
    TRANSFER_HU_DOMAIN: transfer.TRANSFER_HU_DOMAIN,
    DEFAULT_TRANSFER_FUNCTION_ID: transfer.DEFAULT_TRANSFER_FUNCTION_ID,
    QUALITY_STEPS: transfer.QUALITY_STEPS,
    DEFAULT_QUALITY_STEPS: transfer.DEFAULT_QUALITY_STEPS,
    PREVIEW_RAY_STEPS: transfer.PREVIEW_RAY_STEPS,
    VolumeViewer: volume.mpr.VolumeViewer,
    loadFromManifest: loader.loadFromManifest,
    canLoadManifest: loader.canLoadManifest,
    buildAffineLPS: geometry.buildAffineLPS,
    buildPlaneDefinitions: geometry.buildPlaneDefinitions,
    buildOrbitCamera: geometry.buildOrbitCamera,
    chooseTextureStride: webgl.chooseTextureStride,
    downsampleNearest: webgl.downsampleNearest,
    encodeHalfVolume: webgl.encodeHalfVolume,
    measureValueRange: webgl.measureValueRange,
    computeWindowLevelMultiplier: transfer.computeWindowLevelMultiplier,
    applyVolumetricToolDrag: transfer.applyVolumetricToolDrag,
    getTransferFunction: transfer.getTransferFunction,
    sampleTransferStops: transfer.sampleTransferStops,
    packTransferFunction: transfer.packTransferFunction,
    selectTransferFunction: transfer.selectTransferFunction,
    transferFunctionDomain: transfer.transferFunctionDomain,
    transferFunctionWindow: transfer.transferFunctionWindow,
    srgbToLinear: transfer.srgbToLinear,
    transferDomainMapping: transfer.transferDomainMapping,
    styles: transfer.STYLE_TEXT,
    ensureStyles: transfer.ensureStyles,
    version: "2.0.0",
  };
})(window);
