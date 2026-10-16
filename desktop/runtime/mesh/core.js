// شبكة الأجهزة أوفلاين على برنامج الديسكتوب — نفس منطق الموبايل بالظبط (mobile/lib/services/mesh/mesh_core.dart)
// ونفس شكل الرسايل، عشان الكمبيوتر والموبايلات يتكلموا مع بعض. أي تغيير هنا لازم يتعمل هناك كمان.
const crypto = require('crypto');
const zlib = require('zlib');
const { EventEmitter } = require('events');

const PROTOCOL = 'SF1';

function hmacHex(key, message) {
  return crypto.createHmac('sha256', Buffer.from(String(key), 'utf8')).update(String(message), 'utf8').digest('hex');
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

// ======================= السجل =======================
class MeshLog {
  constructor() {
    this.entries = new Map();
    this.seqs = new Map(); // origin -> Set
    this.floor = new Map(); // origin -> int
  }

  add(entry) {
    const id = String((entry && entry.e) || '');
    const origin = String((entry && entry.o) || '');
    const seq = entry && entry.s;
    if (!id || !origin || !Number.isInteger(seq)) return false;
    if (this.entries.has(id) || seq <= (this.floor.get(origin) || 0)) return false;
    this.entries.set(id, entry);
    if (!this.seqs.has(origin)) this.seqs.set(origin, new Set());
    this.seqs.get(origin).add(seq);
    return true;
  }

  contiguous(origin) {
    let n = this.floor.get(origin) || 0;
    const set = this.seqs.get(origin);
    if (!set) return n;
    while (set.has(n + 1)) n++;
    return n;
  }

  maxSeq(origin) {
    const set = this.seqs.get(origin);
    let top = 0;
    if (set) for (const s of set) if (s > top) top = s;
    return Math.max(top, this.floor.get(origin) || 0);
  }

  summary() {
    const out = {};
    for (const o of new Set([...this.seqs.keys(), ...this.floor.keys()])) out[o] = this.contiguous(o);
    return out;
  }

  missingFor(peer) {
    const out = [];
    for (const e of this.entries.values()) {
      const have = peer[String(e.o)];
      if (!Number.isInteger(have) || e.s > have) out.push(e);
    }
    out.sort((a, b) => (String(a.o) < String(b.o) ? -1 : String(a.o) > String(b.o) ? 1 : a.s - b.s));
    return out;
  }

  ofKind(kind) {
    return [...this.entries.values()].filter(e => e.k === kind);
  }

  prune(olderThanMs, done) {
    for (const [origin, set] of this.seqs) {
      let floor = this.floor.get(origin) || 0;
      while (set.has(floor + 1)) {
        const entry = [...this.entries.values()].find(e => e.o === origin && e.s === floor + 1);
        if (!entry || (entry.at || 0) >= olderThanMs || !done(entry)) break;
        this.entries.delete(entry.e);
        set.delete(floor + 1);
        floor++;
      }
      this.floor.set(origin, floor);
    }
  }

  toJSON() {
    return { entries: [...this.entries.values()], floor: Object.fromEntries(this.floor) };
  }

  static fromJSON(json) {
    const log = new MeshLog();
    if (!json) return log;
    for (const [k, v] of Object.entries(json.floor || {})) if (Number.isInteger(v)) log.floor.set(k, v);
    for (const e of json.entries || []) log.add(e);
    return log;
  }
}

// ======================= حالة كل عملية =======================
const OpState = { pending: 'pending', uploaded: 'uploaded', rejected: 'rejected', duplicate: 'duplicate', review: 'review', dismissed: 'dismissed' };

function opMoney(op) {
  const body = (op && op.d && op.d.body) || {};
  let total = 0;
  for (const [k, v] of Object.entries(body)) {
    if (/payment|amount|paid/i.test(k)) {
      const n = typeof v === 'number' ? v : parseFloat(v);
      if (!Number.isNaN(n) && n > 0) total += n;
    }
  }
  return total;
}

function defaultNormalize(code) {
  const ar = '٠١٢٣٤٥٦٧٨٩';
  const fa = '۰۱۲۳۴۵۶۷۸۹';
  let text = String(code).split('').map((c) => {
    const a = ar.indexOf(c);
    const f = fa.indexOf(c);
    return a >= 0 ? String(a) : (f >= 0 ? String(f) : c);
  }).join('').trim().toUpperCase();
  const m = /^(?:STU)?[\s-]*0*(\d+)$/.exec(text);
  if (m) text = `STU-${m[1].padStart(5, '0')}`;
  return text;
}

function computeStatuses(log, normalizeCode = defaultNormalize) {
  const receipts = new Map();
  for (const r of log.ofKind('rc')) {
    const opId = String(r.d && r.d.op);
    const prev = receipts.get(opId);
    if (!prev || (r.d.ok === true && prev.d.ok !== true)) receipts.set(opId, r);
  }
  const decisions = new Map();
  for (const d of log.ofKind('dec')) {
    const opId = String(d.d && d.d.op);
    const prev = decisions.get(opId);
    if (!prev || d.at >= prev.at) decisions.set(opId, d);
  }
  const ops = log.ofKind('op').sort((a, b) => ((a.d.ct || 0) - (b.d.ct || 0)) || (String(a.d.id) < String(b.d.id) ? -1 : String(a.d.id) > String(b.d.id) ? 1 : 0));

  const out = new Map();
  const groups = new Map();
  for (const op of ops) {
    const d = op.d;
    const id = String(d.id);
    const rc = receipts.get(id);
    if (rc) out.set(id, { state: rc.d.ok === true ? OpState.uploaded : OpState.rejected, message: String(rc.d.msg || '') });
    const code = normalizeCode(String((d.body && d.body.student_code) || ''));
    const kind = String(d.kind);
    const family = (kind === 'attendance' || kind === 'force') ? 'att' : (kind === 'homework' ? 'hw' : kind);
    const key = `${family}|${code}|${d.sid}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(op);
  }

  for (const [key, list] of groups) {
    if (key.startsWith('att|')) {
      const alive = list.filter((op) => {
        const s = out.get(String(op.d.id));
        const dec = decisions.get(String(op.d.id));
        return !(s && s.state === OpState.rejected) && !(dec && dec.d.action === 'dismiss');
      });
      const primary = alive.find(op => (out.get(String(op.d.id)) || {}).state === OpState.uploaded) || alive[0] || null;
      for (const op of list) {
        const id = String(op.d.id);
        if (out.has(id)) continue;
        const dec = decisions.get(id);
        const action = dec && dec.d.action;
        if (action === 'dismiss') out.set(id, { state: OpState.dismissed, message: 'اتلغت في المراجعة' });
        else if (op === primary || !primary || action === 'upload') out.set(id, { state: OpState.pending, message: '' });
        else {
          const who = (primary.d && primary.d.user) || 'جهاز تاني';
          out.set(id, opMoney(op) > 0
            ? { state: OpState.review, message: `الطالب اتسجل حضوره قبل كده (${who}) والعملية دي معاها فلوس — محتاجة مراجعة`, firstBy: primary }
            : { state: OpState.duplicate, message: `الطالب اتسجل حضوره قبل كده (${who})`, firstBy: primary });
        }
      }
    } else if (key.startsWith('hw|')) {
      let last = null;
      let lastOp = null;
      for (const op of list) {
        const id = String(op.d.id);
        const status = String(op.d.body && op.d.body.status);
        const s = out.get(id);
        if (s && s.state === OpState.rejected) continue;
        if (!s) {
          out.set(id, status === last && lastOp
            ? { state: OpState.duplicate, message: `نفس حالة الواجب اتسجلت قبل كده (${(lastOp.d && lastOp.d.user) || 'جهاز تاني'})`, firstBy: lastOp }
            : { state: OpState.pending, message: '' });
        }
        if (out.get(id).state !== OpState.duplicate) {
          last = status;
          lastOp = op;
        }
      }
    } else {
      for (const op of list) if (!out.has(String(op.d.id))) out.set(String(op.d.id), { state: OpState.pending, message: '' });
    }
  }
  return out;
}

// ======================= الجهاز =======================
class MeshPeer {
  constructor(node) {
    Object.assign(this, { node, name: '', user: '', role: '', lastSeen: 0, hops: 99, direct: false, quality: 0, rttMs: null, snapAt: 0, pending: 0, beaconAt: 0 });
  }
}

class Link {
  constructor(endpointId) {
    this.endpointId = endpointId;
    this.nonce = randomHex(16);
    this.peerNonce = null;
    this.node = null;
    this.connected = false;
    this.authed = false;
    this.helloSent = false;
    this.outgoing = false;
    this.quality = 0;
    this.lastRx = Date.now();
    this.pingAt = null;
    this.rtt = null;
    this.parts = new Map();
  }
}

/**
 * host: { meshKey, displayName, userName, role, snapshotAt, snapshotRaw(): Promise<string|null>,
 *         onSnapshot(raw, at, from), onEntries(list), saveLog(), pendingCount }
 * transport: EventEmitter('event', {type,id,name,data,quality,ok,incoming,message}) +
 *            start(name), restart(), stop(), connect(id), disconnect(id), send(id, Buffer), maxBytes
 */
class MeshNode extends EventEmitter {
  constructor(transport, host, { nodeId, log, maxDirect = 8, clock } = {}) {
    super();
    this.transport = transport;
    this.host = host;
    this.nodeId = nodeId;
    this.log = log || new MeshLog();
    this.maxDirect = maxDirect;
    this.now = clock || (() => Date.now());
    this.links = new Map();
    this.candidates = new Map();
    this.candidateNode = new Map();
    this.peers = new Map();
    this.running = false;
    this.lastProblem = '';
    this.tick = 0;
    this.snapshotRequestedAt = null;
    this.seenBeacons = new Map();
    this.onEvent = this.onEvent.bind(this);
  }

  changed() { this.emit('change'); }

  get advertName() { return `${PROTOCOL}|${this.nodeId}|${String(this.host.displayName).replace(/\|/g, ' ')}`; }
  get directCount() { return [...this.links.values()].filter(l => l.authed).length; }

  async start() {
    if (this.running) return;
    this.running = true;
    this.transport.on('event', this.onEvent);
    await this.transport.start(this.advertName);
    this.timer = setInterval(() => this.maintain(), 5000);
    if (this.timer.unref) this.timer.unref();
    this.changed();
  }

  async stop() {
    this.running = false;
    clearInterval(this.timer);
    this.transport.removeListener('event', this.onEvent);
    this.links.clear();
    this.candidates.clear();
    for (const p of this.peers.values()) p.direct = false;
    await this.transport.stop();
    this.changed();
  }

  async reconnect() {
    for (const link of [...this.links.values()]) {
      if (!link.authed || link.quality === 1 || (link.rtt || 0) > 2500) {
        await this.transport.disconnect(link.endpointId);
        this.drop(link.endpointId);
      }
    }
    this.candidates.clear();
    await this.transport.restart();
    this.changed();
  }

  publish(kind, data) {
    const seq = this.log.maxSeq(this.nodeId) + 1;
    const entry = { e: `${this.nodeId}:${seq}`, o: this.nodeId, s: seq, k: kind, at: this.now(), d: data };
    this.log.add(entry);
    this.host.saveLog();
    this.broadcast({ t: 'e', es: [entry] });
    this.changed();
    return entry;
  }

  onEvent(ev) {
    switch (ev.type) {
      case 'found': {
        const parts = String(ev.name || '').split('|');
        if (parts.length < 2 || parts[0] !== PROTOCOL || parts[1] === this.nodeId) return;
        if ([...this.links.values()].some(l => l.node === parts[1] || l.endpointId === ev.id)) return;
        this.candidates.set(ev.id, this.now());
        this.candidateNode.set(ev.id, parts[1]);
        // الكمبيوتر بيبدأ الاتصال دايمًا (الويندوز فايروول غالبًا بيقفل الجاي من برا)
        if (ev.alwaysConnect || this.nodeId < parts[1]) this.tryConnect(ev.id);
        break;
      }
      case 'lost':
        this.candidates.delete(ev.id);
        break;
      case 'initiated': {
        if (!this.links.has(ev.id)) this.links.set(ev.id, new Link(ev.id));
        const link = this.links.get(ev.id);
        const parts = String(ev.name || '').split('|');
        if (parts.length >= 2 && parts[0] === PROTOCOL) link.node = parts[1];
        link.outgoing = ev.incoming === false;
        this.candidates.delete(ev.id);
        break;
      }
      case 'result': {
        const link = this.links.get(ev.id);
        if (!link) return;
        if (ev.ok) {
          link.connected = true;
          link.lastRx = this.now();
          this.send(link, { t: 'n', n: link.nonce });
        } else this.drop(ev.id);
        break;
      }
      case 'disconnected':
        this.drop(ev.id);
        break;
      case 'bandwidth': {
        const link = this.links.get(ev.id);
        if (link) {
          link.quality = ev.quality || 0;
          const peer = link.node && this.peers.get(link.node);
          if (peer) peer.quality = link.quality;
          this.changed();
        }
        break;
      }
      case 'payload': {
        const link = this.links.get(ev.id);
        if (!link || !ev.data) return;
        link.lastRx = this.now();
        this.receive(link, ev.data);
        break;
      }
      case 'error':
        this.lastProblem = ev.message || '';
        this.changed();
        break;
      default:
    }
  }

  async tryConnect(endpointId) {
    const pendingLinks = [...this.links.values()].filter(l => !l.authed).length;
    if (this.directCount + pendingLinks >= this.maxDirect) return;
    if (!this.links.has(endpointId)) this.links.set(endpointId, new Link(endpointId));
    const link = this.links.get(endpointId);
    if (!link.node) link.node = this.candidateNode.get(endpointId) || null;
    this.candidates.delete(endpointId);
    const ok = await this.transport.connect(endpointId);
    if (!ok) this.links.delete(endpointId);
  }

  drop(endpointId) {
    const link = this.links.get(endpointId);
    this.links.delete(endpointId);
    if (link && link.node && ![...this.links.values()].some(l => l.authed && l.node === link.node)) {
      const peer = this.peers.get(link.node);
      if (peer) { peer.direct = false; peer.quality = 0; }
    }
    this.changed();
  }

  receive(link, bytes) {
    let msg;
    try { msg = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch (e) { return; }
    if (msg.t === '~') {
      const x = String(msg.x);
      if (!link.parts.has(x)) link.parts.set(x, new Array(msg.n).fill(null));
      const list = link.parts.get(x);
      list[msg.i] = String(msg.d);
      if (list.some(p => p === null)) return;
      link.parts.delete(x);
      try { msg = JSON.parse(zlib.gunzipSync(Buffer.from(list.join(''), 'base64')).toString('utf8')); } catch (e) { return; }
    }
    this.handle(link, msg);
  }

  handle(link, msg) {
    const t = msg.t;
    if (t === 'n') {
      link.peerNonce = String(msg.n);
      this.sendHello(link);
      return;
    }
    if (t === 'h') {
      const node = String(msg.node);
      const proof = hmacHex(this.host.meshKey, `h|${node}|${link.nonce}`);
      if (!this.host.meshKey || msg.proof !== proof || node === this.nodeId) {
        this.lastProblem = 'جهاز حاول يتوصل ومعهوش مفتاح الشبكة الصحيح';
        this.transport.disconnect(link.endpointId);
        this.drop(link.endpointId);
        return;
      }
      // متوصلين بنفس الجهاز مرتين (الاتنين بدأوا الاتصال في نفس اللحظة): الطرفين لازم يسيبوا نفس الاتصال —
      // اللي بدأه الجهاز صاحب الرقم الأصغر
      const other = [...this.links.values()].find(l => l !== link && l.authed && l.node === node);
      if (other) {
        const keepNew = (link.outgoing ? this.nodeId : node) === (this.nodeId < node ? this.nodeId : node);
        const loser = keepNew ? other : link;
        this.transport.disconnect(loser.endpointId);
        this.links.delete(loser.endpointId);
        if (!keepNew) return;
      }
      link.node = node;
      link.authed = true;
      if (!this.peers.has(node)) this.peers.set(node, new MeshPeer(node));
      const peer = this.peers.get(node);
      Object.assign(peer, {
        name: String(msg.name || ''), user: String(msg.user || ''), role: String(msg.role || ''),
        direct: true, hops: 1, quality: link.quality, snapAt: msg.snapAt || 0, pending: msg.pending || 0, lastSeen: this.now(),
      });
      this.send(link, { t: 's', sum: this.log.summary() });
      if (peer.snapAt > this.host.snapshotAt + 5 * 60 * 1000 && this.host.wantsSnapshots !== false) this.requestSnapshot(node);
      this.changed();
      return;
    }
    if (!link.authed) return;
    const peer = this.peers.get(link.node);
    if (peer) peer.lastSeen = this.now();
    switch (t) {
      case 's': {
        const missing = this.log.missingFor(msg.sum || {});
        for (let i = 0; i < missing.length; i += 200) this.send(link, { t: 'e', es: missing.slice(i, i + 200) });
        break;
      }
      case 'e': {
        const added = [];
        for (const e of msg.es || []) if (e && this.log.add(e)) added.push(e);
        if (added.length) {
          this.host.onEntries(added);
          this.host.saveLog();
          this.broadcast({ t: 'e', es: added }, link);
          this.changed();
        }
        break;
      }
      case 'b':
        this.onBeacon(link, msg);
        break;
      case 'p':
        this.send(link, { t: 'q', x: msg.x });
        break;
      case 'q':
        if (link.pingAt !== null && msg.x === link.pingAt) {
          link.rtt = this.now() - link.pingAt;
          link.pingAt = null;
          if (peer) peer.rttMs = link.rtt;
          this.changed();
        }
        break;
      case 'r':
        Promise.resolve(this.host.snapshotRaw()).then((raw) => {
          if (raw) this.send(link, { t: 'S', at: this.host.snapshotAt, raw, from: this.host.displayName });
        }).catch(() => {});
        break;
      case 'S': {
        const at = msg.at || 0;
        this.snapshotRequestedAt = null;
        if (at > this.host.snapshotAt && typeof msg.raw === 'string') {
          this.host.onSnapshot(msg.raw, at, String(msg.from || (peer && peer.name) || ''));
          this.changed();
        }
        break;
      }
      default:
    }
  }

  sendHello(link) {
    if (link.peerNonce === null || link.helloSent) return;
    link.helloSent = true;
    this.send(link, {
      t: 'h', node: this.nodeId, name: this.host.displayName, user: this.host.userName, role: this.host.role,
      snapAt: this.host.snapshotAt, pending: this.host.pendingCount, proof: hmacHex(this.host.meshKey, `h|${this.nodeId}|${link.peerNonce}`),
    });
  }

  onBeacon(from, msg) {
    const node = String(msg.node);
    const at = msg.at || 0;
    if (node === this.nodeId || (this.seenBeacons.get(node) || 0) >= at) return;
    this.seenBeacons.set(node, at);
    const hops = (msg.hops || 0) + 1;
    if (!this.peers.has(node)) this.peers.set(node, new MeshPeer(node));
    const peer = this.peers.get(node);
    Object.assign(peer, {
      name: msg.name !== undefined ? String(msg.name) : peer.name,
      user: msg.user !== undefined ? String(msg.user) : peer.user,
      role: msg.role !== undefined ? String(msg.role) : peer.role,
      snapAt: msg.snapAt !== undefined ? msg.snapAt : peer.snapAt,
      pending: msg.pending !== undefined ? msg.pending : peer.pending,
      lastSeen: this.now(),
      beaconAt: at,
    });
    if (!peer.direct) peer.hops = hops;
    this.changed();
    if (hops < 8) this.broadcast({ ...msg, hops }, from);
  }

  requestSnapshot(from) {
    const authed = [...this.links.values()].filter(l => l.authed);
    const candidates = authed.filter(l => !from || l.node === from)
      .sort((a, b) => ((this.peers.get(b.node) || {}).snapAt || 0) - ((this.peers.get(a.node) || {}).snapAt || 0));
    for (const link of authed) this.send(link, { t: 's', sum: this.log.summary() });
    if (!candidates.length) return false;
    this.snapshotRequestedAt = this.now();
    this.send(candidates[0], { t: 'r' });
    return true;
  }

  broadcast(msg, except) {
    for (const link of [...this.links.values()]) if (link.authed && link !== except) this.send(link, msg);
  }

  async send(link, msg) {
    const bytes = Buffer.from(JSON.stringify(msg), 'utf8');
    const limit = this.transport.maxBytes - 512;
    if (bytes.length <= limit) {
      await this.transport.send(link.endpointId, bytes);
      return;
    }
    const packed = zlib.gzipSync(bytes).toString('base64');
    const size = limit - 200;
    const n = Math.ceil(packed.length / size);
    const x = randomHex(6);
    for (let i = 0; i < n; i++) {
      const part = { t: '~', x, i, n, d: packed.slice(i * size, (i + 1) * size) };
      const ok = await this.transport.send(link.endpointId, Buffer.from(JSON.stringify(part), 'utf8'));
      if (!ok) return;
    }
  }

  maintain() {
    if (!this.running) return;
    this.tick++;
    const now = this.now();
    for (const link of [...this.links.values()]) {
      if ((link.authed && now - link.lastRx > 45 * 1000) || (!link.authed && now - link.lastRx > 30 * 1000)) {
        this.transport.disconnect(link.endpointId);
        this.drop(link.endpointId);
        continue;
      }
      if (link.authed && this.tick % 2 === 0) {
        link.pingAt = now;
        this.send(link, { t: 'p', x: now });
      }
    }
    for (const [id, at] of [...this.candidates]) if (now - at > 15 * 1000) this.tryConnect(id);
    if (this.tick % 12 === 0 && this.directCount >= this.maxDirect && this.candidates.size) {
      const weak = [...this.links.values()].find(l => l.authed && (l.quality === 1 || (l.rtt || 0) > 2500));
      if (weak) { this.transport.disconnect(weak.endpointId); this.drop(weak.endpointId); }
    }
    if (this.tick % 4 === 0) {
      this.seenBeacons.set(this.nodeId, now);
      this.broadcast({
        t: 'b', node: this.nodeId, at: now, hops: 0, name: this.host.displayName, user: this.host.userName,
        role: this.host.role, snapAt: this.host.snapshotAt, pending: this.host.pendingCount,
      });
    }
    if (this.tick % 6 === 0) this.broadcast({ t: 's', sum: this.log.summary() });
    this.changed();
  }

  visiblePeers() {
    const now = this.now();
    return [...this.peers.values()]
      .filter(p => p.direct || now - p.lastSeen < 6 * 60 * 60 * 1000)
      .sort((a, b) => (a.direct !== b.direct ? (a.direct ? -1 : 1) : b.lastSeen - a.lastSeen));
  }

  isOnline(p) { return p.direct || this.now() - p.lastSeen < 90 * 1000; }
}

module.exports = { MeshLog, MeshNode, computeStatuses, opMoney, OpState, hmacHex, defaultNormalize, PROTOCOL };
