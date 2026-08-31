/* Cliente compartilhado de WebSocket e utilitário de QR code. */
(function () {
  'use strict';

  const deviceId = (() => {
    try {
      let value = localStorage.getItem('presentation_device');
      if (!value) {
        value = `device-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
        localStorage.setItem('presentation_device', value);
      }
      return value.slice(0, 64);
    } catch {
      return `device-${Math.random().toString(36).slice(2)}`;
    }
  })();

  function connect(options) {
    const { role, key = '', onState, onMine, onError, onHello, onQuestion, onReset } = options;
    const importantMessages = new Map();
    const badge = document.querySelector('.connection');
    let socket;
    let reconnectAttempts = 0;
    let reconnectTimer;
    let closed = false;

    function sendRaw(message) {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      try {
        socket.send(JSON.stringify(message));
        return true;
      } catch {
        return false;
      }
    }

    function replayImportant() {
      if (document.hidden) return;
      for (const message of importantMessages.values()) sendRaw(message);
    }

    function open() {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${location.host}/ws?room=main`);
      socket.addEventListener('open', () => {
        reconnectAttempts = 0;
        badge?.classList.remove('off');
        sendRaw({ type: 'hello', deviceId, role, key });
        replayImportant();
      });
      socket.addEventListener('message', event => {
        if (event.data === 'pong') return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'state') onState?.(message);
        else if (message.type === 'mine') onMine?.(message);
        else if (message.type === 'error') onError?.(message.message);
        else if (message.type === 'hello') onHello?.(message);
        else if (message.type === 'question_received') onQuestion?.(message);
        else if (message.type === 'reset_complete') onReset?.(message);
      });
      socket.addEventListener('close', () => {
        if (closed) return;
        badge?.classList.add('off');
        clearTimeout(reconnectTimer);
        const delay = Math.min(8000, 500 * 2 ** reconnectAttempts++);
        reconnectTimer = setTimeout(open, delay);
      });
      socket.addEventListener('error', () => socket.close());
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) replayImportant();
    });
    open();

    return {
      send: sendRaw,
      sendVital(name, message) {
        importantMessages.set(name, message);
        if (document.hidden) return false;
        return sendRaw(message);
      },
      close() {
        closed = true;
        clearTimeout(reconnectTimer);
        socket?.close();
      },
      deviceId
    };
  }

  function drawQr(canvas, text, size = 640) {
    const qr = qrcode(0, 'H');
    qr.addData(text);
    qr.make();
    const modules = qr.getModuleCount();
    const quietZone = 4;
    const total = modules + quietZone * 2;
    const cell = Math.max(1, Math.floor(size / total));
    const actualSize = cell * total;
    canvas.width = actualSize;
    canvas.height = actualSize;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, actualSize, actualSize);
    context.fillStyle = '#111827';
    for (let row = 0; row < modules; row += 1) {
      for (let column = 0; column < modules; column += 1) {
        if (!qr.isDark(row, column)) continue;
        context.fillRect((column + quietZone) * cell, (row + quietZone) * cell, cell, cell);
      }
    }
  }

  window.LivePresentation = { connect, drawQr, deviceId };
})();
