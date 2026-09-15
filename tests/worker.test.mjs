import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import test from 'node:test';

import { CONFIG } from '../public/presentation.config.js';
import worker, {
  normalizeSlide, summarizePoll, computeScores, ranking, sanitizeStudy, sanitizeManifest,
  studyScript, manifestScript, chunkScript, Room
} from '../src/worker.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
globalThis.WebSocketRequestResponsePair = class {
  constructor(request, response) { Object.assign(this, { request, response }); }
};

const AUTH_HEADER = 'X-Presentation-Presenter-Session';
const SECRET = 'test-presenter-secret';
const UPLOAD = 'upload-0001';
const EXAM = 'abdomen-ct';
const PREFIX = `exam:${EXAM}:${UPLOAD}:`;
const PAYLOAD = 'AQIDBA==';

class MemoryStorage {
  data = new Map();
  deletions = [];
  listings = [];
  writes = [];
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) {
    if (typeof value === 'string') assert.ok(Buffer.byteLength(value) <= 2 * 1024 * 1024, 'Storage values must fit the SQLite limit');
    this.writes.push(key);
    this.data.set(key, structuredClone(value));
  }
  async list({ prefix, limit = Infinity }) {
    this.listings.push(prefix);
    return new Map([...this.data].filter(([key]) => key.startsWith(prefix)).sort(([left], [right]) => left.localeCompare(right)).slice(0, limit));
  }
  async delete(keys) {
    const batch = Array.isArray(keys) ? keys : [keys];
    this.deletions.push(batch);
    assert.ok(batch.length <= 128, 'Storage deletion batches must contain at most 128 keys');
    for (const key of batch) this.data.delete(key);
  }
}

function harness() {
  const storage = new MemoryStorage();
  const sockets = [];
  const context = {
    storage, getWebSockets: () => sockets,
    setWebSocketAutoResponse: value => { context.autoResponse = value; }
  };
  const room = new Room(context, { PRESENTER_KEY: SECRET });
  const addSocket = (deviceId, role = 'audience', control = false) => {
    const socket = {
      attachment: { role, deviceId, control, authenticated: control }, messages: [],
      deserializeAttachment() { return this.attachment; },
      serializeAttachment(value) { this.attachment = value; },
      send(value) { this.messages.push(JSON.parse(value)); }
    };
    sockets.push(socket);
    return socket;
  };
  const audience = addSocket('device-one');
  const control = addSocket('presenter', 'control', true);
  const send = (socket, message) => room.webSocketMessage(socket, JSON.stringify(message));
  return { room, storage, context, audience, control, addSocket, send };
}

function latest(socket, type) {
  return socket.messages.filter(message => message.type === type).at(-1);
}

function studyFixture() {
  return {
    format: 'dicom-slide-study/1', studyId: 'uploaded-study', title: 'Uploaded CT', modality: 'CT',
    studyInstanceUID: 'private-study-uid', patientName: 'Private Patient', baseUrl: 'dicom-local://old/', seriesCount: 99,
    series: [{ id: 'series-one', caseId: 'uploaded-study--series-one', number: '1', title: 'Axial CT', modality: 'CT', slices: 1, rows: 2, columns: 2, sortMode: 'spatial', manifest: 'https://private.example/manifest.js', patientName: 'Private Patient' }],
    source: { importedLocally: true, dicomFileCount: 1, fileName: 'private-patient.zip', patientId: 'private-id', institutionName: 'Private Hospital' }
  };
}

function manifestFixture() {
  return {
    format: 'dicom-slide-volume/1', caseId: 'uploaded-study--series-one', title: 'Axial CT', modality: 'CT',
    dimensions: { columns: 2, rows: 2, slices: 1 }, spacing: { column: 1, row: 1, slice: 1 },
    orientationLPS: [1, 0, 0, 0, 1, 0], sliceCoordinates: [0], sortMode: 'spatial', pixelType: 'int16-le',
    samplesPerPixel: 1, units: 'HU', invert: false, valueRange: { minimum: 0, maximum: 100 },
    initialSlice: 0, defaultWindow: { center: 50, width: 100 }, presets: { soft: { label: 'Soft tissue', center: 50, width: 100 } },
    chunks: [{ index: 0, firstSlice: 0, sliceCount: 1, compressedBytes: 4, uncompressedBytes: 8, script: 'https://private.example/chunk.js', patientName: 'Private Patient' }],
    source: { patientName: 'Private Patient', studyInstanceUID: 'private-study-uid' }, patientId: 'private-id', baseUrl: 'dicom-local://old/'
  };
}

function examRequest(path, method = 'GET', value, authenticated = true) {
  const headers = {};
  if (authenticated && method !== 'GET') headers[AUTH_HEADER] = '1';
  return new Request(`https://presentation.test/api/exams/${path}`, {
    method, headers, ...(value === undefined ? {} : { body: typeof value === 'string' ? value : JSON.stringify(value) })
  });
}

async function upload(h, uploadId = UPLOAD, exam = EXAM) {
  const study = studyFixture();
  const manifest = manifestFixture();
  for (const [path, value] of [['study', study], [`manifest/${manifest.caseId}`, manifest], [`chunk/${manifest.caseId}/0`, PAYLOAD]]) {
    const response = await h.room.fetch(examRequest(`${exam}/${uploadId}/${path}`, 'PUT', value));
    assert.equal(response.status, 200, await response.text());
  }
  return { study, manifest };
}

async function commit(h, uploadId = UPLOAD, exam = EXAM) {
  return h.room.fetch(examRequest(`${exam}/${uploadId}/commit`, 'POST'));
}

function evaluateScript(source, src, window = {}) {
  new Function('window', 'document', source)(window, { currentScript: { src } });
  return window;
}

test('normalizeSlide accepts configured IDs and rejects unknown and legacy activities', () => {
  assert.equal(normalizeSlide('poll-live'), 'poll-live');
  assert.equal(normalizeSlide('poll:region'), null);
  assert.equal(normalizeSlide('unknown'), null);
  assert.equal(normalizeSlide(0), null);
  assert.equal(normalizeSlide('custom', { slides: [{ id: 'custom' }] }), 'custom');
});

