import { CONFIG } from '../public/presentation.config.js';
import { audienceForSlide, scoredPollKeys, slideById } from '../public/assets/slides.js';
import { applySettings, settingsFromConfig, validateSettings } from '../public/assets/settings.js';

const STATE_VERSION = 2;
const POLL_KEYS = Object.keys(CONFIG.polls || {});
const BOARD_KEYS = Object.keys(CONFIG.boards || {});
const EXAM_KEYS = Object.keys(CONFIG.exams || {});
const QUESTION_LIMIT = 5;
const QUESTION_LENGTH = 400;
const AUTHOR_LENGTH = 60;
const STUDY_LIMIT = 256 * 1024;
const MANIFEST_LIMIT = 2 * 1024 * 1024;
const CHUNK_LIMIT = 1.5 * 1024 * 1024;
const UPLOAD_LIMIT = 1024 ** 3;
const UPLOAD_ID = /^[a-z0-9-]{8,64}$/;
const DATA_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
const SESSION_COOKIE = '__Host-presentation_presenter';
const LOCAL_SESSION_COOKIE = 'presentation_presenter';
const SESSION_MAX_AGE = 12 * 60 * 60;
const PRESENTER_AUTH_HEADER = 'X-Presentation-Presenter-Session';
const ENCODER = new TextEncoder();

const PUBLIC_PATHS = new Set([
  '/participar',
  '/participar/',
  '/participar/index.html',
  '/audience.config.js'
]);
const PUBLIC_PREFIXES = ['/assets/', '/dicom-slide/'];

function audienceConfig(config) {
  return {
    title: config.title, brand: config.brand, presenter: config.presenter, citation: config.citation,
    polls: Object.fromEntries(Object.entries(config.polls || {}).map(([key, { correct, ...poll }]) => [key, poll])),
    boards: config.boards || {}, exams: config.exams || {}, settingsRevision: config.settingsRevision
  };
}

function isPublicPath(pathname) {
  return PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

function notFound() {
  return new Response('Not found', {
    status: 404,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8'
    }
  });
}

function privateResponse(response) {
  const nextResponse = new Response(response.body, response);
  nextResponse.headers.set('Cache-Control', 'private, no-store');
  return nextResponse;
}

async function secretsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', ENCODER.encode(provided)),
    crypto.subtle.digest('SHA-256', ENCODER.encode(expected))
  ]);
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
  }
  const left = new Uint8Array(providedHash);
  const right = new Uint8Array(expectedHash);
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('Invalid base64url');
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + padding);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function sessionKey(secret, usages) {
  return crypto.subtle.importKey(
    'raw',
    ENCODER.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages
  );
}

async function createSession(secret, now = Date.now()) {
  const expires = Math.floor(now / 1000) + SESSION_MAX_AGE;
  const payload = `v1.${expires}`;
  const key = await sessionKey(secret, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, ENCODER.encode(payload));
  return `${payload}.${base64Url(signature)}`;
}

