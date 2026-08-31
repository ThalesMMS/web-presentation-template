import { CONFIG } from '../public/presentation.config.js';

const STATE_VERSION = 1;
const POLL_KEYS = Object.keys(CONFIG.polls || {});
const QUESTION_LIMIT = 5;
const QUESTION_LENGTH = 400;
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
const PUBLIC_PREFIXES = ['/assets/'];

const AUDIENCE_CONFIG = Object.freeze({
  title: CONFIG.title,
  brand: CONFIG.brand,
  polls: CONFIG.polls || {}
});
const AUDIENCE_CONFIG_SOURCE = `export const CONFIG = ${JSON.stringify(AUDIENCE_CONFIG)
  .replaceAll('<', '\\u003c')
  .replaceAll('\u2028', '\\u2028')
  .replaceAll('\u2029', '\\u2029')};\n`;

function isPublicPath(pathname) {
  return PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

function notFound() {
  return new Response('Não encontrado', {
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
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('base64url inválido');
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

function configuredActivities(config) {
  return [
    'opening',
    'stage',
    'closing',
    ...Object.keys(config.polls || {}).map(key => `poll:${key}`)
  ];
}

const ACTIVITIES = configuredActivities(CONFIG);

export function normalizeActivity(value, config = CONFIG) {
  const activities = config === CONFIG ? ACTIVITIES : configuredActivities(config);
  return activities.includes(value) ? value : 'stage';
}

function initialState() {
  return {
    version: STATE_VERSION,
    activity: 'opening',
    sequence: 1,
    polls: Object.fromEntries(POLL_KEYS.map(key => [key, { open: false, byDevice: {} }])),
    questions: []
  };
}

function normalizeStoredState(stored) {
  if (!stored || stored.version !== STATE_VERSION) return initialState();
  const state = {
    ...stored,
    activity: normalizeActivity(stored.activity),
    polls: { ...(stored.polls || {}) },
    questions: Array.isArray(stored.questions) ? stored.questions : []
  };
  for (const key of POLL_KEYS) {
    if (!state.polls[key] || typeof state.polls[key].byDevice !== 'object') {
      state.polls[key] = { open: false, byDevice: {} };
    }
  }
  for (const key of Object.keys(state.polls)) {
    if (!POLL_KEYS.includes(key)) delete state.polls[key];
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

export function summarizePoll(config, poll) {
  const optionIds = config.options.map(option => option.id);
  const counts = Object.fromEntries(optionIds.map(id => [id, 0]));
  let responses = 0;
  let choices = 0;
  if (config.type === 'single') {
    for (const value of Object.values(poll.byDevice || {})) {
      if (counts[value] === undefined) continue;
      counts[value] += 1;
      responses += 1;
    }
  } else {
    for (const selected of Object.values(poll.byDevice || {})) {
      let selectedCount = 0;
      for (const id of optionIds) {
        if (!selected?.[id]) continue;
        counts[id] += 1;
        selectedCount += 1;
      }
      if (selectedCount) {
        responses += 1;
        choices += selectedCount;
      }
    }
  }
  return {
    open: Boolean(poll.open),
    responses,
    counts,
    average: responses ? choices / responses : 0
  };
}

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('WebSocket esperado', { status: 426 });
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
      this.cachedState = normalizeStoredState(await this.state.storage.get('state'));
    }
    return this.cachedState;
  }

  async save() {
    await this.state.storage.put('state', this.cachedState);
  }

  aggregate(state, includeQuestions = false) {
    const polls = {};
    for (const key of POLL_KEYS) polls[key] = summarizePoll(CONFIG.polls[key], state.polls[key]);
    let connected = 0;
    for (const socket of this.state.getWebSockets()) {
      try {
        if ((socket.deserializeAttachment() || {}).role === 'audience') connected += 1;
      } catch { /* conexão encerrada durante a contagem */ }
    }
    const result = {
      type: 'state',
      now: Date.now(),
      activity: state.activity,
      connected,
      polls
    };
    if (includeQuestions) {
      result.questions = state.questions.map(question => ({
        id: question.id,
        text: question.text,
        createdAt: question.createdAt,
        resolved: Boolean(question.resolved)
      }));
    }
    return result;
  }

  mine(state, deviceId) {
    const polls = {};
    for (const key of POLL_KEYS) {
      polls[key] = state.polls[key].byDevice[deviceId]
        || (CONFIG.polls[key].type === 'single' ? '' : {});
    }
    return { type: 'mine', polls };
  }

  broadcast(state) {
    const publicState = JSON.stringify(this.aggregate(state, false));
    const controlState = JSON.stringify(this.aggregate(state, true));
    for (const socket of this.state.getWebSockets()) {
      try {
        const attachment = socket.deserializeAttachment() || {};
        socket.send(attachment.control ? controlState : publicState);
      } catch { /* conexão encerrada durante o envio */ }
    }
  }

  broadcastMine(state) {
    for (const socket of this.state.getWebSockets()) {
      try {
        const attachment = socket.deserializeAttachment() || {};
        if (attachment.role === 'audience') {
          socket.send(JSON.stringify(this.mine(state, attachment.deviceId || 'anonymous')));
        }
      } catch { /* conexão encerrada durante o envio */ }
    }
  }

  async webSocketMessage(socket, rawMessage) {
    let message;
    try { message = JSON.parse(rawMessage); } catch { return; }
    const state = await this.getState();
    const attachment = socket.deserializeAttachment() || {};

    if (message.type === 'hello') {
      const role = ['audience', 'presenter', 'control'].includes(message.role) ? message.role : 'audience';
      const authorized = attachment.authenticated === true
        || await secretsMatch(String(message.key || ''), this.env.PRESENTER_KEY);
      const deviceId = cleanText(message.deviceId, 64) || 'anonymous';
      const control = authorized && role !== 'audience';
      socket.serializeAttachment({
        authenticated: attachment.authenticated === true,
        role,
        deviceId,
        control
      });
      socket.send(JSON.stringify({ type: 'hello', role, authorized }));
      if (role === 'audience') socket.send(JSON.stringify(this.mine(state, deviceId)));
      socket.send(JSON.stringify(this.aggregate(state, control)));
      this.broadcast(state);
      return;
    }

    const role = attachment.role || 'unknown';
    const deviceId = attachment.deviceId || 'anonymous';
    let resetComplete;
    let syncPersonalState = false;

    if (role === 'audience' && message.type === 'vote') {
      const config = CONFIG.polls[message.poll];
      const poll = state.polls[message.poll];
      if (!config || !poll?.open) return;
      const optionIds = config.options.map(option => option.id);
      if (!optionIds.includes(message.option)) return;
      if (config.type === 'single') {
        poll.byDevice[deviceId] = message.option;
      } else {
        const selected = { ...(poll.byDevice[deviceId] || {}) };
        if (config.exclusive && message.option === config.exclusive && message.value) {
          for (const id of optionIds) selected[id] = false;
        } else if (config.exclusive && message.value) {
          selected[config.exclusive] = false;
        }
        selected[message.option] = Boolean(message.value);
        poll.byDevice[deviceId] = selected;
      }
      socket.send(JSON.stringify(this.mine(state, deviceId)));
    } else if (role === 'audience' && message.type === 'question') {
      const text = cleanText(message.text, QUESTION_LENGTH);
      if (!text) return;
      const pending = state.questions.filter(question => question.deviceId === deviceId && !question.resolved).length;
      if (pending >= QUESTION_LIMIT) {
        socket.send(JSON.stringify({ type: 'error', message: `Você pode manter até ${QUESTION_LIMIT} perguntas pendentes.` }));
        return;
      }
      const question = {
        id: state.sequence++,
        deviceId,
        text,
        createdAt: Date.now(),
        resolved: false
      };
      state.questions.unshift(question);
      socket.send(JSON.stringify({ type: 'question_received', id: question.id }));
    } else if (attachment.control) {
      if (message.type === 'activity') {
        state.activity = normalizeActivity(message.activity);
        const [kind, key] = state.activity.split(':');
        if (kind === 'poll' && state.polls[key]) state.polls[key].open = true;
      } else if (message.type === 'set_poll') {
        if (!state.polls[message.poll]) return;
        state.polls[message.poll].open = Boolean(message.open);
      } else if (message.type === 'reset_poll') {
        if (!state.polls[message.poll]) return;
        state.polls[message.poll].byDevice = {};
        syncPersonalState = true;
        resetComplete = { type: 'reset_complete', scope: 'poll', poll: message.poll };
      } else if (message.type === 'moderate_question') {
        const question = state.questions.find(item => item.id === message.id);
        if (!question) return;
        if (message.action === 'resolve') question.resolved = true;
        else if (message.action === 'reopen') question.resolved = false;
        else if (message.action === 'delete') {
          state.questions = state.questions.filter(item => item.id !== message.id);
        } else return;
      } else if (message.type === 'reset_session') {
        const nextState = initialState();
        nextState.activity = state.activity;
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, nextState);
        syncPersonalState = true;
        resetComplete = { type: 'reset_complete', scope: 'session' };
      } else return;
    } else return;

    await this.save();
    this.broadcast(state);
    if (syncPersonalState) this.broadcastMine(state);
    if (resetComplete) socket.send(JSON.stringify(resetComplete));
  }

  async webSocketClose() {
    this.broadcast(await this.getState());
  }

  async webSocketError() {
    this.broadcast(await this.getState());
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const roomName = (url.searchParams.get('room') || 'main').slice(0, 32);
      const headers = new Headers(request.headers);
      headers.delete(PRESENTER_AUTH_HEADER);
      if (await hasValidSession(request, env.PRESENTER_KEY)) headers.set(PRESENTER_AUTH_HEADER, '1');
      const socketRequest = new Request(request, { headers });
      return env.ROOM.get(env.ROOM.idFromName(roomName)).fetch(socketRequest);
    }

    if (url.pathname === '/audience.config.js') {
      return new Response(AUDIENCE_CONFIG_SOURCE, {
        headers: {
          'Cache-Control': 'public, max-age=60',
          'Content-Type': 'text/javascript; charset=utf-8'
        }
      });
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
