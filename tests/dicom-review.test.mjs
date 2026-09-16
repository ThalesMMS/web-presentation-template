import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';

const read = path => readFileSync(new URL(`../public/dicom-slide/${path}`, import.meta.url), 'utf8');
function runtime(files, extra = {}) {
  const context = vm.createContext({ URL, console, ...extra });
  context.window = context;
  for (const file of files) vm.runInContext(read(file), context);
  return context;
}

test('JPEG-LS normalizes planar, line and pixel interleave across multiple rows', () => {
  const context = runtime(['importer/dicom-importer.js']);
  const normalize = context.DicomSlidesImporter.testing.normalizeJpegLsColor;
  const expected = [1, 11, 21, 2, 12, 22, 3, 13, 23, 4, 14, 24];
  const modes = [
    [1, 2, 3, 4, 11, 12, 13, 14, 21, 22, 23, 24],
    [1, 2, 11, 12, 21, 22, 3, 4, 13, 14, 23, 24],
    expected,
  ];
  modes.forEach((bytes, mode) => assert.deepEqual([...normalize(Uint8Array.from(bytes), 2, 2, mode)], expected));
  assert.throws(() => normalize(new Uint8Array(12), 2, 2, 3), /unsupported interleave/);
});

for (const study of [false, true]) {
  test(`${study ? 'study' : 'data'} script cache retries failures and shares successful loads`, async () => {
    const scripts = [];
    const document = { baseURI: 'https://example.test/', createElement: () => ({}), head: { appendChild: s => scripts.push(s) } };
    const context = runtime([study ? 'runtime/study/study-viewer.js' : 'runtime/core/data-registry.js'], { document });
    const load = study ? context.DicomSlideStudy.loadStudy : context.DicomSlideData.loadManifest;
    const register = (id, manifest) => {
      if (study) (context.__DICOM_SLIDE_STUDIES__ ||= {})[id] = manifest;
      else context.DicomSlideData.registerManifest(id, manifest);
    };
    const first = load('case', 'manifest.js');
    const concurrent = load('case', 'manifest.js');
    const failures = Promise.all([assert.rejects(first, /Could not load/), assert.rejects(concurrent, /Could not load/)]);
    assert.equal(scripts.length, 1);
    scripts[0].onerror();
    await failures;
    const retry = load('case', 'manifest.js');
    assert.equal(scripts.length, 2);
    const manifest = { series: [{}] };
    register('case', manifest);
    scripts[1].onload();
    assert.equal(await retry, manifest);
    // A different ID using the same successful script must not load it again.
    await assert.rejects(load('missing', 'manifest.js'), /did not register/);
    assert.equal(scripts.length, 2);
  });
}

test('invalid slices and unknown series leave viewer state unchanged', async () => {
  const context = runtime(['runtime/core/data-registry.js', 'runtime/core/viewer.js', 'runtime/study/study-viewer.js']);
  const viewer = {
    manifest: { dimensions: { slices: 10 } }, state: { slice: 4, mode: 'mpr' },
    slider: {}, _updateOverlay() {}, _emit() {}, getState() { return this.state; },
  };
  const setSlice = context.DicomSlideViewer.Viewer.prototype.setSlice;
  for (const value of [NaN, Infinity, -Infinity, 'invalid']) await setSlice.call(viewer, value);
  assert.equal(viewer.state.slice, 4);
  for (const [value, expected] of [[99, 9], [-2, 0], ['3.6', 4]]) {
    await setSlice.call(viewer, value);
    assert.equal(viewer.state.slice, expected);
  }
  const study = { study: { series: [{ id: 'one', number: 1 }] }, seriesIndex: 0 };
  for (const value of ['unknown', -1, -0.4, 0.4, 9, NaN, Infinity]) {
    await context.DicomSlideStudy.StudyViewer.prototype.setSeries.call(study, value);
    assert.equal(study.seriesIndex, 0);
  }
});

test('WebGL failures use the overlay without requesting another canvas context', () => {
  const context = runtime(['runtime/volume/geometry.js', 'runtime/volume/transfer-functions.js', 'runtime/volume/webgl-renderer.js']);
  const meta = {};
  const renderer = { gl: {}, canvas: {
    parentElement: { querySelector: () => meta },
    getContext() { assert.fail('WebGL canvas cannot acquire a 2D context'); },
  } };
  context.__DicomSlideInternal.volume.webgl.WebGLVolumeRenderer.prototype._fallback.call(renderer, 'Shader compile failure');
  assert.equal(meta.textContent, 'Shader compile failure');
  assert.equal(renderer.failed, true);
});

test('normal CT contains an interpolated plane with consistent chunks and physical coordinates', () => {
  const root = 'exams/library/visible-human-abdomen-ct/';
  const path = `${root}series/normal-ct/`;
  const manifest = JSON.parse(read(`${path}manifest.json`));
  const context = runtime([`${path}manifest.js`, `${root}study.js`], { document: { currentScript: { src: 'https://example.test/manifest.js' } } });
  assert.deepEqual(JSON.parse(JSON.stringify(context.__DICOM_SLIDE_PENDING_MANIFESTS__[0][1], (key, value) => key === 'baseUrl' ? undefined : value)), manifest);
  assert.equal(JSON.parse(read(`${root}study.json`)).series[0].slices, manifest.dimensions.slices);
  assert.equal(context.__DICOM_SLIDE_STUDIES__['visible-human-abdomen-ct'].series[0].slices, manifest.dimensions.slices);
  assert.equal(manifest.sliceCoordinates.length, 101);
  manifest.sliceCoordinates.forEach((position, index) => assert.equal(position, -408 + index * 3));
  let next = 0;
  const chunks = manifest.chunks.map(spec => {
    assert.equal(spec.firstSlice, next);
    next += spec.sliceCount;
    const context = runtime([`${path}${spec.script}`]);
    const compressed = Buffer.from(context.__DICOM_SLIDE_PENDING_CHUNKS__[0][2], 'base64');
    assert.equal(compressed.length, spec.compressedBytes);
    const bytes = gunzipSync(compressed);
    assert.equal(bytes.length, spec.uncompressedBytes);
    assert.equal(bytes.length, spec.sliceCount * 256 * 256 * 2);
    return bytes;
  });
  assert.equal(next, manifest.dimensions.slices);
  const bytes = Buffer.concat(chunks);
  const plane = 256 * 256 * 2;
  for (let offset = 0; offset < plane; offset += 2) {
    const mean = (bytes.readInt16LE(80 * plane + offset) + bytes.readInt16LE(82 * plane + offset)) / 2;
    assert.ok(Math.abs(bytes.readInt16LE(81 * plane + offset) - mean) <= 0.5);
  }
  assert.match(manifest.source.derivation, /interpolated/);
});

test('iframe initialization sends exactly one ready notification', async () => {
  const messages = [];
  const listeners = new Map();
  let resolveReady;
  const element = {
    ready: new Promise(resolve => { resolveReady = resolve; }),
    setAttribute() {},
    addEventListener(name, listener) { listeners.set(name, listener); },
    getState() { return { studyTitle: 'Study' }; },
  };
  runtime(['runtime/iframe/adapter.js'], {
    URLSearchParams, location: { search: '' },
    DicomSlide: { ready: Promise.resolve() },
    parent: { postMessage: message => messages.push(message) },
    addEventListener() {},
    document: { createElement: () => element, body: { appendChild() {} } },
  });
  await Promise.resolve();
  listeners.get('dicom-ready')({ detail: element.getState() });
  resolveReady();
  await element.ready;
  await Promise.resolve();
  assert.deepEqual(messages.map(message => message.type), ['ready']);
});
