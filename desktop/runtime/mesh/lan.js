// النقل عن طريق الواي فاي (راوتر السنتر أو هوت سبوت موبايل): نفس الشبكة اللي الموبايلات بتعملها بالبلوتوث،
// بس الكمبيوتر بيدخلها من الواي فاي. نفس البروتوكول اللي في الموبايل (lan_transport.dart):
//   - اكتشاف: رسالة UDP broadcast على البورت 47821 {"t":"?","adv":...,"tcp":port} والأجهزة بترد مباشرة {"t":"!",...}
//     (الرد على رسالة طالعة من الجهاز بيعدي من الويندوز فايروول حتى على الشبكات "العامة")
//   - الاتصال: TCP، كل رسالة = 4 بايت طولها (big-endian) + البيانات. أول رسالة من اللي بدأ الاتصال = اسمه (adv).
const dgram = require('dgram');
const net = require('net');
const os = require('os');
const { EventEmitter } = require('events');

const DISCOVERY_PORT = 47821;
const MAX_FRAME = 4 * 1024 * 1024;

function broadcastTargets() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal || !ni.netmask) continue;
      const ip = ni.address.split('.').map(Number);
      const mask = ni.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}

class LanTransport extends EventEmitter {
  constructor({ discoveryPort = DISCOVERY_PORT, tcpPort = 0, alwaysConnect = true, probeEveryMs = 4000, targets, probePorts, extraTargets } = {}) {
    super();
    this.discoveryPort = discoveryPort;
    this.probePorts = probePorts || [discoveryPort]; // للاختبارات: كذا جهاز على نفس الكمبيوتر
    this.tcpPort = tcpPort;
    this.alwaysConnect = alwaysConnect; // الكمبيوتر هو اللي بيبدأ الاتصال
    this.probeEveryMs = probeEveryMs;
    this.targets = targets;
    // عناوين نبعتلها مباشرة كمان (الموبايلات اللي داخلة واي فاي الكمبيوتر — أندرويد كتير بيرمي الـ broadcast وهو موفر طاقة)
    this.extraTargets = extraTargets || (() => []);
    this.maxBytes = 1024 * 1024;
    this.sockets = new Map(); // endpointId -> socket
    this.found = new Map(); // endpointId -> { host, port, at }
    this.advertName = '';
  }

  emitEvent(type, fields) { this.emit('event', { type, ...fields }); }

  async start(advertName) {
    this.advertName = advertName;
    await this.listenTcp();
    await this.listenUdp();
    this.probe();
    this.timer = setInterval(() => this.probe(), this.probeEveryMs);
    if (this.timer.unref) this.timer.unref();
  }