test('summarizePoll counts only valid single-choice votes by voter', () => {
  assert.deepEqual(summarizePoll({ type: 'single', options: [{ id: 'a' }, { id: 'b' }] }, {
    open: true, byVoter: { one: 'a', two: 'a', three: 'b', invalid: 'c', inherited: 'constructor' }
  }), { open: true, responses: 3, counts: { a: 2, b: 1 }, average: 0 });
});

test('summarizePoll reports responses and average choices for multiple-choice polls', () => {
  assert.deepEqual(summarizePoll({ type: 'multiple', options: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, {
    open: false, byVoter: { one: { a: true, b: true }, two: { b: true }, empty: {}, invalid: { other: true } }
  }), { open: false, responses: 2, counts: { a: 1, b: 2, c: 0 }, average: 1.5 });
});

function scoredState() {
  return {
    participants: { 'p-zoe': { name: 'Zoe' }, 'p-bob': { name: 'Bob' }, 'p-amy': { name: 'Amy' }, 'p-idle': { name: 'Idle' } },
    devices: { anonymous: 'missing-participant' },
    polls: {
      region: { byVoter: { 'p-idle': 'north' } },
      'exam-1': { byVoter: { 'p-zoe': 'neoplasia', 'p-bob': 'neoplasia', 'p-amy': 'neoplasia', anonymous: 'neoplasia' } },
      'exam-2': { byVoter: { 'p-zoe': 'neoplasia', 'p-bob': 'neoplasia', 'p-amy': 'trauma', anonymous: 'neoplasia' } }
    }
  };
}

test('computeScores includes registered participants only and is capped by the scored polls', () => {
  const state = scoredState();
  assert.deepEqual(computeScores(state, CONFIG), { 'p-zoe': 2, 'p-bob': 2, 'p-amy': 1, 'p-idle': 0 });
  assert.ok(Object.values(computeScores(state, CONFIG)).every(score => score <= 2));
  assert.equal(Object.hasOwn(computeScores(state, CONFIG), 'anonymous'), false);
  assert.deepEqual(computeScores({ ...state, participants: {} }, CONFIG), {});
  assert.deepEqual(computeScores(state, { polls: {} }), { 'p-zoe': 0, 'p-bob': 0, 'p-amy': 0, 'p-idle': 0 });
});

test('ranking sorts by score then name and shares competition ranks for tied scores', () => {
  assert.deepEqual(ranking(scoredState(), CONFIG), [
    { rank: 1, name: 'Bob', score: 2 }, { rank: 1, name: 'Zoe', score: 2 },
    { rank: 3, name: 'Amy', score: 1 }, { rank: 4, name: 'Idle', score: 0 }
  ]);
  assert.deepEqual(ranking({ participants: {}, polls: scoredState().polls }, CONFIG), []);
});

test('sanitizeStudy strips PHI and source metadata while preserving presentation and geometry fields', () => {
  const study = studyFixture();
  study.title = '  Uploaded\u0000 CT  ';
  const before = structuredClone(study);
  const result = sanitizeStudy(study);
  assert.equal(result.title, 'Uploaded CT');
  assert.equal(result.modality, 'CT');
  assert.equal(result.studyId, study.studyId);
  assert.equal(result.seriesCount, 1);
  assert.deepEqual(result.source, { importedLocally: true, dicomFileCount: 1 });
  assert.equal(result.series[0].manifest, 'series/series-one/manifest.js');
  assert.equal(result.series[0].slices, 1);
  assert.doesNotMatch(JSON.stringify(result), /private|patient|studyInstanceUID|baseUrl/i);
  assert.deepEqual(study, before);
});

test('sanitizeManifest strips PHI, source and unknown fields and fixes chunk paths', () => {
  const manifest = manifestFixture();
  manifest.dimensions.patientId = 'private-id';
  manifest.presets.soft.label = ' Soft\n tissue ';
  const before = structuredClone(manifest);
  const result = sanitizeManifest(manifest);
  assert.deepEqual(Object.keys(result).sort(), [
    'format', 'caseId', 'title', 'modality', 'dimensions', 'spacing', 'orientationLPS', 'sliceCoordinates',
    'sortMode', 'pixelType', 'samplesPerPixel', 'units', 'invert', 'valueRange', 'initialSlice', 'defaultWindow', 'presets', 'chunks'
  ].sort());
  assert.deepEqual(result.dimensions, { columns: 2, rows: 2, slices: 1 });
  assert.equal(result.presets.soft.label, 'Soft tissue');
  assert.equal(result.chunks[0].script, 'chunks/chunk-000.js');
  assert.equal(result.chunks[0].uncompressedBytes, 8);
  assert.doesNotMatch(JSON.stringify(result), /private|patient|source|baseUrl/i);
  assert.deepEqual(manifest, before);
});

test('study wrappers register sanitized studies with a base URL from the current script', () => {
  const study = studyFixture();
  study.title = 'Quoted "title" </script>\u2028 next';
  const source = studyScript(study);
  const window = evaluateScript(source, `https://presentation.test/api/exams/${EXAM}/${UPLOAD}/study.js?cache=1`, { __DICOM_SLIDE_STUDIES__: { existing: true } });
  assert.equal(window.__DICOM_SLIDE_STUDIES__.existing, true);
  assert.deepEqual(window.__DICOM_SLIDE_STUDIES__[study.studyId], {
    ...sanitizeStudy(study), baseUrl: `https://presentation.test/api/exams/${EXAM}/${UPLOAD}/`
  });
  assert.doesNotMatch(source, /<\/script>/);
});

test('manifest wrappers use immediate registration or the pending global queue', () => {
  const manifest = manifestFixture();
  const src = `https://presentation.test/api/exams/${EXAM}/${UPLOAD}/series/series-one/manifest.js`;
  const expected = [manifest.caseId, { ...sanitizeManifest(manifest), baseUrl: new URL('.', src).href }];
  const pending = evaluateScript(manifestScript(manifest), src);
  assert.deepEqual(pending.__DICOM_SLIDE_PENDING_MANIFESTS__, [expected]);
  const registered = [];
  const window = evaluateScript(manifestScript(manifest), src, { DicomSlideData: { registerManifest: (...args) => registered.push(args) } });
  assert.deepEqual(registered, [expected]);
  assert.equal(window.__DICOM_SLIDE_PENDING_MANIFESTS__, undefined);
});

test('chunk wrappers register the exact raw base64 payload or queue it for the runtime', () => {
  const payload = 'AQID\nBA==';
  const src = 'https://presentation.test/series/series-one/chunks/chunk-012.js';
  const source = chunkScript('case-one', 12, payload);
  assert.deepEqual(evaluateScript(source, src).__DICOM_SLIDE_PENDING_CHUNKS__, [['case-one', 12, payload]]);
  const registered = [];
  evaluateScript(source, src, { DicomSlideData: { registerChunk: (...args) => registered.push(args) } });
  assert.deepEqual(registered, [['case-one', 12, payload]]);
});

test('Room starts with version two state and separates public and control payloads', async () => {
  const h = harness();
  const state = await h.room.getState();
  assert.equal(state.version, 2);
  assert.equal(state.slide, 'cover');
  assert.equal(state.sequence, 1);
  assert.deepEqual(state.points, { enabled: false });
  assert.deepEqual(state.polls['exam-1'], { open: false, locked: false, byVoter: {} });
  assert.equal(state.boards['exam-2'].moderation, 'manual');
  const publicState = h.room.aggregate(state);
  assert.deepEqual(Object.keys(publicState).sort(), ['type', 'now', 'slide', 'audience', 'connected', 'points', 'polls', 'boards', 'exams', 'ranking', 'scoredPolls'].sort());
  assert.equal(publicState.connected, 1);
  assert.equal(publicState.scoredPolls, 2);
  assert.deepEqual(publicState.ranking, []);
  assert.deepEqual(publicState.exams[EXAM], { ...CONFIG.exams[EXAM], override: false });
  const controlState = h.room.aggregate(state, true);
  assert.deepEqual(controlState.questions, []);
  assert.equal(controlState.participants, 0);
  assert.deepEqual(controlState.examOverrides, {});
  assert.equal(h.context.autoResponse.request, 'ping');
  assert.equal(h.context.autoResponse.response, 'pong');
});

test('Room ignores invalid slides, legacy activities and unauthorized control messages', async () => {
  const h = harness();
  const state = await h.room.getState();
  const before = structuredClone(state);
  for (const message of [{ type: 'slide', slide: 'missing' }, { type: 'activity', activity: 'poll:region' }]) await h.send(h.control, message);
  await h.send(h.audience, { type: 'slide', slide: 'poll-live' });
  await h.send(h.audience, { type: 'set_points', enabled: true });
  await h.room.webSocketMessage(h.control, 'null');
  await h.room.webSocketMessage(h.control, '{invalid');
  assert.deepEqual(state, before);
  assert.equal(h.storage.writes.length, 0);
});

test('slide changes open polls and final results lock them until the control room reopens them', async () => {
  const h = harness();
  const state = await h.room.getState();
  await h.send(h.control, { type: 'slide', slide: 'poll-secret' });
  assert.equal(state.polls.age.open, true);
  await h.send(h.audience, { type: 'vote', poll: 'age', option: '25-34' });
  await h.send(h.control, { type: 'slide', slide: 'poll-results' });
  assert.equal(state.polls.age.open, false);
  assert.equal(state.polls.age.locked, true);
  assert.equal(latest(h.audience, 'state').audience.poll, null);
  await h.send(h.audience, { type: 'vote', poll: 'age', option: '35-44' });
  assert.equal(state.polls.age.byVoter['device-one'], '25-34');
  await h.send(h.control, { type: 'slide', slide: 'poll-secret' });
  assert.equal(state.polls.age.open, false);
  await h.send(h.control, { type: 'set_poll', poll: 'age', open: true });
  assert.equal(state.polls.age.locked, false);
  await h.send(h.audience, { type: 'vote', poll: 'age', option: '35-44' });
  assert.equal(latest(h.audience, 'mine').polls.age, '35-44');
  await h.send(h.control, { type: 'set_poll', poll: 'age', open: false });
  await h.send(h.control, { type: 'slide', slide: 'poll-secret' });
  assert.equal(state.polls.age.open, false);
  assert.equal(state.polls.age.locked, true);
});

test('advancing the stage keeps the first exam and its open vote available on phones', async () => {
  const h = harness();
  await h.send(h.control, { type: 'slide', slide: 'exam-1' });
  await h.send(h.control, { type: 'slide', slide: 'exam-1-continued' });
  assert.deepEqual(latest(h.audience, 'state').audience, { poll: 'exam-1', board: null, exam: EXAM, questions: false, contact: false });
  await h.send(h.audience, { type: 'vote', poll: 'exam-1', option: 'neoplasia' });
  assert.equal(latest(h.audience, 'mine').polls['exam-1'], 'neoplasia');
  assert.equal(latest(h.audience, 'mine').score, null);
  await h.send(h.control, { type: 'slide', slide: 'pause' });
  assert.equal((await h.room.getState()).polls['exam-1'].open, true);
});

test('registration hashes normalized email, migrates votes and synchronizes all devices of the participant', async () => {
  const h = harness();
  const second = h.addSocket('device-two');
  const outsider = h.addSocket('device-three');
  for (const poll of ['exam-1', 'exam-2']) await h.send(h.control, { type: 'set_poll', poll, open: true });
  await h.send(h.audience, { type: 'vote', poll: 'exam-1', option: 'neoplasia' });
  await h.send(second, { type: 'vote', poll: 'exam-1', option: 'trauma' });
  await h.send(second, { type: 'vote', poll: 'exam-2', option: 'neoplasia' });
  await h.send(h.audience, { type: 'register', name: ' Alice\u0000 Example ', email: ' ALICE@EXAMPLE.COM ' });
  const state = await h.room.getState();
  const id = `p-${createHash('sha256').update('alice@example.com').digest('hex').slice(0, 16)}`;
  assert.deepEqual(Object.keys(state.participants), [id]);
  assert.equal(state.devices['device-one'], id);
  assert.equal(state.participants[id].name, 'Alice Example');
  assert.equal(state.participants[id].email, 'alice@example.com');
  assert.equal(state.polls['exam-1'].byVoter[id], 'neoplasia');
  assert.equal(Object.hasOwn(state.polls['exam-1'].byVoter, 'device-one'), false);
  const createdAt = state.participants[id].createdAt;
  await h.send(second, { type: 'register', name: 'Alice Updated', email: 'alice@example.com' });
  assert.equal(state.participants[id].createdAt, createdAt);
  assert.equal(state.polls['exam-1'].byVoter[id], 'neoplasia');
  assert.equal(Object.hasOwn(state.polls['exam-1'].byVoter, 'device-two'), false);
  assert.equal(state.polls['exam-2'].byVoter[id], 'neoplasia');
  assert.deepEqual(latest(h.audience, 'mine').participant, { name: 'Alice Updated', email: 'alice@example.com' });
  assert.equal(latest(h.audience, 'mine').score, 2);
  const outsiderUpdates = outsider.messages.filter(message => message.type === 'mine').length;
  await h.send(second, { type: 'vote', poll: 'exam-2', option: 'trauma' });
  assert.equal(latest(h.audience, 'mine').score, 1);
  assert.equal(latest(h.audience, 'mine').polls['exam-2'], 'trauma');
  assert.equal(outsider.messages.filter(message => message.type === 'mine').length, outsiderUpdates);
  assert.equal(latest(h.control, 'state').participants, 1);
  assert.equal(JSON.stringify(latest(outsider, 'state')).includes('alice@example.com'), false);
});

test('registration rejects invalid names and emails without creating participants', async () => {
  const h = harness();
  for (const input of [
    { name: '', email: 'a@example.com' }, { name: 'A'.repeat(61), email: 'a@example.com' },
    { name: 'Alice', email: 'invalid' }, { name: 'Alice', email: 'a @example.com' },
    { name: 'Alice', email: `${'a'.repeat(110)}@example.com` }
  ]) {
    await h.send(h.audience, { type: 'register', ...input });
    assert.equal(h.audience.messages.at(-1).type, 'error');
  }
  assert.deepEqual((await h.room.getState()).participants, {});
  assert.equal(h.storage.writes.length, 0);
});

test('anonymous devices cannot impersonate a participant by supplying a participant ID', async () => {
  const h = harness();
  await h.send(h.audience, { type: 'register', name: 'Alice', email: 'alice@example.com' });
  const state = await h.room.getState();
  const id = state.devices['device-one'];
  const anonymous = h.addSocket('anonymous-client', 'unknown');
  await h.send(anonymous, { type: 'hello', role: 'audience', deviceId: id });
  assert.equal(latest(anonymous, 'mine').participant, null);
  assert.equal(latest(anonymous, 'mine').score, null);
  await h.send(h.control, { type: 'set_poll', poll: 'exam-1', open: true });
  await h.send(anonymous, { type: 'vote', poll: 'exam-1', option: 'neoplasia' });
  assert.equal(computeScores(state)[id], 0);
  assert.equal(h.room.mine(state, id).participant, null);
});

test('public ranking is optional, contains at most twenty registered participants and never exposes emails', async () => {
  const h = harness();
  const state = await h.room.getState();
  for (let index = 0; index < 25; index += 1) state.participants[`p-${index}`] = { name: `Person ${String(index).padStart(2, '0')}`, email: 'private@example.com' };
  state.polls['exam-1'].byVoter.anonymous = 'neoplasia';
  assert.deepEqual(h.room.aggregate(state).ranking, []);
  await h.send(h.control, { type: 'set_points', enabled: true });
  const publicState = latest(h.audience, 'state');
  assert.equal(publicState.ranking.length, 20);
  assert.equal(publicState.scoredPolls, 2);
  assert.ok(publicState.ranking.every(entry => entry.rank === 1 && entry.score === 0));
  assert.equal(JSON.stringify(publicState).includes('private@example.com'), false);
  assert.equal(h.room.mine(state, 'anonymous').participant, null);
  assert.equal(h.room.mine(state, 'anonymous').score, null);
});

test('boards publish automatically or require moderation and enforce the two-second voter interval', async t => {
  const h = harness();
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  await h.send(h.audience, { type: 'board_message', board: 'region', author: ' Alice\n Example ', text: ' Hello\u0000 room ' });
  const entry = (await h.room.getState()).boards.region.messages[0];
  assert.deepEqual(entry, { id: 1, voter: 'device-one', author: 'Alice Example', text: 'Hello room', createdAt: now, status: 'approved' });
  assert.deepEqual(latest(h.audience, 'message_received'), { type: 'message_received', id: 1 });
  assert.equal(latest(h.audience, 'state').boards.region.messages[0].status, undefined);
  assert.equal(latest(h.control, 'state').boards.region.messages[0].status, 'approved');
  now += 1999;
  await h.send(h.audience, { type: 'board_message', board: 'exam-2', author: 'Alice', text: 'Too soon' });
  assert.match(latest(h.audience, 'error').message, /2 seconds/);
  now += 1;
  await h.send(h.audience, { type: 'board_message', board: 'exam-2', author: 'Alice', text: 'Pending discussion' });
  assert.equal(latest(h.audience, 'message_received').id, 2);
  assert.deepEqual(latest(h.audience, 'state').boards['exam-2'].messages, []);
  assert.equal(latest(h.control, 'state').boards['exam-2'].messages[0].status, 'pending');
  await h.send(h.control, { type: 'moderate_message', board: 'exam-2', id: 2, action: 'approve' });
  assert.equal(latest(h.audience, 'state').boards['exam-2'].messages[0].text, 'Pending discussion');
  await h.send(h.control, { type: 'moderate_message', board: 'exam-2', id: 2, action: 'reject' });
  assert.deepEqual(latest(h.audience, 'state').boards['exam-2'].messages, []);
  await h.send(h.control, { type: 'moderate_message', board: 'exam-2', id: 2, action: 'delete' });
  assert.deepEqual(latest(h.control, 'state').boards['exam-2'].messages, []);
  await h.send(h.control, { type: 'set_board_mode', board: 'region', moderation: 'manual' });
  assert.equal((await h.room.getState()).boards.region.moderation, 'manual');
});

test('boards limit pending messages to five per voter per board and public feeds to the newest hundred', async t => {
  const h = harness();
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  for (let index = 0; index < 5; index += 1) {
    await h.send(h.audience, { type: 'board_message', board: 'exam-2', author: 'Alice', text: `Message ${index}` });
    now += 2000;
  }
  await h.send(h.audience, { type: 'board_message', board: 'exam-2', author: 'Alice', text: 'Sixth pending message' });
  assert.match(latest(h.audience, 'error').message, /5 pending/);
  const state = await h.room.getState();
  assert.equal(state.boards['exam-2'].messages.length, 5);
  const another = h.addSocket('another-device');
  await h.send(another, { type: 'board_message', board: 'exam-2', author: 'Bob', text: 'Separate voter' });
  assert.equal(state.boards['exam-2'].messages.length, 6);
  await h.send(h.audience, { type: 'board_message', board: 'region', author: 'Alice', text: 'Separate board' });
  assert.equal(state.boards.region.messages.length, 1);
  state.boards.region.messages = Array.from({ length: 105 }, (_, index) => ({ id: 200 - index, voter: 'private-device', author: 'Alice', text: `Entry ${index}`, createdAt: 200 - index, status: 'approved' }));
  const publicMessages = h.room.aggregate(state).boards.region.messages;
  assert.equal(publicMessages.length, 100);
  assert.equal(publicMessages[0].id, 200);
  assert.equal(publicMessages.at(-1).id, 101);
  assert.equal(publicMessages[0].voter, undefined);
  assert.equal(h.room.aggregate(state, true).boards.region.messages.length, 105);
});

test('board and question forms enforce text and author length limits', async () => {
  const h = harness();
  for (const message of [
    { type: 'board_message', board: 'region', author: '', text: 'Hello' },
    { type: 'board_message', board: 'region', author: 'A'.repeat(61), text: 'Hello' },
    { type: 'board_message', board: 'region', author: 'Alice', text: 'x'.repeat(401) },
    { type: 'question', author: 'A'.repeat(61), text: 'Question' },
    { type: 'question', text: 'x'.repeat(401) }, { type: 'question', text: ' \n ' }
  ]) {
    await h.send(h.audience, message);
    assert.equal(h.audience.messages.at(-1).type, 'error');
  }
  assert.equal(h.storage.writes.length, 0);
  await h.send(h.audience, { type: 'board_message', board: 'region', author: 'A'.repeat(60), text: 'x'.repeat(400) });
  assert.equal(latest(h.audience, 'message_received').id, 1);
});

test('questions support anonymous authors, stay private and enforce five unresolved questions per voter', async () => {
  const h = harness();
  await h.send(h.audience, { type: 'question', text: ' Anonymous\n question ' });
  assert.deepEqual(latest(h.audience, 'question_received'), { type: 'question_received', id: 1 });
  assert.equal(latest(h.control, 'state').questions[0].author, '');
  assert.equal(latest(h.audience, 'state').questions, undefined);
  for (let index = 0; index < 4; index += 1) await h.send(h.audience, { type: 'question', author: ' Alice ', text: `Question ${index}` });
  await h.send(h.audience, { type: 'question', text: 'Sixth question' });
  assert.match(latest(h.audience, 'error').message, /5 pending questions/);
  assert.equal((await h.room.getState()).questions.length, 5);
  await h.send(h.audience, { type: 'moderate_question', id: 1, action: 'resolve' });
  assert.equal((await h.room.getState()).questions.find(question => question.id === 1).resolved, false);
  await h.send(h.control, { type: 'moderate_question', id: 1, action: 'resolve' });
  await h.send(h.audience, { type: 'question', text: 'Now allowed' });
  assert.equal(latest(h.audience, 'question_received').id, 6);
  await h.send(h.control, { type: 'moderate_question', id: 1, action: 'reopen' });
  assert.equal(latest(h.control, 'state').questions.find(question => question.id === 1).resolved, false);
  await h.send(h.control, { type: 'moderate_question', id: 1, action: 'delete' });
  assert.equal((await h.room.getState()).questions.some(question => question.id === 1), false);
});

test('poll resets preserve session data and synchronize audience selections and scores', async () => {
  const h = harness();
  await h.send(h.audience, { type: 'register', name: 'Alice', email: 'alice@example.com' });
  for (const poll of ['exam-1', 'exam-2']) {
    await h.send(h.control, { type: 'set_poll', poll, open: true });
    await h.send(h.audience, { type: 'vote', poll, option: 'neoplasia' });
    await h.send(h.control, { type: 'set_poll', poll, open: false });
  }
  await h.send(h.audience, { type: 'question', text: 'Keep this question' });
  await h.send(h.control, { type: 'reset_poll', poll: 'exam-1' });
  const state = await h.room.getState();
  assert.deepEqual(state.polls['exam-1'], { open: false, locked: true, byVoter: {} });
  assert.equal(latest(h.audience, 'mine').polls['exam-1'], '');
  assert.equal(latest(h.audience, 'mine').score, 1);
  assert.deepEqual(latest(h.control, 'reset_complete'), { type: 'reset_complete', scope: 'poll', poll: 'exam-1' });
  await h.send(h.control, { type: 'reset_all_polls' });
  assert.ok(Object.values(state.polls).every(poll => Object.keys(poll.byVoter).length === 0));
  assert.equal(latest(h.audience, 'mine').score, 0);
  assert.equal(Object.keys(state.participants).length, 1);
  assert.equal(state.questions.length, 1);
  assert.deepEqual(latest(h.control, 'reset_complete'), { type: 'reset_complete', scope: 'polls' });
});

test('full reset preserves the current slide and deletes every uploaded payload in bounded batches', async () => {
  const h = harness();
  await h.send(h.control, { type: 'slide', slide: 'exam-1' });
  await h.send(h.control, { type: 'set_points', enabled: true });
  await h.send(h.audience, { type: 'register', name: 'Alice', email: 'alice@example.com' });
  await h.send(h.audience, { type: 'question', text: 'A question' });
  await h.send(h.audience, { type: 'board_message', board: 'region', author: 'Alice', text: 'A message' });
  for (let index = 0; index < 300; index += 1) h.storage.data.set(`exam:brain-mr:incomplete:chunk:case:${index}`, PAYLOAD);
  h.storage.data.set('unrelated', 'preserve');
  await h.send(h.control, { type: 'reset_session' });
  const state = await h.room.getState();
  assert.equal(state.slide, 'exam-1');
  assert.equal(state.sequence, 1);
  assert.deepEqual(state.points, { enabled: false });
  for (const key of ['participants', 'devices', 'examOverrides']) assert.deepEqual(state[key], {});
  assert.deepEqual(state.questions, []);
  assert.ok(Object.values(state.boards).every(board => board.messages.length === 0));
  assert.ok(Object.values(state.polls).every(poll => !poll.open && !poll.locked && !Object.keys(poll.byVoter).length));
  assert.equal([...h.storage.data.keys()].some(key => key.startsWith('exam:')), false);
  assert.equal(h.storage.data.get('unrelated'), 'preserve');
  assert.ok(h.storage.deletions.length > 1);
  assert.equal(latest(h.audience, 'mine').participant, null);
  assert.equal(latest(h.audience, 'mine').score, null);
  assert.deepEqual(latest(h.control, 'reset_complete'), { type: 'reset_complete', scope: 'session' });
});

test('Room hello preserves presenter-key and authenticated-session authorization', async () => {
  const h = harness();
  const keyed = h.addSocket('new-presenter', 'unknown');
  await h.send(keyed, { type: 'hello', role: 'presenter', key: SECRET, deviceId: 'new-presenter' });
  assert.equal(keyed.attachment.control, true);
  assert.equal(latest(keyed, 'hello').authorized, true);
  const unauthorized = h.addSocket('unauthorized', 'unknown');
  await h.send(unauthorized, { type: 'hello', role: 'control', key: 'wrong', deviceId: 'unauthorized' });
  assert.equal(unauthorized.attachment.control, false);
  assert.equal(latest(unauthorized, 'state').questions, undefined);
  await h.send(h.control, { type: 'hello', role: 'control', deviceId: 'presenter' });
  assert.equal(latest(h.control, 'hello').authorized, true);
  await h.send(h.audience, { type: 'hello', role: 'audience', deviceId: 'device-one' });
  assert.equal(latest(h.audience, 'mine').participant, null);
});

test('Room reloads version two state and resets incompatible stored versions', async () => {
  const h = harness();
  await h.send(h.control, { type: 'slide', slide: 'poll-live' });
  const reloaded = new Room(h.context, { PRESENTER_KEY: SECRET });
  assert.equal((await reloaded.getState()).slide, 'poll-live');
  assert.equal((await reloaded.getState()).polls.region.open, true);
  h.storage.data.set('state', { version: 1, activity: 'poll:warmup' });
  const migrated = new Room(h.context, { PRESENTER_KEY: SECRET });
  assert.equal((await migrated.getState()).version, 2);
  assert.equal((await migrated.getState()).slide, 'cover');
});

test('exam routes reject unauthenticated mutations and invalid upload identifiers', async () => {
  const h = harness();
  for (const method of ['PUT', 'POST', 'DELETE']) assert.equal((await h.room.fetch(examRequest(`${EXAM}/${UPLOAD}/study`, method, undefined, false))).status, 404);
  for (const path of [`missing/${UPLOAD}/study`, `${EXAM}/short/study`, `${EXAM}/UPPERCASE/study`, `${EXAM}/${'x'.repeat(65)}/study`, `${EXAM}/${UPLOAD}/chunk/case/-1`]) {
    assert.equal((await h.room.fetch(examRequest(path, 'PUT', studyFixture()))).status, 404);
  }
  assert.equal((await h.room.fetch(examRequest(`${EXAM}/${UPLOAD}/study`, 'PATCH'))).status, 405);
  assert.equal((await h.room.fetch(examRequest(`${EXAM}/${UPLOAD}/study`, 'PUT', '{invalid'))).status, 400);
  assert.equal((await h.room.fetch(examRequest(`${EXAM}/${UPLOAD}/study`, 'PUT', { ...studyFixture(), series: [] }))).status, 400);
  assert.equal((await h.room.fetch(examRequest(`${EXAM}/${UPLOAD}/manifest/wrong-case`, 'PUT', manifestFixture()))).status, 400);
  const invalidManifest = manifestFixture();
  invalidManifest.chunks[0].index = 1;
  assert.equal((await h.room.fetch(examRequest(`${EXAM}/${UPLOAD}/manifest/${invalidManifest.caseId}`, 'PUT', invalidManifest))).status, 400);
  assert.equal((await h.room.fetch(new Request('https://presentation.test/other'))).status, 426);
});

test('exam upload limits apply to actual request bytes, including bodies without Content-Length', async () => {
  const h = harness();
  const caseId = manifestFixture().caseId;
  for (const [path, limit] of [['study', 256 * 1024], [`manifest/${caseId}`, 2 * 1024 * 1024], [`chunk/${caseId}/0`, 1.5 * 1024 * 1024]]) {
    const request = examRequest(`${EXAM}/${UPLOAD}/${path}`, 'PUT', 'A'.repeat(limit + 1));
    assert.equal(request.headers.has('Content-Length'), false);
    assert.equal((await h.room.fetch(request)).status, 413);
  }
  const maximum = 'A'.repeat(1.5 * 1024 * 1024);
  assert.equal((await h.room.fetch(examRequest(`${EXAM}/${UPLOAD}/chunk/${caseId}/0`, 'PUT', maximum))).status, 200);
  assert.equal(h.storage.data.get(`${PREFIX}chunk:${caseId}:0`), maximum);
  const unicode = { ...studyFixture(), title: 'é'.repeat(140000) };
  assert.equal((await h.room.fetch(examRequest(`${EXAM}/${UPLOAD}/study`, 'PUT', unicode))).status, 413);
});

test('commit requires the study, every manifest and every declared raw chunk', async () => {
  const h = harness();
  assert.equal((await commit(h)).status, 400);
  const study = studyFixture();
  const manifest = manifestFixture();
  await h.room.fetch(examRequest(`${EXAM}/${UPLOAD}/study`, 'PUT', study));
  assert.equal((await commit(h)).status, 400);
  await h.room.fetch(examRequest(`${EXAM}/${UPLOAD}/manifest/${manifest.caseId}`, 'PUT', manifest));
  assert.equal((await commit(h)).status, 400);
  assert.equal((await h.room.fetch(examRequest(`${EXAM}/${UPLOAD}/study.js`))).status, 404);
  assert.deepEqual((await h.room.getState()).examOverrides, {});
  await h.room.fetch(examRequest(`${EXAM}/${UPLOAD}/chunk/${manifest.caseId}/0`, 'PUT', PAYLOAD));
  const response = await commit(h);
  assert.equal(response.status, 200);
  const expectedBytes = Buffer.byteLength(JSON.stringify(study)) + Buffer.byteLength(JSON.stringify(manifest)) + PAYLOAD.length;
  const state = await h.room.getState();
  assert.equal(state.examOverrides[EXAM].bytes, expectedBytes);
  assert.equal(state.examOverrides[EXAM].seriesCount, 1);
  assert.deepEqual(h.storage.data.get(`${PREFIX}meta`), { bytes: expectedBytes, chunks: { [manifest.caseId]: 1 }, createdAt: state.examOverrides[EXAM].createdAt });
  assert.equal(h.storage.data.get(`${PREFIX}study`), JSON.stringify(sanitizeStudy(study)));
  assert.equal(h.storage.data.get(`${PREFIX}manifest:${manifest.caseId}`), JSON.stringify(sanitizeManifest(manifest)));
  assert.equal(h.storage.data.get(`${PREFIX}chunk:${manifest.caseId}:0`), PAYLOAD);
  assert.deepEqual(await response.json(), { ok: true, exam: { title: study.title, studyId: study.studyId, src: `/api/exams/${EXAM}/${UPLOAD}/study.js`, override: true } });
  assert.equal(latest(h.audience, 'state').exams[EXAM].override, true);
  assert.equal(latest(h.audience, 'state').examOverrides, undefined);
  assert.equal(latest(h.control, 'state').examOverrides[EXAM].uploadId, UPLOAD);
});

test('exam serving generates executable study, manifest and chunk wrappers with immutable cache headers', async t => {
  const h = harness();
  const originalParse = JSON.parse;
  t.mock.method(JSON, 'parse', function (value, ...args) {
    assert.notEqual(value, PAYLOAD, 'Raw chunk text must never be parsed as JSON');
    return originalParse(value, ...args);
  });
  const { study, manifest } = await upload(h);
  assert.equal((await commit(h)).status, 200);
  const base = `https://presentation.test/api/exams/${EXAM}/${UPLOAD}/`;
  const window = {};
  for (const path of ['study.js', 'series/series-one/manifest.js', 'series/series-one/chunks/chunk-000.js']) {
    const response = await h.room.fetch(new Request(new URL(path, base)));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'text/javascript; charset=utf-8');
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
    evaluateScript(await response.text(), new URL(path, base).href, window);
  }
  const registeredStudy = window.__DICOM_SLIDE_STUDIES__[study.studyId];
  assert.equal(registeredStudy.baseUrl, base);
  assert.equal(registeredStudy.series[0].manifest, 'series/series-one/manifest.js');
  assert.equal(window.__DICOM_SLIDE_PENDING_MANIFESTS__[0][0], manifest.caseId);
  assert.equal(window.__DICOM_SLIDE_PENDING_MANIFESTS__[0][1].baseUrl, `${base}series/series-one/`);
  assert.deepEqual(window.__DICOM_SLIDE_PENDING_CHUNKS__, [[manifest.caseId, 0, PAYLOAD]]);
  for (const path of ['series/missing/manifest.js', 'series/series-one/chunks/chunk-001.js', 'invalid.js']) {
    assert.equal((await h.room.fetch(new Request(new URL(path, base)))).status, 404);
  }
  assert.equal((await h.room.fetch(examRequest(`${EXAM}/${UPLOAD}/study`, 'PUT', study))).status, 409);
  assert.equal((await commit(h)).status, 200);
});

