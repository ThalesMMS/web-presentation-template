(function (global) {
  "use strict";

  const internal = global.__DicomSlideInternal || (global.__DicomSlideInternal = {});
  const volume = internal.volume || (internal.volume = {});

  if (!volume.transfer || !volume.geometry) throw new Error("DICOM Slide volume loader dependencies are missing.");
  const MAX_VOLUME_BYTES = 512 * 1024 * 1024;
  const CHUNK_CONCURRENCY = 2;
  const { buildAffineLPS } = volume.geometry;

  function chunkLayoutError(manifest) {
    const chunks = manifest.chunks;
    const slices = manifest.dimensions.slices;
    const coverage = new Uint8Array(slices);
    for (let index = 0; index < chunks.length; index += 1) {
      const spec = chunks[index] || {};
      if (!Number.isInteger(spec.index) || spec.index !== index) {
        return `Chunk ${index} has an invalid declared index`;
      }
      if (!Number.isInteger(spec.firstSlice) || spec.firstSlice < 0
          || !Number.isInteger(spec.sliceCount) || spec.sliceCount <= 0) {
        return `Chunk ${index} has invalid slice bounds`;
      }
      const end = spec.firstSlice + spec.sliceCount;
      if (end > slices) return `Chunk ${index} exceeds the volume slice bounds`;
      for (let slice = spec.firstSlice; slice < end; slice += 1) {
        if (coverage[slice]) return `Chunk ${index} overlaps slice ${slice}`;
        coverage[slice] = 1;
      }
    }
    for (let slice = 0; slice < slices; slice += 1) {
      if (!coverage[slice]) return `Chunk coverage has a gap at slice ${slice}`;
    }
    return "";
  }

  function canLoadManifest(manifest) {
    if (!manifest) return { supported: false, reason: "Manifest unavailable" };
    if (manifest.pixelType !== "int16-le") {
      return { supported: false, reason: "MPR/3D requires an Int16 monochrome series" };
    }
    if (manifest.sortMode !== "spatial") {
      return { supported: false, reason: "MPR/3D requires spatial ordering" };
    }
    const dimensions = manifest.dimensions || {};
    if (![dimensions.columns, dimensions.rows, dimensions.slices].every((value) => Number.isInteger(value) && value > 1)) {
      return { supported: false, reason: "Invalid volumetric geometry" };
    }
    if (!Array.isArray(manifest.orientationLPS) || manifest.orientationLPS.length < 6) {
      return { supported: false, reason: "Missing DICOM orientation" };
    }
    if (!Array.isArray(manifest.chunks) || !manifest.chunks.length) {
      return { supported: false, reason: "Series has no pixel chunks" };
    }
    const bytes = dimensions.columns * dimensions.rows * dimensions.slices * Int16Array.BYTES_PER_ELEMENT;
    if (!Number.isSafeInteger(bytes) || bytes > MAX_VOLUME_BYTES) {
      return { supported: false, reason: `Volume exceeds the ${Math.round(MAX_VOLUME_BYTES / 1024 / 1024)} MiB limit` };
    }
    const layoutError = chunkLayoutError(manifest);
    if (layoutError) return { supported: false, reason: layoutError };
    return { supported: true, bytes };
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) {
      throw signal.reason || new DOMException("Loading cancelled", "AbortError");
    }
  }

  async function runPool(items, concurrency, worker) {
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        await worker(items[index], index);
      }
    });
    await Promise.all(workers);
  }

  async function loadFromManifest(manifest, options) {
    const settings = options || {};
    const capability = canLoadManifest(manifest);
    if (!capability.supported) throw new Error(capability.reason);
    if (!global.DicomSlideData || typeof global.DicomSlideData.loadChunk !== "function") {
      throw new Error("DicomSlideData.loadChunk is not available");
    }

    const startedAt = performance.now();
    const signal = settings.signal;
    const report = typeof settings.onProgress === "function" ? settings.onProgress : () => {};
    const dimensions = [manifest.dimensions.columns, manifest.dimensions.rows, manifest.dimensions.slices];
    const planePixels = dimensions[0] * dimensions[1];
    const voxels = new Int16Array(dimensions[0] * dimensions[1] * dimensions[2]);
    const totalBytes = manifest.chunks.reduce((sum, chunk) => sum + Number(chunk.compressedBytes || 0), 0);
    let completed = 0;
    let loadedBytes = 0;
    let firstChunkMs = null;

    report({ phase: "Preparing volume", completed, total: manifest.chunks.length, loadedBytes, totalBytes, fraction: 0 });
    await runPool(manifest.chunks, CHUNK_CONCURRENCY, async (spec, index) => {
      throwIfAborted(signal);
      const chunk = await global.DicomSlideData.loadChunk(manifest, index);
      throwIfAborted(signal);
      const expected = planePixels * spec.sliceCount;
      if (chunk.length !== expected) {
        throw new Error(`Chunk ${index} holds ${chunk.length} voxels; expected ${expected}`);
      }
      voxels.set(chunk, spec.firstSlice * planePixels);
      if (firstChunkMs === null) firstChunkMs = performance.now() - startedAt;
      completed += 1;
      loadedBytes += Number(spec.compressedBytes || 0);
      report({
        phase: `Assembling volume · ${completed}/${manifest.chunks.length} chunks`,
        completed,
        total: manifest.chunks.length,
        loadedBytes,
        totalBytes,
        fraction: completed / manifest.chunks.length,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    throwIfAborted(signal);
    const minimum = Number(manifest.valueRange && manifest.valueRange.minimum);
    const maximum = Number(manifest.valueRange && manifest.valueRange.maximum);
    const defaultWindow = manifest.defaultWindow || { center: (minimum + maximum) / 2, width: Math.max(1, maximum - minimum) };
    return {
      title: manifest.title || manifest.caseId,
      modality: manifest.modality || "IMG",
      voxels,
      dimensions,
      spacing: [
        Math.abs(Number(manifest.spacing && manifest.spacing.column)) || 1,
        Math.abs(Number(manifest.spacing && manifest.spacing.row)) || 1,
        Math.abs(Number(manifest.spacing && manifest.spacing.slice)) || 1,
      ],
      affine: buildAffineLPS(manifest),
      coordinateSystem: "LPS",
      valueRange: [Number.isFinite(minimum) ? minimum : -32768, Number.isFinite(maximum) ? maximum : 32767],
      invert: Boolean(manifest.invert),
      windowing: {
        center: Number(defaultWindow.center),
        width: Math.max(1, Number(defaultWindow.width)),
        unit: manifest.units || "",
        presets: Object.entries(manifest.presets || {}).map(([id, preset]) => ({
          id,
          label: preset.label || id,
          center: Number(preset.center),
          width: Math.max(1, Number(preset.width)),
        })),
      },
      metrics: {
        payloadBytes: totalBytes,
        memoryBytes: voxels.byteLength,
        firstChunkMs,
        fullVolumeMs: performance.now() - startedAt,
        chunks: manifest.chunks.length,
      },
    };
  }


  volume.loader = { canLoadManifest, loadFromManifest };
})(window);
