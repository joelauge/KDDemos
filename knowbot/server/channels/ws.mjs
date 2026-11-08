// A minimal RFC 6455 WebSocket server endpoint (no dependency): enough for Twilio Media Streams (JSON text frames, ping,
// close) and for the loopback fakes in the tests. The client side (Gemini Live) uses Node's built-in global WebSocket.
//
//   acceptWebSocket(req, socket, head, { maxMessage }) → ws  (or null after answering a bad handshake with 400)
//   ws.on('message', (data: string | Buffer, isBinary) => …)  ws.on('close', (code, reason) => …)
//   ws.send(string | Buffer)  ws.close(code?, reason?)  ws.readyState (0 connecting, 1 open, 2 closing, 3 closed)
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const OPEN = 1;
export const CLOSED = 3;

/** Writes a bare HTTP status on a raw upgrade socket and closes it. */
export function rejectUpgrade(socket, status, message = '') {
  const reason = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 426: 'Upgrade Required', 503: 'Service Unavailable' }[status] || 'Error';
  try {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
  } catch { /* already gone */ }
}

export const isWebSocketUpgrade = (req) => String(req.headers.upgrade || '').toLowerCase() === 'websocket';

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, payload]);
}

class ServerSocket extends EventEmitter {
  constructor(socket, maxMessage) {
    super();
    this.socket = socket;
    this.readyState = OPEN;
    this.maxMessage = maxMessage;
    this.buf = Buffer.alloc(0);
    this.parts = [];
    this.partOp = 0;
    socket.setNoDelay?.(true);
    socket.on('data', (d) => { this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d; this.parse(); });
    socket.on('close', () => this.finish(1006, ''));
    socket.on('error', () => this.finish(1006, ''));
  }
  get OPEN() { return OPEN; }
  parse() {
    while (this.readyState !== CLOSED && this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; const big = this.buf.readBigUInt64BE(2); if (big > BigInt(this.maxMessage)) return this.close(1009, 'message too big'); len = Number(big); off = 10; }
      if (len > this.maxMessage) return this.close(1009, 'message too big');
      const need = off + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;
      let payload = this.buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buf = this.buf.subarray(need);
      this.onFrame(fin, op, payload);
    }
  }
  onFrame(fin, op, payload) {
    if (op === 0x8) { // close
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      if (this.readyState === OPEN) { try { this.socket.write(frame(0x8, payload.subarray(0, 2))); } catch {} }
      this.readyState = 2;
      try { this.socket.end(); } catch {}
      return this.finish(code, reason);
    }
    if (op === 0x9) { try { this.socket.write(frame(0xa, payload)); } catch {} return; } // ping → pong
    if (op === 0xa) return; // pong
    if (op === 0x1 || op === 0x2) { this.parts = [payload]; this.partOp = op; }
    else if (op === 0x0) this.parts.push(payload);
    else return this.close(1002, 'bad opcode');
    if (this.parts.reduce((n, p) => n + p.length, 0) > this.maxMessage) return this.close(1009, 'message too big');
    if (!fin) return;
    const data = Buffer.concat(this.parts);
    this.parts = [];
    if (this.partOp === 0x1) this.emit('message', data.toString('utf8'), false);
    else this.emit('message', data, true);
  }
  send(data) {
    if (this.readyState !== OPEN) return;
    const isText = typeof data === 'string';
    try { this.socket.write(frame(isText ? 0x1 : 0x2, isText ? Buffer.from(data, 'utf8') : Buffer.from(data))); } catch { /* closed under us */ }
  }
  close(code = 1000, reason = '') {
    if (this.readyState !== OPEN) return;
    const r = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0); r.copy(p, 2);
    this.readyState = 2;
    try { this.socket.write(frame(0x8, p)); } catch {}
    // the peer answers with its own close frame; never wait on it for long
    setTimeout(() => { try { this.socket.destroy(); } catch {} }, 1000).unref?.();
    try { this.socket.end(); } catch {}
    this.finish(code, String(reason));
  }
  finish(code, reason) {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit('close', code, reason);
  }
}

/** Completes the handshake on an 'upgrade' socket. */
export function acceptWebSocket(req, socket, head, { maxMessage = 1024 * 1024 } = {}) {
  const key = String(req.headers['sec-websocket-key'] || '');
  if (!isWebSocketUpgrade(req) || !/^[A-Za-z0-9+/]{22}==$/.test(key)) { rejectUpgrade(socket, 400, 'Expected a WebSocket upgrade.'); return null; }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`);
  const ws = new ServerSocket(socket, maxMessage);
  if (head?.length) { ws.buf = Buffer.from(head); ws.parse(); }
  return ws;
}