test('commit enforces the one-gigabyte total using actual chunk sizes instead of client metadata', async t => {
  const h = harness();
  const study = studyFixture();
  const manifest = manifestFixture();
  manifest.chunks = Array.from({ length: 683 }, (_, index) => ({ index, firstSlice: index, sliceCount: 1, compressedBytes: 0, uncompressedBytes: 0 }));
  await h.room.fetch(examRequest(`${EXAM}/${UPLOAD}/study`, 'PUT', study));
  await h.room.fetch(examRequest(`${EXAM}/${UPLOAD}/manifest/${manifest.caseId}`, 'PUT', manifest));
  const payload = 'A'.repeat(1.5 * 1024 * 1024);
  const originalGet = h.storage.get.bind(h.storage);
  t.mock.method(h.storage, 'get', async key => key.startsWith(`${PREFIX}chunk:`) ? payload : originalGet(key));
  assert.equal((await commit(h)).status, 413);
  assert.deepEqual((await h.room.getState()).examOverrides, {});
  assert.equal(h.storage.data.has(`${PREFIX}meta`), false);
});

test('replacing and removing an exam deletes only that override and broadcasts the library fallback', async () => {
  const h = harness();
  await upload(h);
  await commit(h);
  h.storage.data.set('exam:brain-mr:unrelated:study', 'keep');
  const replacement = 'upload-0002';
  await upload(h, replacement);
  await commit(h, replacement);
  assert.equal([...h.storage.data.keys()].some(key => key.startsWith(PREFIX)), false);
  assert.equal(h.storage.data.get('exam:brain-mr:unrelated:study'), 'keep');
  assert.equal((await h.room.getState()).examOverrides[EXAM].uploadId, replacement);
  const deleted = await h.room.fetch(examRequest(EXAM, 'DELETE'));
  assert.equal(deleted.status, 200);
  assert.deepEqual((await deleted.json()).exam, { ...CONFIG.exams[EXAM], override: false });
  assert.equal(latest(h.audience, 'state').exams[EXAM].override, false);
  assert.equal([...h.storage.data.keys()].some(key => key.startsWith(`exam:${EXAM}:`)), false);
  await upload(h, 'upload-0003');
  await commit(h, 'upload-0003');
  await h.send(h.control, { type: 'remove_exam_override', exam: EXAM });
  assert.equal((await h.room.getState()).examOverrides[EXAM], undefined);
  assert.equal(latest(h.audience, 'state').exams[EXAM].override, false);
});

