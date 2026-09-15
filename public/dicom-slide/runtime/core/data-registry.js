(function (global) {
  "use strict";

  const internal = global.__DicomSlideInternal || (global.__DicomSlideInternal = {});
  const manifests = new Map();
  const encodedChunks = new Map();
  const decodedChunks = new Map();
  const decodePromises = new Map();
  const scriptPromises = new Map();
  const lruKeys = [];
  const MAX_DECODED_CHUNKS = 5;

  function chunkKey(caseId, index) {
    return `${caseId}:${index}`;
  }

  function hasDecodedChunk(caseId, index) {
    return decodedChunks.has(chunkKey(caseId, index));
  }

  function registerManifest(caseId, manifest) {
    manifests.set(caseId, manifest);
  }

  function registerChunk(caseId, index, encoded) {
    encodedChunks.set(chunkKey(caseId, index), encoded);
  }

  function loadScript(url) {
    const absolute = new URL(url, document.baseURI).href;
    if (scriptPromises.has(absolute)) return scriptPromises.get(absolute);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = absolute;
      script.async = true;
      script.onload = () => resolve(absolute);
      script.onerror = () => reject(new Error(`Could not load local script: ${absolute}`));
      (document.head || document.documentElement).appendChild(script);
    });
    scriptPromises.set(absolute, promise);
    return promise;
  }

  async function loadManifest(caseId, manifestUrl) {
    if (!manifests.has(caseId)) {
      await loadScript(manifestUrl);
    }
    const manifest = manifests.get(caseId);
    if (!manifest) throw new Error(`Manifest did not register case “${caseId}”.`);
    return manifest;
  }

  function decodeBase64(value) {
    const binary = global.atob(value);
    const output = new Uint8Array(binary.length);
    const block = 32768;
    for (let start = 0; start < binary.length; start += block) {
      const end = Math.min(binary.length, start + block);
      for (let index = start; index < end; index += 1) output[index] = binary.charCodeAt(index);
    }
    return output;
  }

  async function gunzip(bytes) {
    if (!("DecompressionStream" in global)) {
      throw new Error("This browser does not provide DecompressionStream('gzip'). Use a current Safari, Chrome, Edge, or Firefox release.");
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).arrayBuffer();
  }

  function touchLru(key) {
    const previous = lruKeys.indexOf(key);
    if (previous >= 0) lruKeys.splice(previous, 1);
    lruKeys.push(key);
    while (lruKeys.length > MAX_DECODED_CHUNKS) {
      const evicted = lruKeys.shift();
      decodedChunks.delete(evicted);
    }
  }

  async function loadChunk(manifest, index) {
    const key = chunkKey(manifest.caseId, index);
    if (decodedChunks.has(key)) {
      touchLru(key);
      return decodedChunks.get(key);
    }
    if (decodePromises.has(key)) return decodePromises.get(key);

    const promise = (async () => {
      const spec = manifest.chunks[index];
      if (!spec) throw new Error(`Chunk ${index} is outside this case.`);
      if (!encodedChunks.has(key)) {
        await loadScript(new URL(spec.script, manifest.baseUrl).href);
      }
      const encoded = encodedChunks.get(key);
      if (!encoded) throw new Error(`Chunk ${index} did not register its payload.`);
      const compressed = decodeBase64(encoded);
      const buffer = await gunzip(compressed);
      const expected = spec.uncompressedBytes;
      if (expected && buffer.byteLength !== expected) {
        throw new Error(`Chunk ${index} length mismatch: expected ${expected}, got ${buffer.byteLength}.`);
      }
      const pixels = manifest.pixelType === "rgb8" ? new Uint8Array(buffer) : new Int16Array(buffer);
      decodedChunks.set(key, pixels);
      touchLru(key);
      return pixels;
    })();

    decodePromises.set(key, promise);
    try {
      return await promise;
    } finally {
      decodePromises.delete(key);
    }
  }

  function findChunk(manifest, slice) {
    for (let index = 0; index < manifest.chunks.length; index += 1) {
      const chunk = manifest.chunks[index];
      if (slice >= chunk.firstSlice && slice < chunk.firstSlice + chunk.sliceCount) return index;
    }
    return -1;
  }

  const dataApi = {
    manifests,
    encodedChunks,
    registerManifest,
    registerChunk,
    loadManifest,
    loadChunk,
    findChunk,
    hasDecodedChunk,
  };
  internal.data = dataApi;
  global.DicomSlideData = Object.assign(global.DicomSlideData || {}, dataApi);

  const pendingManifests = global.__DICOM_SLIDE_PENDING_MANIFESTS__ || [];
  pendingManifests.splice(0).forEach((entry) => registerManifest(entry[0], entry[1]));
  const pendingChunks = global.__DICOM_SLIDE_PENDING_CHUNKS__ || [];
  pendingChunks.splice(0).forEach((entry) => registerChunk(entry[0], entry[1], entry[2]));
})(window);