function readCookie(request, name) {
  const prefix = `${name}=`;
  for (const part of String(request.headers.get('Cookie') || '').split(';')) {
    const value = part.trim();
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return '';
}

function sessionCookieName(request) {
  return new URL(request.url).protocol === 'https:' ? SESSION_COOKIE : LOCAL_SESSION_COOKIE;
}

async function hasValidSession(request, secret, now = Date.now()) {
  const token = readCookie(request, sessionCookieName(request));
  const [version, expiresText, signatureText, extra] = token.split('.');
  const expires = Number(expiresText);
  const nowSeconds = Math.floor(now / 1000);
  if (extra !== undefined || version !== 'v1' || !Number.isInteger(expires)) return false;
  if (expires <= nowSeconds || expires > nowSeconds + SESSION_MAX_AGE + 60) return false;
  try {
    const key = await sessionKey(secret, ['verify']);
    return crypto.subtle.verify(
      'HMAC',
      key,
      decodeBase64Url(signatureText),
      ENCODER.encode(`${version}.${expiresText}`)
    );
  } catch {
    return false;
  }
}

export function normalizeSlide(value, config = CONFIG) {
  return slideById(config, value)?.id || null;
}

function initialState() {
  return {
    version: STATE_VERSION,
    slide: CONFIG.slides[0].id,
    sequence: 1,
    points: { enabled: Boolean(CONFIG.features?.points?.enabled) },
    polls: Object.fromEntries(POLL_KEYS.map(key => [key, { open: false, locked: false, byVoter: {} }])),
    boards: Object.fromEntries(BOARD_KEYS.map(key => [key, { moderation: CONFIG.boards[key].moderation, messages: [] }])),
    questions: [],
    participants: {},
    devices: {},
    examOverrides: {}
  };
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function setEntry(target, key, value) {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function normalizeStoredState(stored) {
  const state = initialState();
  if (!stored || stored.version !== STATE_VERSION) return state;
  state.slide = normalizeSlide(stored.slide) || state.slide;
  state.sequence = Number.isSafeInteger(stored.sequence) && stored.sequence > 0 ? stored.sequence : 1;
  state.points.enabled = stored.points?.enabled ?? state.points.enabled;
  state.participants = record(stored.participants);
  state.devices = record(stored.devices);
  state.questions = Array.isArray(stored.questions) ? stored.questions : [];
  for (const key of POLL_KEYS) {
    const poll = stored.polls?.[key];
    if (poll) state.polls[key] = { open: Boolean(poll.open), locked: Boolean(poll.locked), byVoter: record(poll.byVoter) };
  }
  for (const key of BOARD_KEYS) {
    const board = stored.boards?.[key];
    if (!board) continue;
    if (['auto', 'manual'].includes(board.moderation)) state.boards[key].moderation = board.moderation;
    if (Array.isArray(board.messages)) state.boards[key].messages = board.messages;
  }
  for (const key of EXAM_KEYS) {
    if (stored.examOverrides?.[key]) state.examOverrides[key] = stored.examOverrides[key];
  }
  return state;
}

function cleanText(value, limit) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function voterKey(state, deviceId) {
  const participantId = Object.hasOwn(state.devices, deviceId) ? state.devices[deviceId] : null;
  return participantId && Object.hasOwn(state.participants, participantId) ? participantId : deviceId;
}

export function summarizePoll(config, poll) {
  const optionIds = config.options.map(option => option.id);
  const counts = Object.fromEntries(optionIds.map(id => [id, 0]));
  let responses = 0;
  let choices = 0;
  if (config.type === 'single') {
    for (const value of Object.values(poll.byVoter || {})) {
      if (!optionIds.includes(value)) continue;
      counts[value] += 1;
      responses += 1;
    }
  } else {
    for (const selected of Object.values(poll.byVoter || {})) {
      let selectedCount = 0;
      for (const id of optionIds) {
        if (!Object.hasOwn(record(selected), id) || !selected[id]) continue;
        counts[id] += 1;
        selectedCount += 1;
      }
      if (selectedCount) {
        responses += 1;
        choices += selectedCount;
      }
    }
  }
  return { open: Boolean(poll.open), responses, counts, average: responses ? choices / responses : 0 };
}

export function computeScores(state, config = CONFIG) {
  const keys = scoredPollKeys(config);
  return Object.fromEntries(Object.keys(state.participants || {}).map(id => [id,
    keys.filter(key => config.polls[key].type === 'single'
      && Object.hasOwn(state.polls?.[key]?.byVoter || {}, id)
      && state.polls[key].byVoter[id] === config.polls[key].correct).length
  ]));
}

export function ranking(state, config = CONFIG) {
  const scores = computeScores(state, config);
  const entries = Object.entries(state.participants || {}).map(([id, participant]) => ({ name: participant.name, score: scores[id] }));
  entries.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name, 'en'));
  let rank = 0;
  return entries.map((entry, index) => {
    if (index === 0 || entry.score !== entries[index - 1].score) rank = index + 1;
    return { rank, ...entry };
  });
}

function pickFields(value, keys) {
  const result = {};
  for (const key of keys) {
    if (!Object.hasOwn(record(value), key)) continue;
    result[key] = typeof value[key] === 'string' ? cleanText(value[key], 400) : value[key];
  }
  return result;
}

export function sanitizeStudy(study) {
  const result = pickFields(study, ['format', 'studyId', 'title', 'modality']);
  result.series = (Array.isArray(study?.series) ? study.series : []).map(series => {
    const entry = pickFields(series, ['id', 'caseId', 'number', 'title', 'modality', 'slices', 'rows', 'columns', 'sortMode']);
    entry.manifest = `series/${entry.id}/manifest.js`;
    return entry;
  });
  result.seriesCount = result.series.length;
  if (study?.source) result.source = pickFields(study.source, ['importedLocally', 'dicomFileCount']);
  return result;
}

export function sanitizeManifest(manifest) {
  const result = pickFields(manifest, [
    'format', 'caseId', 'title', 'modality', 'dimensions', 'spacing', 'orientationLPS',
    'sliceCoordinates', 'sortMode', 'pixelType', 'samplesPerPixel', 'units', 'invert',
    'valueRange', 'initialSlice', 'defaultWindow', 'presets', 'chunks'
  ]);
  for (const [key, fields] of Object.entries({
    dimensions: ['columns', 'rows', 'slices'], spacing: ['column', 'row', 'slice'],
    valueRange: ['minimum', 'maximum'], defaultWindow: ['center', 'width']
  })) {
    if (result[key] !== undefined) result[key] = pickFields(result[key], fields);
  }
  if (result.presets) {
    result.presets = Object.fromEntries(Object.entries(record(result.presets)).map(([key, preset]) =>
      [cleanText(key, 60), pickFields(preset, ['label', 'center', 'width'])]));
  }
  result.chunks = (Array.isArray(manifest?.chunks) ? manifest.chunks : []).map(chunk => {
    const entry = pickFields(chunk, ['index', 'firstSlice', 'sliceCount', 'compressedBytes', 'uncompressedBytes']);
    entry.script = `chunks/chunk-${String(entry.index).padStart(3, '0')}.js`;
    return entry;
  });
  return result;
}

function scriptJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

export function studyScript(study) {
  return `(function(g){\nvar s=${scriptJson(sanitizeStudy(study))};\ns.baseUrl=new URL('.',document.currentScript.src).href;\n(g.__DICOM_SLIDE_STUDIES__||(g.__DICOM_SLIDE_STUDIES__={}))[s.studyId]=s;\n})(window);\n`;
}

export function manifestScript(manifest) {
  return `(function(g){\nvar m=${scriptJson(sanitizeManifest(manifest))};\nm.baseUrl=new URL('.',document.currentScript.src).href;\nvar p=[m.caseId,m];\nif(g.DicomSlideData&&g.DicomSlideData.registerManifest){g.DicomSlideData.registerManifest.apply(null,p);}\nelse{(g.__DICOM_SLIDE_PENDING_MANIFESTS__||(g.__DICOM_SLIDE_PENDING_MANIFESTS__=[])).push(p);}\n})(window);\n`;
}

export function chunkScript(caseId, index, base64) {
  return `(function(g){\nvar p=[${scriptJson(caseId)},${index},${scriptJson(base64)}];\nif(g.DicomSlideData&&g.DicomSlideData.registerChunk){g.DicomSlideData.registerChunk.apply(null,p);}\nelse{(g.__DICOM_SLIDE_PENDING_CHUNKS__||(g.__DICOM_SLIDE_PENDING_CHUNKS__=[])).push(p);}\n})(window);\n`;
}

function resolvedExam(state, key) {
  const override = state.examOverrides[key];
  return override ? {
    title: override.title, studyId: override.studyId,
    src: `/api/exams/${key}/${override.uploadId}/study.js`, override: true
  } : { ...CONFIG.exams[key], override: false };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function apiError(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

function javascriptResponse(source) {
  return new Response(source, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable'
    }
  });
}

async function limitedText(request, limit) {
  if (Number(request.headers.get('Content-Length')) > limit) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const parts = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        return null;
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } finally {
    reader.releaseLock();
  }
}