function workerHarness(t) {
  const h = harness();
  const forwarded = [];
  const waits = [];
  const cacheEntries = new Map();
  const cacheWrites = [];
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: {
    async match(request) { return cacheEntries.get(request.url)?.clone(); },
    async put(request, response) { cacheWrites.push(request.url); cacheEntries.set(request.url, response.clone()); }
  } };
  t.after(() => { if (previousCaches === undefined) delete globalThis.caches; else globalThis.caches = previousCaches; });
  const env = {
    PRESENTER_KEY: SECRET,
    ASSETS: { fetch: async request => new Response(`Asset: ${new URL(request.url).pathname}`, { headers: { 'Cache-Control': 'public, max-age=60' } }) },
    ROOM: {
      idFromName: name => name,
      get: roomName => ({ fetch: request => {
        forwarded.push({ roomName, request });
        return new URL(request.url).pathname === '/ws' ? new Response('Socket forwarded') : h.room.fetch(request);
      } })
    }
  };
  const ctx = { waitUntil: promise => waits.push(promise) };
  return { ...h, forwarded, waits, cacheWrites, fetch: request => worker.fetch(request, env, ctx) };
}

async function presenterCookie(h, origin = 'https://presentation.test') {
  const response = await h.fetch(new Request(`${origin}/?k=${SECRET}`));
  assert.equal(response.status, 303);
  return response.headers.get('Set-Cookie');
}

