/* Presenter exam viewers and study uploads. Viewer changes come from room state. */
const RUNTIME_URL = '/dicom-slide/runtime/dicom-slide.js';
const IMPORTER_URL = '/dicom-slide/importer/dicom-importer.js';
// Decoders for JPEG 2000 and JPEG-LS transfer syntaxes; each script locates its .wasm next to itself.
const CODEC_URLS = [
  '/dicom-slide/importer/vendor/openjpeg/openjpegwasm_decode.js',
  '/dicom-slide/importer/vendor/charls/charlswasm_decode.js'
];
const MAX_CHUNK_BYTES = 1.5 * 1024 * 1024;
const mounts = new WeakMap();
const scripts = new Map();

function loadScriptOnce(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error('The DICOM module could not load. Reload the page and try again.'));
      document.head.append(script);
    }));
  }
  return scripts.get(src);
}

async function loadRuntime() {
  if (!window.DicomSlide?.ready) await loadScriptOnce(RUNTIME_URL);
  if (!window.DicomSlide?.ready) throw new Error('The DICOM viewer is unavailable.');
  await window.DicomSlide.ready;
}

async function loadImporter() {
  if (!window.DicomSlidesImporter?.importFiles) await loadScriptOnce(IMPORTER_URL);
  await Promise.all(CODEC_URLS.map(loadScriptOnce));
  if (!window.DicomSlidesImporter?.importFiles) throw new Error('The DICOM importer is unavailable.');
  return window.DicomSlidesImporter;
}

function jsonPayload(value, limit, label) {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > limit) {
    throw new Error(`${label} is too large to upload. Reduce the study or series and try again.`);
  }
  return body;
}

function uploadParts(packageRecord, uploadId) {
  if (!packageRecord?.study?.series?.length || !packageRecord.manifests || !packageRecord.chunks) {
    throw new Error('The importer did not return a complete DICOM study.');
  }
  // The runtime caches by study/case ID, so each upload needs its own identities.
  const studyId = `uploaded-${uploadId}`;
  const study = {
    ...packageRecord.study,
    studyId,
    series: packageRecord.study.series.map(series => ({ ...series, caseId: `${studyId}--${series.id}` }))
  };
  const parts = [{
    route: 'study',
    body: jsonPayload(study, 256 * 1024, 'The study description'),
    contentType: 'application/json'
  }];
  const chunks = [];
  for (const [seriesIndex, series] of study.series.entries()) {
    const caseId = series.caseId;
    const importedCaseId = packageRecord.study.series[seriesIndex].caseId;
    const manifest = packageRecord.manifests[importedCaseId];
    const payloads = packageRecord.chunks[importedCaseId];
    if (!manifest?.chunks?.length || !Array.isArray(payloads) || payloads.length !== manifest.chunks.length) {
      throw new Error('The converted study is missing a manifest or image chunks. Try importing it again.');
    }
    parts.push({
      route: `manifest/${encodeURIComponent(caseId)}`,
      body: jsonPayload({ ...manifest, caseId }, 2 * 1024 * 1024, 'A series manifest'),
      contentType: 'application/json'
    });
    for (const chunk of manifest.chunks) {
      const body = payloads[chunk.index];
      if (typeof body !== 'string' || !body.length) {
        throw new Error('The converted study is missing an image chunk. Try importing it again.');
      }
      // Base64 is ASCII, so its string length is its upload size in bytes.
      if (body.length > MAX_CHUNK_BYTES) {
        throw new Error(`An image chunk in "${series.title || series.id}" exceeds the 1.5 MB upload limit. Reduce the series and try again.`);
      }
      chunks.push({
        route: `chunk/${encodeURIComponent(caseId)}/${chunk.index}`,
        body,
        contentType: 'text/plain; charset=utf-8'
      });
    }
  }
  parts.push(...chunks);
  const bytes = parts.reduce((total, part) => total + (part.contentType.startsWith('text/plain')
    ? part.body.length : new TextEncoder().encode(part.body).byteLength), 0);
  if (bytes > 1024 ** 3) throw new Error('The converted study exceeds the 1 GB upload limit. Reduce the study and try again.');
  return parts;
}

async function uploadRequest(url, options) {
  let response;
  try {
    response = await fetch(url, { ...options, credentials: 'same-origin' });
  } catch {
    throw new Error('The upload was interrupted. Check your connection and try again.');
  }
  if (response.redirected || response.status === 401 || response.status === 403) {
    throw new Error('Presenter sign-in is required. Reload this page and sign in before uploading.');
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    const message = typeof detail?.error === 'string' ? detail.error : detail?.message;
    throw new Error(typeof message === 'string' ? message : `The upload failed (HTTP ${response.status}). Try again.`);
  }
  return response;
}