function validStudy(study) {
  if (study?.format !== 'dicom-slide-study/1' || !DATA_ID.test(study.studyId)
    || typeof study.title !== 'string' || !cleanText(study.title, 400)
    || !Array.isArray(study.series) || !study.series.length) return false;
  const ids = new Set();
  const cases = new Set();
  for (const series of study.series) {
    if (!series || typeof series.id !== 'string' || typeof series.caseId !== 'string'
      || !DATA_ID.test(series.id) || !DATA_ID.test(series.caseId) || ids.has(series.id) || cases.has(series.caseId)) return false;
    ids.add(series.id);
    cases.add(series.caseId);
  }
  return typeof study.studyId === 'string';
}

function validManifest(manifest, caseId) {
  if (manifest?.format !== 'dicom-slide-volume/1' || manifest.caseId !== caseId
    || !Array.isArray(manifest.chunks) || !manifest.chunks.length) return false;
  for (const [index, chunk] of manifest.chunks.entries()) {
    if (chunk?.index !== index) return false;
  }
  return true;
}

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/api/settings' || pathname === '/presentation.config.js' || pathname === '/audience.config.js') {
      return this.settingsFetch(request);
    }
    if (pathname.startsWith('/api/exams/')) return this.examsFetch(request);
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('WebSocket expected', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({
      authenticated: request.headers.get(PRESENTER_AUTH_HEADER) === '1',
      role: 'unknown',
      deviceId: 'anonymous',
      control: false
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async getState() {
    if (!this.cachedState) {
      this.loadingState ||= Promise.all([this.state.storage.get('state'), this.state.storage.get('settings')]).then(([stored, settings]) => {
        this.settings = settings || { revision: 0 };
        this.cachedState = normalizeStoredState(stored);
        return this.cachedState;
      });
      await this.loadingState;
    }
    return this.cachedState;
  }

  async save() {
    await this.state.storage.put('state', this.cachedState);
  }

  async settingsFetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname !== '/audience.config.js' && request.headers.get(PRESENTER_AUTH_HEADER) !== '1') return notFound();
    if (!['GET', 'PUT'].includes(request.method) || (request.method === 'PUT' && pathname !== '/api/settings')) {
      return apiError('Method not allowed', 405);
    }
    const state = await this.getState();
    if (request.method === 'PUT') {
      const body = await limitedText(request, 128 * 1024);
      if (body === null) return apiError('Settings are too large', 413);
      let value;
      try { value = JSON.parse(body); } catch { return apiError('Invalid JSON'); }
      let settings;
      try { settings = validateSettings(value?.settings, CONFIG); } catch (error) { return apiError(error.message); }
      const next = await this.state.storage.transaction(async transaction => {
        const previous = await transaction.get('settings') || { revision: 0 };
        if (value.revision !== previous.revision) return null;
        const updated = { revision: previous.revision + 1, settings };
        await transaction.put('settings', updated);
        return updated;
      });
      if (!next) return apiError('Settings changed in another control room. Discard your changes to load the latest settings.', 409);
      this.settings = next;
      this.broadcast(state);
    }
    const config = applySettings(CONFIG, this.settings);
    if (pathname === '/api/settings') return jsonResponse({ config, defaults: settingsFromConfig(CONFIG) });
    return new Response(`export const CONFIG = ${scriptJson(pathname === '/audience.config.js' ? audienceConfig(config) : config)};\n`, {
      headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }

  aggregate(state, control = false) {
    const polls = {};
    for (const key of POLL_KEYS) polls[key] = summarizePoll(CONFIG.polls[key], state.polls[key]);
    const boards = {};
    for (const key of BOARD_KEYS) {
      const board = state.boards[key];
      const messages = control ? board.messages : board.messages.filter(message => message.status === 'approved').slice(0, 100);
      boards[key] = {
        moderation: board.moderation,
        messages: messages.map(({ id, author, text, createdAt, status }) => ({ id, author, text, createdAt, ...(control ? { status } : {}) }))
      };
    }
    let connected = 0;
    for (const socket of this.state.getWebSockets()) {
      try {
        if ((socket.deserializeAttachment() || {}).role === 'audience') connected += 1;
      } catch { /* The connection closed while counting. */ }
    }
    const result = {
      type: 'state', now: Date.now(), slide: state.slide, settingsRevision: this.settings?.revision || 0,
      audience: audienceForSlide(slideById(CONFIG, state.slide), CONFIG), connected,
      points: { enabled: state.points.enabled }, polls, boards,
      exams: Object.fromEntries(EXAM_KEYS.map(key => [key, resolvedExam(state, key)])),
      ranking: state.points.enabled ? ranking(state).slice(0, 20) : [],
      scoredPolls: scoredPollKeys(CONFIG).length
    };
    if (control) {
      result.questions = state.questions.map(({ id, author, text, createdAt, resolved }) => ({ id, author, text, createdAt, resolved: Boolean(resolved) }));
      result.participants = Object.keys(state.participants).length;
      result.examOverrides = { ...state.examOverrides };
    }
    return result;
  }

  mine(state, deviceId) {
    const voter = voterKey(state, deviceId);
    const participant = Object.hasOwn(state.devices, deviceId) && Object.hasOwn(state.participants, voter)
      ? state.participants[voter] : null;
    const polls = {};
    for (const key of POLL_KEYS) {
      const selections = state.polls[key].byVoter;
      polls[key] = Object.hasOwn(selections, voter) ? selections[voter] : (CONFIG.polls[key].type === 'single' ? '' : {});
    }
    return {
      type: 'mine', polls,
      participant: participant ? { name: participant.name, email: participant.email } : null,
      score: participant ? computeScores(state)[voter] : null
    };
  }

  broadcast(state) {
    const publicState = JSON.stringify(this.aggregate(state));
    const controlState = JSON.stringify(this.aggregate(state, true));
    for (const socket of this.state.getWebSockets()) {
      try {
        const attachment = socket.deserializeAttachment() || {};
        socket.send(attachment.control ? controlState : publicState);
      } catch { /* The connection closed while sending. */ }
    }
  }

  broadcastMine(state, voters = null) {
    for (const socket of this.state.getWebSockets()) {
      try {
        const attachment = socket.deserializeAttachment() || {};
        const deviceId = attachment.deviceId || 'anonymous';
        if (attachment.role === 'audience' && (!voters || voters.has(voterKey(state, deviceId)))) {
          socket.send(JSON.stringify(this.mine(state, deviceId)));
        }
      } catch { /* The connection closed while sending. */ }
    }
  }

  async deleteExamKeys(prefix) {
    // Small pages also bound memory when listing raw chunk values.
    while (true) {
      const keys = [...(await this.state.storage.list({ prefix, limit: 32 })).keys()];
      if (!keys.length) return;
      for (let offset = 0; offset < keys.length; offset += 128) {
        await this.state.storage.delete(keys.slice(offset, offset + 128));
      }
    }
  }

  async removeExamOverride(state, key) {
    const override = state.examOverrides[key];
    if (!override) return false;
    await this.deleteExamKeys(`exam:${key}:${override.uploadId}:`);
    delete state.examOverrides[key];
    return true;
  }

  async examsFetch(request) {
    const method = request.method;
    if (!['GET', 'PUT', 'POST', 'DELETE'].includes(method)) return apiError('Method not allowed', 405);
    if (method !== 'GET' && request.headers.get(PRESENTER_AUTH_HEADER) !== '1') return notFound();
    const parts = new URL(request.url).pathname.slice('/api/exams/'.length).split('/');
    const [key, uploadId, resource, caseId, indexText] = parts;
    if (!EXAM_KEYS.includes(key)) return notFound();
    const state = await this.getState();
    if (method === 'DELETE' && parts.length === 1) {
      if (await this.removeExamOverride(state, key)) {
        await this.save();
        this.broadcast(state);
      }
      return jsonResponse({ ok: true, exam: resolvedExam(state, key) });
    }
    if (!UPLOAD_ID.test(uploadId || '')) return notFound();
    const prefix = `exam:${key}:${uploadId}:`;
    if (method === 'GET') return this.serveExam(parts, prefix);
    if (method === 'POST' && resource === 'commit' && parts.length === 3) return this.commitExam(state, key, uploadId, prefix);
    if (method !== 'PUT') return notFound();
    if (await this.state.storage.get(`${prefix}meta`)) return apiError('This upload is already committed. Use a new upload ID.', 409);
    let storageKey;
    let limit;
    if (resource === 'study' && parts.length === 3) {
      storageKey = `${prefix}study`;
      limit = STUDY_LIMIT;
    } else if (resource === 'manifest' && parts.length === 4 && DATA_ID.test(caseId)) {
      storageKey = `${prefix}manifest:${caseId}`;
      limit = MANIFEST_LIMIT;
    } else if (resource === 'chunk' && parts.length === 5 && DATA_ID.test(caseId)
      && /^(0|[1-9][0-9]*)$/.test(indexText) && Number.isSafeInteger(Number(indexText))) {
      storageKey = `${prefix}chunk:${caseId}:${indexText}`;
      limit = CHUNK_LIMIT;
    } else return notFound();
    const text = await limitedText(request, limit);
    if (text === null) return apiError('Upload body is too large', 413);
    if (resource === 'chunk') {
      // Base64 stays raw text; never decode it or parse it as JSON.
      if (!text || /[^A-Za-z0-9+/=\r\n]/.test(text)) return apiError('Expected base64 chunk text');
    } else {
      let value;
      try { value = JSON.parse(text); } catch { return apiError('Invalid JSON'); }
      if (resource === 'study' ? !validStudy(value) : !validManifest(value, caseId)) return apiError(`Invalid ${resource}`);
    }
    await this.state.storage.put(storageKey, text);
    this.broadcast(state);
    return jsonResponse({ ok: true });
  }

  async commitExam(state, key, uploadId, prefix) {
    if (await this.state.storage.get(`${prefix}meta`)) {
      return state.examOverrides[key]?.uploadId === uploadId
        ? jsonResponse({ ok: true, exam: resolvedExam(state, key) })
        : apiError('This upload is already committed', 409);
    }
    const studyText = await this.state.storage.get(`${prefix}study`);
    if (typeof studyText !== 'string') return apiError('The study is missing');
    const study = JSON.parse(studyText);
    if (!validStudy(study)) return apiError('Invalid study');
    let bytes = ENCODER.encode(studyText).byteLength;
    const chunks = {};
    for (const series of study.series) {
      const manifestText = await this.state.storage.get(`${prefix}manifest:${series.caseId}`);
      if (typeof manifestText !== 'string') return apiError(`Manifest is missing: ${series.caseId}`);
      const manifest = JSON.parse(manifestText);
      if (!validManifest(manifest, series.caseId)) return apiError(`Invalid manifest: ${series.caseId}`);
      bytes += ENCODER.encode(manifestText).byteLength;
      chunks[series.caseId] = manifest.chunks.length;
      for (const chunk of manifest.chunks) {
        const payload = await this.state.storage.get(`${prefix}chunk:${series.caseId}:${chunk.index}`);
        if (typeof payload !== 'string' || !payload.length) return apiError(`Chunk is missing: ${series.caseId}/${chunk.index}`);
        bytes += payload.length;
        if (bytes > UPLOAD_LIMIT) return apiError('The upload exceeds 1 GB', 413);
      }
    }
    if (bytes > UPLOAD_LIMIT) return apiError('The upload exceeds 1 GB', 413);
    const sanitizedStudy = sanitizeStudy(study);
    await this.state.storage.put(`${prefix}study`, JSON.stringify(sanitizedStudy));
    for (const series of study.series) {
      const storageKey = `${prefix}manifest:${series.caseId}`;
      const manifest = JSON.parse(await this.state.storage.get(storageKey));
      await this.state.storage.put(storageKey, JSON.stringify(sanitizeManifest(manifest)));
    }
    const createdAt = Date.now();
    await this.state.storage.put(`${prefix}meta`, { bytes, chunks, createdAt });
    const previous = state.examOverrides[key];
    state.examOverrides[key] = { uploadId, studyId: sanitizedStudy.studyId, title: sanitizedStudy.title, seriesCount: sanitizedStudy.seriesCount, bytes, createdAt };
    await this.save();
    if (previous && previous.uploadId !== uploadId) await this.deleteExamKeys(`exam:${key}:${previous.uploadId}:`);
    this.broadcast(state);
    return jsonResponse({ ok: true, exam: resolvedExam(state, key) });
  }

  async serveExam(parts, prefix) {
    // Incomplete uploads are private until commit has removed source metadata.
    if (!await this.state.storage.get(`${prefix}meta`)) return notFound();
    const studyText = await this.state.storage.get(`${prefix}study`);
    if (typeof studyText !== 'string') return notFound();
    const study = JSON.parse(studyText);
    if (parts.length === 3 && parts[2] === 'study.js') return javascriptResponse(studyScript(study));
    if (parts[2] !== 'series') return notFound();
    const series = study.series.find(entry => entry.id === parts[3]);
    if (!series) return notFound();
    if (parts.length === 5 && parts[4] === 'manifest.js') {
      const manifestText = await this.state.storage.get(`${prefix}manifest:${series.caseId}`);
      return typeof manifestText === 'string' ? javascriptResponse(manifestScript(JSON.parse(manifestText))) : notFound();
    }
    const match = parts.length === 6 && parts[4] === 'chunks' && /^chunk-([0-9]{3,})\.js$/.exec(parts[5]);
    if (!match || !Number.isSafeInteger(Number(match[1]))) return notFound();
    const index = Number(match[1]);
    const payload = await this.state.storage.get(`${prefix}chunk:${series.caseId}:${index}`);
    return typeof payload === 'string' ? javascriptResponse(chunkScript(series.caseId, index, payload)) : notFound();
  }

  async webSocketMessage(socket, rawMessage) {
    let message;
    try { message = JSON.parse(rawMessage); } catch { return; }
    if (!message || typeof message !== 'object') return;
    const state = await this.getState();
    const attachment = socket.deserializeAttachment() || {};

    if (message.type === 'hello') {
      const role = ['audience', 'presenter', 'control'].includes(message.role) ? message.role : 'audience';
      const authorized = attachment.authenticated === true
        || await secretsMatch(String(message.key || ''), this.env.PRESENTER_KEY);
      const requestedDeviceId = cleanText(message.deviceId, 64) || 'anonymous';
      // Participant IDs and anonymous device IDs must occupy different namespaces.
      const deviceId = /^p-[0-9a-f]{16}$/.test(requestedDeviceId) ? `device:${requestedDeviceId}` : requestedDeviceId;
      const control = authorized && role !== 'audience';
      socket.serializeAttachment({ authenticated: attachment.authenticated === true, role, deviceId, control });
      socket.send(JSON.stringify({ type: 'hello', role, authorized }));
      if (role === 'audience') socket.send(JSON.stringify(this.mine(state, deviceId)));
      socket.send(JSON.stringify(this.aggregate(state, control)));
      this.broadcast(state);
      return;
    }

    const role = attachment.role || 'unknown';
    const deviceId = attachment.deviceId || 'anonymous';
    const voter = voterKey(state, deviceId);
    const error = text => socket.send(JSON.stringify({ type: 'error', message: text }));
    let acknowledgement;
    let syncPersonalState = false;
    let affectedVoters = null;

    if (role === 'audience' && message.type === 'register') {
      const name = cleanText(message.name, AUTHOR_LENGTH + 1);
      const email = cleanText(message.email, 121).toLowerCase();
      if (!name || name.length > AUTHOR_LENGTH || email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        error('Enter a name of 1–60 characters and a valid email of at most 120 characters.');
        return;
      }
      const digest = await crypto.subtle.digest('SHA-256', ENCODER.encode(email));
      const participantId = `p-${Array.from(new Uint8Array(digest)).slice(0, 8).map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
      const existing = state.participants[participantId];
      state.participants[participantId] = { name, email, createdAt: existing?.createdAt ?? Date.now() };
      setEntry(state.devices, deviceId, participantId);
      for (const poll of Object.values(state.polls)) {
        if (!Object.hasOwn(poll.byVoter, deviceId)) continue;
        if (!Object.hasOwn(poll.byVoter, participantId)) setEntry(poll.byVoter, participantId, poll.byVoter[deviceId]);
        delete poll.byVoter[deviceId];
      }
      syncPersonalState = true;
      affectedVoters = new Set([voter, participantId]);
    } else if (role === 'audience' && message.type === 'vote') {
      if (!POLL_KEYS.includes(message.poll)) return;
      const config = CONFIG.polls[message.poll];
      const poll = state.polls[message.poll];
      if (!poll.open) return;
      const optionIds = config.options.map(option => option.id);
      if (!optionIds.includes(message.option)) return;
      if (config.type === 'single') {
        setEntry(poll.byVoter, voter, message.option);
      } else {
        const selected = { ...(Object.hasOwn(poll.byVoter, voter) ? poll.byVoter[voter] : {}) };
        if (config.exclusive && message.option === config.exclusive && message.value) {
          for (const id of optionIds) selected[id] = false;
        } else if (config.exclusive && message.value) selected[config.exclusive] = false;
        selected[message.option] = Boolean(message.value);
        setEntry(poll.byVoter, voter, selected);
      }
      syncPersonalState = true;
      affectedVoters = new Set([voter]);
    } else if (role === 'audience' && message.type === 'board_message') {
      if (!BOARD_KEYS.includes(message.board)) return;
      const board = state.boards[message.board];
      const author = cleanText(message.author, AUTHOR_LENGTH + 1);
      const text = cleanText(message.text, QUESTION_LENGTH + 1);
      if (!author || author.length > AUTHOR_LENGTH || !text || text.length > QUESTION_LENGTH) {
        error('Enter a name of 1–60 characters and a message of 1–400 characters.');
        return;
      }
      if (board.messages.filter(item => item.voter === voter && item.status === 'pending').length >= QUESTION_LIMIT) {
        error(`You can have up to ${QUESTION_LIMIT} pending messages per board.`);
        return;
      }
      const now = Date.now();
      const tooSoon = Object.values(state.boards).some(item => item.messages.some(entry => entry.voter === voter && now - entry.createdAt < 2000));
      if (tooSoon) {
        error('Wait at least 2 seconds between messages.');
        return;
      }
      const entry = { id: state.sequence++, voter, author, text, createdAt: now, status: board.moderation === 'auto' ? 'approved' : 'pending' };
      board.messages.unshift(entry);
      acknowledgement = { type: 'message_received', id: entry.id };
    } else if (role === 'audience' && message.type === 'question') {
      const author = cleanText(message.author, AUTHOR_LENGTH + 1);
      const text = cleanText(message.text, QUESTION_LENGTH + 1);
      if (author.length > AUTHOR_LENGTH || !text || text.length > QUESTION_LENGTH) {
        error('Use a name of at most 60 characters and a question of 1–400 characters.');
        return;
      }
      if (state.questions.filter(question => question.voter === voter && !question.resolved).length >= QUESTION_LIMIT) {
        error(`You can have up to ${QUESTION_LIMIT} pending questions.`);
        return;
      }
      const question = { id: state.sequence++, voter, author, text, createdAt: Date.now(), resolved: false };
      state.questions.unshift(question);
      acknowledgement = { type: 'question_received', id: question.id };
    } else if (attachment.control) {
      if (message.type === 'slide') {
        const slide = slideById(CONFIG, message.slide);
        if (!slide) return;
        state.slide = slide.id;
        if (slide.poll) {
          const poll = state.polls[slide.poll];
          if (slide.pollResults === 'final') {
            poll.open = false;
            poll.locked = true;
          } else if (!poll.locked) poll.open = true;
        }
      } else if (message.type === 'set_poll') {
        if (!POLL_KEYS.includes(message.poll)) return;
        state.polls[message.poll].open = Boolean(message.open);
        state.polls[message.poll].locked = !message.open;
      } else if (message.type === 'reset_poll') {
        if (!POLL_KEYS.includes(message.poll)) return;
        state.polls[message.poll].byVoter = {};
        syncPersonalState = true;
        acknowledgement = { type: 'reset_complete', scope: 'poll', poll: message.poll };
      } else if (message.type === 'reset_all_polls') {
        for (const poll of Object.values(state.polls)) poll.byVoter = {};
        syncPersonalState = true;
        acknowledgement = { type: 'reset_complete', scope: 'polls' };
      } else if (message.type === 'set_points') {
        state.points.enabled = Boolean(message.enabled);
      } else if (message.type === 'set_board_mode') {
        if (!BOARD_KEYS.includes(message.board) || !['auto', 'manual'].includes(message.moderation)) return;
        state.boards[message.board].moderation = message.moderation;
      } else if (message.type === 'moderate_message') {
        if (!BOARD_KEYS.includes(message.board)) return;
        const board = state.boards[message.board];
        const entry = board.messages.find(item => item.id === message.id);
        if (!entry) return;
        if (message.action === 'approve') entry.status = 'approved';
        else if (message.action === 'reject') entry.status = 'rejected';
        else if (message.action === 'delete') board.messages = board.messages.filter(item => item.id !== message.id);
        else return;
      } else if (message.type === 'moderate_question') {
        const question = state.questions.find(item => item.id === message.id);
        if (!question) return;
        if (message.action === 'resolve') question.resolved = true;
        else if (message.action === 'reopen') question.resolved = false;
        else if (message.action === 'delete') state.questions = state.questions.filter(item => item.id !== message.id);
        else return;
      } else if (message.type === 'remove_exam_override') {
        if (!EXAM_KEYS.includes(message.exam) || !await this.removeExamOverride(state, message.exam)) return;
      } else if (message.type === 'reset_session') {
        await this.deleteExamKeys('exam:');
        const nextState = initialState();
        nextState.slide = state.slide;
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, nextState);
        syncPersonalState = true;
        acknowledgement = { type: 'reset_complete', scope: 'session' };
      } else return;
    } else return;

    await this.save();
    this.broadcast(state);
    if (syncPersonalState) this.broadcastMine(state, affectedVoters);
    if (acknowledgement) socket.send(JSON.stringify(acknowledgement));
  }

  async webSocketClose() {
    this.broadcast(await this.getState());
  }

  async webSocketError() {
    this.broadcast(await this.getState());
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const roomName = (url.searchParams.get('room') || 'main').slice(0, 32);
      const headers = new Headers(request.headers);
      headers.delete(PRESENTER_AUTH_HEADER);
      if (await hasValidSession(request, env.PRESENTER_KEY)) headers.set(PRESENTER_AUTH_HEADER, '1');
      const socketRequest = new Request(request, { headers });
      return env.ROOM.get(env.ROOM.idFromName(roomName)).fetch(socketRequest);
    }

    if (url.pathname.startsWith('/api/exams/')) {
      if (!['GET', 'PUT', 'POST', 'DELETE'].includes(request.method)) return apiError('Method not allowed', 405);
      const headers = new Headers(request.headers);
      headers.delete(PRESENTER_AUTH_HEADER);
      if (request.method !== 'GET') {
        if (!await hasValidSession(request, env.PRESENTER_KEY)) return notFound();
        headers.set(PRESENTER_AUTH_HEADER, '1');
      }
      const room = env.ROOM.get(env.ROOM.idFromName('main'));
      if (request.method === 'GET') {
        const cache = caches.default;
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await room.fetch(new Request(request, { headers }));
        if (response.ok) ctx.waitUntil(cache.put(request, response.clone()));
        return response;
      }
      return room.fetch(new Request(request, { headers }));
    }

    if (['/api/settings', '/presentation.config.js', '/audience.config.js'].includes(url.pathname)) {
      const headers = new Headers(request.headers);
      headers.delete(PRESENTER_AUTH_HEADER);
      if (url.pathname !== '/audience.config.js') {
        if (!await hasValidSession(request, env.PRESENTER_KEY)) return notFound();
        headers.set(PRESENTER_AUTH_HEADER, '1');
      }
      if (request.method === 'PUT' && (request.headers.get('Origin') !== url.origin
        || !request.headers.get('Content-Type')?.startsWith('application/json'))) return apiError('Invalid settings request', 403);
      return env.ROOM.get(env.ROOM.idFromName('main')).fetch(new Request(request, { headers }));
    }

    if (isPublicPath(url.pathname)) return env.ASSETS.fetch(request);

    const providedKey = url.searchParams.get('k');
    if (providedKey !== null) {
      if (!await secretsMatch(providedKey, env.PRESENTER_KEY)) return notFound();
      const session = await createSession(env.PRESENTER_KEY);
      url.searchParams.delete('k');
      const location = `${url.pathname}${url.search}${url.hash}`;
      const cookieName = sessionCookieName(request);
      const secure = cookieName === SESSION_COOKIE ? '; Secure' : '';
      return new Response(null, {
        status: 303,
        headers: {
          'Cache-Control': 'no-store',
          'Location': location,
          'Set-Cookie': `${cookieName}=${session}; Max-Age=${SESSION_MAX_AGE}; HttpOnly${secure}; SameSite=Strict; Path=/`
        }
      });
    }

    if (!await hasValidSession(request, env.PRESENTER_KEY)) return notFound();
    return privateResponse(await env.ASSETS.fetch(request));
  }
};