  listenTcp() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer(socket => this.accept(socket));
      this.server.once('error', reject);
      this.server.listen(this.tcpPort, () => {
        this.server.removeListener('error', reject);
        this.tcpPort = this.server.address().port;
        resolve();
      });
    });
  }

  listenUdp() {
    return new Promise((resolve) => {
      this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.udp.on('message', (buf, rinfo) => this.onDatagram(buf, rinfo));
      this.udp.on('error', (error) => this.emitEvent('error', { message: `UDP: ${error.message}` }));
      const bound = () => {
        try { this.udp.setBroadcast(true); } catch (e) { /* مش مدعوم */ }
        resolve();
      };
      this.udp.bind(this.discoveryPort, bound);
      this.udp.once('error', () => {
        // البورت مشغول (برنامج تاني): نسمع على أي بورت — الردود المباشرة لسه بتوصل
        this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        this.udp.on('message', (buf, rinfo) => this.onDatagram(buf, rinfo));
        this.udp.bind(0, bound);
      });
    });
  }

  probe() {
    if (!this.udp) return;
    const msg = Buffer.from(JSON.stringify({ t: '?', adv: this.advertName, tcp: this.tcpPort }));
    let extra = [];
    try { extra = this.extraTargets() || []; } catch (e) { /* مفيش */ }
    for (const target of new Set([...(this.targets || broadcastTargets()), ...extra])) {
      for (const port of this.probePorts) this.udp.send(msg, port, target, () => {});
    }
    const now = Date.now();
    for (const [id, f] of this.found) {
      if (now - f.at > 30 * 1000) {
        this.found.delete(id);
        this.emitEvent('lost', { id });
      }
    }
  }

  onDatagram(buf, rinfo) {
    let msg;
    try { msg = JSON.parse(buf.toString('utf8')); } catch (e) { return; }
    if (!msg || (msg.t !== '?' && msg.t !== '!') || typeof msg.adv !== 'string' || msg.adv === this.advertName) return;
    if (msg.t === '?') {
      const reply = Buffer.from(JSON.stringify({ t: '!', adv: this.advertName, tcp: this.tcpPort }));
      this.udp.send(reply, rinfo.port, rinfo.address, () => {});
    }
    const port = Number(msg.tcp);
    if (!port) return;
    const id = `lan@${rinfo.address}:${port}`;
    const first = !this.found.has(id);
    this.found.set(id, { host: rinfo.address, port, at: Date.now() });
    if (first) this.emitEvent('found', { id, name: msg.adv, alwaysConnect: this.alwaysConnect });
  }

  accept(socket) {
    const id = `lan<${socket.remoteAddress}:${socket.remotePort}`;
    let named = false;
    this.wire(socket, id, (frame) => {
      if (!named) {
        named = true;
        this.sockets.set(id, socket);
        this.emitEvent('initiated', { id, name: frame.toString('utf8'), incoming: true });
        this.emitEvent('result', { id, ok: true });
        return;
      }
      this.emitEvent('payload', { id, data: frame });
    });
  }

  async connect(endpointId) {
    const f = this.found.get(endpointId);
    if (!f) return false;
    return new Promise((resolve) => {
      const socket = net.connect({ host: f.host, port: f.port, timeout: 8000 });
      let done = false;
      const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
      socket.once('connect', () => {
        socket.setTimeout(0);
        this.sockets.set(endpointId, socket);
        this.writeFrame(socket, Buffer.from(this.advertName, 'utf8'));
        this.wire(socket, endpointId, frame => this.emitEvent('payload', { id: endpointId, data: frame }));
        this.emitEvent('initiated', { id: endpointId, name: '', incoming: false });
        this.emitEvent('result', { id: endpointId, ok: true });
        finish(true);
      });
      socket.once('timeout', () => { socket.destroy(); finish(false); });
      socket.once('error', () => finish(false));
    });
  }

  wire(socket, id, onFrame) {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const len = buffer.readUInt32BE(0);
        if (len > MAX_FRAME) { socket.destroy(); return; }
        if (buffer.length < 4 + len) break;
        const frame = buffer.subarray(4, 4 + len);
        buffer = buffer.subarray(4 + len);
        onFrame(Buffer.from(frame));
      }
    });
    const closed = () => {
      if (this.sockets.get(id) === socket) {
        this.sockets.delete(id);
        this.emitEvent('disconnected', { id });
      }
    };
    socket.on('close', closed);
    socket.on('error', () => {});
  }

  writeFrame(socket, data) {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(data.length, 0);
    return socket.write(Buffer.concat([header, data]));
  }

  async send(endpointId, data) {
    const socket = this.sockets.get(endpointId);
    if (!socket || socket.destroyed) return false;
    this.writeFrame(socket, Buffer.from(data));
    return true;
  }

  async disconnect(endpointId) {
    const socket = this.sockets.get(endpointId);
    if (socket) socket.destroy();
  }

  async restart() {
    this.found.clear();
    this.probe();
  }

  async stop() {
    clearInterval(this.timer);
    for (const socket of this.sockets.values()) socket.destroy();
    this.sockets.clear();
    this.found.clear();
    await new Promise(resolve => (this.server ? this.server.close(() => resolve()) : resolve()));
    if (this.udp) try { this.udp.close(); } catch (e) { /* مقفول */ }
    this.server = null;
    this.udp = null;
  }
}

module.exports = { LanTransport, DISCOVERY_PORT };