/** Mount once per host; update the viewer only when the resolved study changes. */
export function mountExam(host, examKey, descriptor) {
  const existing = mounts.get(host);
  if (existing) {
    existing.update(descriptor);
    return existing;
  }

  host.classList.add('stage-exam');
  host.innerHTML = `
    <div class="stage-exam-heading">
      <h2 class="stage-exam-title"></h2>
      <span class="status stage-exam-override" hidden>Uploaded study</span>
    </div>
    <div class="stage-exam-viewer" aria-busy="false"></div>
    <div class="stage-exam-upload">
      <div class="stage-upload-actions">
        <button class="button secondary" type="button" data-upload-folder title="Choose a DICOM folder">Upload DICOM study</button>
        <button class="button secondary" type="button" data-upload-zip>Choose ZIP</button>
      </div>
      <p class="stage-upload-help">Choose a DICOM folder or a ZIP file to replace this exam for everyone.</p>
      <input type="file" multiple webkitdirectory hidden data-folder-input aria-label="Choose a DICOM folder">
      <input type="file" accept=".zip,application/zip,application/x-zip-compressed" hidden data-zip-input aria-label="Choose a DICOM ZIP file">
      <div class="stage-upload-progress" hidden>
        <progress max="1" value="0" aria-label="DICOM upload progress"></progress>
        <p class="stage-upload-status" role="status" aria-live="polite"></p>
      </div>
    </div>`;

  const title = host.querySelector('.stage-exam-title');
  const override = host.querySelector('.stage-exam-override');
  const viewerHost = host.querySelector('.stage-exam-viewer');
  const folderInput = host.querySelector('[data-folder-input]');
  const zipInput = host.querySelector('[data-zip-input]');
  const folderButton = host.querySelector('[data-upload-folder]');
  const zipButton = host.querySelector('[data-upload-zip]');
  const progress = host.querySelector('.stage-upload-progress');
  const progressBar = progress.querySelector('progress');
  const progressText = progress.querySelector('.stage-upload-status');
  let identity;
  let generation = 0;
  let busy = false;

  function showProgress(text, value, error = false) {
    progress.hidden = false;
    progress.classList.toggle('is-error', error);
    progressBar.value = Math.max(0, Math.min(1, value));
    progressText.setAttribute('role', error ? 'alert' : 'status');
    progressText.textContent = text;
  }

  function showViewerMessage(message) {
    const node = document.createElement('p');
    node.className = 'stage-exam-state';
    node.setAttribute('role', 'status');
    node.textContent = message;
    viewerHost.replaceChildren(node);
  }

  async function update(nextDescriptor) {
    title.textContent = nextDescriptor?.title || 'DICOM study';
    override.hidden = !nextDescriptor?.override;
    const nextIdentity = JSON.stringify([nextDescriptor?.studyId, nextDescriptor?.src]);
    if (identity === nextIdentity) return;
    identity = nextIdentity;
    const currentGeneration = ++generation;
    viewerHost.classList.remove('is-expanded');
    viewerHost.setAttribute('aria-busy', 'false');
    if (!nextDescriptor?.studyId || !nextDescriptor?.src) {
      showViewerMessage('Waiting for the study…');
      return;
    }
    showViewerMessage('Loading study…');
    viewerHost.setAttribute('aria-busy', 'true');
    try {
      await loadRuntime();
      if (currentGeneration !== generation) return;
      const viewer = document.createElement('dicom-study-viewer');
      viewer.setAttribute('study-id', nextDescriptor.studyId);
      viewer.setAttribute('src', nextDescriptor.src);
      viewer.setAttribute('aria-label', nextDescriptor.title || 'DICOM study');
      viewer.addEventListener('dicom-expand-request', () => {
        const expanded = viewerHost.classList.toggle('is-expanded');
        viewer.setExpanded(expanded).catch(() => {});
      });
      viewerHost.replaceChildren(viewer);
      await viewer.ready;
    } catch (error) {
      if (currentGeneration === generation) showViewerMessage(`Unable to load the study. ${error.message || error}`);
    } finally {
      if (currentGeneration === generation) viewerHost.setAttribute('aria-busy', 'false');
    }
  }

  async function importAndUpload(files) {
    if (busy || !files.length) return;
    busy = true;
    [folderButton, zipButton, folderInput, zipInput].forEach(control => { control.disabled = true; });
    showProgress('Converting…', 0);
    try {
      const importer = await loadImporter();
      const result = await importer.importFiles(files, {
        persist: false,
        register: false,
        onProgress: detail => showProgress(`Converting…${detail.message ? ` ${detail.message}` : ''}`, (Number(detail.progress) || 0) * 0.45)
      });
      const randomHex = Array.from(crypto.getRandomValues(new Uint8Array(4)), byte => byte.toString(16).padStart(2, '0')).join('');
      const uploadId = `u-${Date.now().toString(36)}-${randomHex}`;
      // Validate every part before sending any upload requests.
      const parts = uploadParts(result.package, uploadId);
      const baseUrl = `/api/exams/${encodeURIComponent(examKey)}/${uploadId}`;
      showProgress(`Uploading 0/${parts.length}`, 0.45);
      for (const [index, part] of parts.entries()) {
        await uploadRequest(`${baseUrl}/${part.route}`, {
          method: 'PUT',
          headers: { 'Content-Type': part.contentType },
          body: part.body
        });
        showProgress(`Uploading ${index + 1}/${parts.length}`, 0.45 + (index + 1) / parts.length * 0.5);
      }
      showProgress(`Uploading ${parts.length}/${parts.length} · Publishing…`, 0.95);
      const response = await uploadRequest(`${baseUrl}/commit`, { method: 'POST' });
      const receipt = await response.json().catch(() => null);
      if (!receipt?.ok) throw new Error('The server did not confirm the study upload. Try again.');
      // The commit broadcast updates the stage and audience through state.exams.
      showProgress('Done · Study shared with everyone.', 1);
    } catch (error) {
      showProgress(`Upload failed. ${error.message || error}`, progressBar.value, true);
    } finally {
      busy = false;
      [folderButton, zipButton, folderInput, zipInput].forEach(control => { control.disabled = false; });
      folderInput.value = '';
      zipInput.value = '';
    }
  }

  folderButton.addEventListener('click', () => folderInput.click());
  zipButton.addEventListener('click', () => zipInput.click());
  folderInput.addEventListener('change', () => importAndUpload(Array.from(folderInput.files || [])));
  zipInput.addEventListener('change', () => importAndUpload(Array.from(zipInput.files || [])));
  const mount = { update };
  mounts.set(host, mount);
  update(descriptor);
  return mount;
}