test('audience config exposes only the public contract and removes every correct answer', async t => {
  const h = workerHarness(t);
  const response = await h.fetch(new Request('https://presentation.test/audience.config.js'));
  assert.equal(response.status, 200);
  const source = await response.text();
  const config = new Function(source.replace('export const CONFIG =', 'return'))();
  assert.deepEqual(Object.keys(config).sort(), ['title', 'brand', 'presenter', 'citation', 'polls', 'boards', 'exams'].sort());
  assert.deepEqual(config.presenter, CONFIG.presenter);
  assert.deepEqual(config.exams, CONFIG.exams);
  for (const [key, poll] of Object.entries(config.polls)) {
    assert.equal(Object.hasOwn(poll, 'correct'), false);
    assert.deepEqual(poll.options, CONFIG.polls[key].options);
  }
  assert.equal(CONFIG.polls['exam-1'].correct, 'neoplasia');
});

test('Worker keeps assets public and preserves presenter sessions, redirects and private cache behavior', async t => {
  const h = workerHarness(t);
  for (const path of ['/participar', '/participar/', '/assets/slides.js', '/dicom-slide/runtime/dicom-slide.js']) {
    assert.equal((await h.fetch(new Request(`https://presentation.test${path}`))).status, 200);
  }
  assert.equal((await h.fetch(new Request('https://presentation.test/'))).status, 404);
  assert.equal((await h.fetch(new Request('https://presentation.test/?k=wrong'))).status, 404);
  const login = await h.fetch(new Request(`https://presentation.test/regie/?k=${SECRET}&other=value`));
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('Location'), '/regie/?other=value');
  const cookie = login.headers.get('Set-Cookie');
  assert.match(cookie, /^__Host-presentation_presenter=/);
  assert.match(cookie, /Max-Age=43200; HttpOnly; Secure; SameSite=Strict; Path=\//);
  const response = await h.fetch(new Request('https://presentation.test/regie/', { headers: { Cookie: cookie } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const tampered = cookie.replace(/(v1\.\d+\.)[^;]/, '$1!');
  assert.equal((await h.fetch(new Request('https://presentation.test/', { headers: { Cookie: tampered } }))).status, 404);
  const localCookie = await presenterCookie(h, 'http://localhost');
  assert.match(localCookie, /^presentation_presenter=/);
  assert.doesNotMatch(localCookie, /; Secure/);
  assert.equal((await h.fetch(new Request('http://localhost/', { headers: { Cookie: localCookie } }))).status, 200);
});

test('Worker validates presenter sessions before forwarding exam mutations and clears spoofed authorization', async t => {
  const h = workerHarness(t);
  const path = `${EXAM}/${UPLOAD}/study`;
  assert.equal((await h.fetch(examRequest(path, 'PUT', studyFixture()))).status, 404);
  assert.equal(h.forwarded.length, 0);
  const cookie = await presenterCookie(h);
  const request = examRequest(path, 'PUT', studyFixture(), false);
  request.headers.set('Cookie', cookie);
  assert.equal((await h.fetch(request)).status, 200);
  assert.equal(h.forwarded.at(-1).roomName, 'main');
  assert.equal(h.forwarded.at(-1).request.headers.get(AUTH_HEADER), '1');
  await h.fetch(new Request('https://presentation.test/ws?room=custom', { headers: { [AUTH_HEADER]: '1' } }));
  assert.equal(h.forwarded.at(-1).roomName, 'custom');
  assert.equal(h.forwarded.at(-1).request.headers.get(AUTH_HEADER), null);
  await h.fetch(new Request('https://presentation.test/ws', { headers: { Cookie: cookie } }));
  assert.equal(h.forwarded.at(-1).request.headers.get(AUTH_HEADER), '1');
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 12 * 60 * 60 * 1000 + 1000);
  const expired = examRequest(`${EXAM}/${UPLOAD}/commit`, 'POST');
  expired.headers.set('Cookie', cookie);
  assert.equal((await h.fetch(expired)).status, 404);
});

test('Worker caches successful public exam scripts and forwards misses to the main room', async t => {
  const h = workerHarness(t);
  await upload(h);
  await commit(h);
  const request = examRequest(`${EXAM}/${UPLOAD}/study.js`);
  request.headers.set(AUTH_HEADER, '1');
  const first = await h.fetch(request);
  assert.equal(first.status, 200);
  assert.equal(h.forwarded.at(-1).roomName, 'main');
  assert.equal(h.forwarded.at(-1).request.headers.get(AUTH_HEADER), null);
  assert.equal(h.waits.length, 1);
  await Promise.all(h.waits);
  const second = await h.fetch(examRequest(`${EXAM}/${UPLOAD}/study.js`));
  assert.equal(await second.text(), await first.text());
  assert.equal(h.forwarded.length, 1);
  assert.deepEqual(h.cacheWrites, [request.url]);
  assert.equal((await h.fetch(examRequest(`${EXAM}/missing-upload/study.js`))).status, 404);
  assert.equal(h.cacheWrites.length, 1);
});
