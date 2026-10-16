// شبكة الأجهزة أوفلاين — المنطق كله (من غير أي حاجة خاصة بأندرويد، عشان يتجرب في الاختبارات):
//
// - كل جهاز عنده "سجل" (MeshLog): كل عملية مسح (حضور/واجب) + إيصالات الرفع + قرارات المراجعة + الإعدادات.
//   كل سطر ليه (الجهاز اللي عمله، رقم مسلسل) فالأجهزة بتقارن "أنا عندي لحد كام من كل جهاز" وتبعت الناقص بس.
// - أي سطر جديد بيوصل لجهاز بيتبعت لكل الأجهزة المتوصلة بيه (ما عدا اللي جه منه) — فالبيانات بتعدي من جهاز
//   للتاني لحد ما توصل لأبعد جهاز (نقط تفتيش على مسافات).
// - الدخول للشبكة بمفتاح الشبكة اللي السيرفر بيديه للأجهزة المتسجلة بس (تحدي/رد بـ HMAC).
// - الرسايل الكبيرة (زي نسخة البيانات كاملة) بتتضغط وتتقسم أجزاء.
import 'dart:async';
import 'dart:convert';
import 'dart:io' show gzip;
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

// ======================= النقل =======================

class MeshEvent {
  MeshEvent(this.type, {this.id = '', this.name, this.data, this.quality, this.ok, this.incoming, this.message});
  /// found / lost / initiated / result / disconnected / payload / bandwidth / error
  final String type;
  final String id;
  final String? name;
  final Uint8List? data;
  final int? quality;
  final bool? ok;
  final bool? incoming;
  final String? message;
}

abstract class MeshTransport {
  Stream<MeshEvent> get events;
  Future<void> start(String advertName);
  Future<void> restart();
  Future<void> stop();
  Future<bool> connect(String endpointId);
  Future<void> disconnect(String endpointId);
  Future<bool> send(String endpointId, Uint8List data);
  int get maxBytes;
}

// ======================= السجل =======================

/// سطر في السجل: {e: id, o: الجهاز, s: مسلسل, k: op|rc|dec|cfg, at: وقت, d: البيانات}
typedef MeshEntry = Map<String, dynamic>;

class MeshLog {
  final Map<String, MeshEntry> entries = {};
  final Map<String, Set<int>> _seqs = {};
  /// أي حاجة أقل من أو تساوي الرقم ده اتمسحت (قديمة) — بنعتبرها موجودة
  final Map<String, int> _floor = {};

  bool add(MeshEntry entry) {
    final id = '${entry['e'] ?? ''}';
    final origin = '${entry['o'] ?? ''}';
    final seq = entry['s'];
    if (id.isEmpty || origin.isEmpty || seq is! int) return false;
    if (entries.containsKey(id) || seq <= (_floor[origin] ?? 0)) return false;
    entries[id] = entry;
    (_seqs[origin] ??= {}).add(seq);
    return true;
  }

  /// آخر رقم متصل (من غير فراغات) عندي من الجهاز ده
  int contiguous(String origin) {
    var n = _floor[origin] ?? 0;
    final set = _seqs[origin];
    if (set == null) return n;
    while (set.contains(n + 1)) {
      n++;
    }
    return n;
  }

  int maxSeq(String origin) {
    final set = _seqs[origin];
    final top = (set == null || set.isEmpty) ? 0 : set.reduce(max);
    return max(top, _floor[origin] ?? 0);
  }

  Map<String, int> summary() => {for (final o in {..._seqs.keys, ..._floor.keys}) o: contiguous(o)};

  /// السطور اللي عندي والجهاز التاني معندوش (حسب ملخصه)
  List<MeshEntry> missingFor(Map<String, dynamic> peer) {
    final out = <MeshEntry>[];
    for (final e in entries.values) {
      final have = peer['${e['o']}'];
      if (have is! int || (e['s'] as int) > have) out.add(e);
    }
    out.sort((a, b) {
      final c = '${a['o']}'.compareTo('${b['o']}');
      return c != 0 ? c : (a['s'] as int).compareTo(b['s'] as int);
    });
    return out;
  }

  Iterable<MeshEntry> ofKind(String kind) => entries.values.where((e) => e['k'] == kind);

  /// بنمسح السطور القديمة اللي خلصت (من أول كل جهاز بس، عشان الملخص يفضل صح)
  void prune(int olderThanMs, bool Function(MeshEntry) done) {
    for (final origin in _seqs.keys.toList()) {
      var floor = _floor[origin] ?? 0;
      final set = _seqs[origin]!;
      while (set.contains(floor + 1)) {
        final entry = entries.values.firstWhere((e) => e['o'] == origin && e['s'] == floor + 1);
        if ((entry['at'] as int? ?? 0) >= olderThanMs || !done(entry)) break;
        entries.remove(entry['e']);
        set.remove(floor + 1);
        floor++;
      }
      _floor[origin] = floor;
    }
  }

  Map<String, dynamic> toJson() => {'entries': entries.values.toList(), 'floor': _floor};

  static MeshLog fromJson(Map<String, dynamic>? json) {
    final log = MeshLog();
    if (json == null) return log;
    (json['floor'] as Map? ?? {}).forEach((k, v) {
      if (v is int) log._floor['$k'] = v;
    });
    for (final e in (json['entries'] as List? ?? [])) {
      if (e is Map) log.add(e.cast<String, dynamic>());
    }
    return log;
  }
}

// ======================= حالة كل عملية (تصفية المكرر قبل الرفع) =======================

enum OpState { pending, uploaded, rejected, duplicate, review, dismissed }

class OpStatus {
  OpStatus(this.state, {this.message = '', this.firstBy});
  final OpState state;
  final String message;
  /// للمكرر: العملية الأولى اتعملت من مين
  final MeshEntry? firstBy;
}

num _money(Map body) {
  num total = 0;
  body.forEach((k, v) {
    if (RegExp('payment|amount|paid', caseSensitive: false).hasMatch('$k')) {
      final n = v is num ? v : num.tryParse('$v');
      if (n != null && n > 0) total += n;
    }
  });
  return total;
}

num opMoney(MeshEntry op) => _money(((op['d']?['body'] as Map?) ?? const {}));

/// بيحسب حالة كل عملية من السجل كله — كل الأجهزة بتوصل لنفس النتيجة لو عندها نفس السجل.
/// - حضور نفس الطالب في نفس الحصة: أول واحد بيترفع، والباقي "مكرر" (ولو معاه فلوس = "محتاج مراجعة").
/// - واجب نفس الطالب في نفس الحصة بنفس الحالة: التاني مكرر.
Map<String, OpStatus> computeStatuses(MeshLog log, {String Function(String)? normalizeCode}) {
  final norm = normalizeCode ?? (String c) => c.trim().toUpperCase();
  final receipts = <String, MeshEntry>{};
  for (final r in log.ofKind('rc')) {
    final opId = '${r['d']?['op']}';
    final prev = receipts[opId];
    // إيصال "اترفعت" بيغلب أي إيصال تاني
    if (prev == null || (r['d']['ok'] == true && prev['d']['ok'] != true)) receipts[opId] = r;
  }
  final decisions = <String, MeshEntry>{};
  for (final d in log.ofKind('dec')) {
    final opId = '${d['d']?['op']}';
    final prev = decisions[opId];
    if (prev == null || (d['at'] as int) >= (prev['at'] as int)) decisions[opId] = d;
  }

  final ops = log.ofKind('op').toList()
    ..sort((a, b) {
      final c = ((a['d']['ct'] as num?) ?? 0).compareTo((b['d']['ct'] as num?) ?? 0);
      return c != 0 ? c : '${a['d']['id']}'.compareTo('${b['d']['id']}');
    });

  final out = <String, OpStatus>{};
  final groups = <String, List<MeshEntry>>{};
  for (final op in ops) {
    final d = op['d'] as Map;
    final id = '${d['id']}';
    final rc = receipts[id];
    if (rc != null) {
      final ok = rc['d']['ok'] == true;
      out[id] = OpStatus(ok ? OpState.uploaded : OpState.rejected, message: '${rc['d']['msg'] ?? ''}');
    }
    final code = norm('${(d['body'] as Map?)?['student_code'] ?? ''}');
    final kind = '${d['kind']}';
    final family = (kind == 'attendance' || kind == 'force') ? 'att' : (kind == 'homework' ? 'hw' : kind);
    (groups['$family|$code|${d['sid']}'] ??= []).add(op);
  }

  for (final entry in groups.entries) {
    final list = entry.value;
    final isAttendance = entry.key.startsWith('att|');
    if (isAttendance) {
      final alive = list.where((op) {
        final s = out['${op['d']['id']}']?.state;
        final dec = decisions['${op['d']['id']}']?['d']?['action'];
        return s != OpState.rejected && dec != 'dismiss';
      }).toList();
      final primary = alive.firstWhere((op) => out['${op['d']['id']}']?.state == OpState.uploaded, orElse: () => alive.isEmpty ? <String, dynamic>{} : alive.first);
      for (final op in list) {
        final id = '${op['d']['id']}';
        if (out.containsKey(id)) continue; // ليها إيصال
        final dec = decisions[id]?['d']?['action'];
        if (dec == 'dismiss') {
          out[id] = OpStatus(OpState.dismissed, message: 'اتلغت في المراجعة');
        } else if (identical(op, primary) || primary.isEmpty || dec == 'upload') {
          out[id] = OpStatus(OpState.pending);
        } else {
          final who = primary['d']?['user'] ?? 'جهاز تاني';
          out[id] = opMoney(op) > 0
              ? OpStatus(OpState.review, message: 'الطالب اتسجل حضوره قبل كده ($who) والعملية دي معاها فلوس — محتاجة مراجعة', firstBy: primary)
              : OpStatus(OpState.duplicate, message: 'الطالب اتسجل حضوره قبل كده ($who)', firstBy: primary);
        }
      }
    } else if (entry.key.startsWith('hw|')) {
      String? last;
      MeshEntry? lastOp;
      for (final op in list) {
        final id = '${op['d']['id']}';
        final status = '${(op['d']['body'] as Map?)?['status']}';
        final s = out[id]?.state;
        if (s == OpState.rejected) continue;
        if (s == null) {
          out[id] = (status == last && lastOp != null)
              ? OpStatus(OpState.duplicate, message: 'نفس حالة الواجب اتسجلت قبل كده (${lastOp['d']?['user'] ?? 'جهاز تاني'})', firstBy: lastOp)
              : OpStatus(OpState.pending);
        }
        if (out[id]!.state != OpState.duplicate) {
          last = status;
          lastOp = op;
        }
      }
    } else {
      for (final op in list) {
        out.putIfAbsent('${op['d']['id']}', () => OpStatus(OpState.pending));
      }
    }
  }
  return out;
}

// ======================= الأجهزة =======================

class MeshPeer {
  MeshPeer(this.node);
  final String node;
  String name = '';
  String user = '';
  String role = '';
  int lastSeen = 0;
  int hops = 99;
  bool direct = false;
  /// جودة الاتصال المباشر: 1 ضعيف، 2 متوسط، 3 قوي (من Nearby)
  int quality = 0;
  int? rttMs;
  int snapAt = 0;
  int pending = 0;
  bool uploader = false;
  int beaconAt = 0;
}

class _Link {
  _Link(this.endpointId) : nonce = _randomHex(16);
  final String endpointId;
  final String nonce;
  String? peerNonce;
  String? node;
  bool connected = false;
  bool authed = false;
  bool helloSent = false;
  bool outgoing = false;
  int quality = 0;
  int lastRx = DateTime.now().millisecondsSinceEpoch;
  int? pingAt;
  int? rtt;
  final Map<String, List<String?>> parts = {};
}

String _randomHex(int bytes) {
  final r = Random.secure();
  return List.generate(bytes, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
}

String hmacHex(String key, String message) => Hmac(sha256, utf8.encode(key)).convert(utf8.encode(message)).toString();

/// اللي الجهاز بيقدمه للشبكة (تطبيق الموبايل أو الاختبارات)
abstract class MeshHost {
  String get meshKey;
  String get displayName;
  String get userName;
  String get role;
  /// وقت آخر نسخة بيانات من السيرفر عندي (0 = مفيش)
  int get snapshotAt;
  Future<String?> snapshotRaw();
  Future<void> onSnapshot(String raw, int at, String fromName);
  void onEntries(List<MeshEntry> added);
  void saveLog();
  int get pendingCount;
}

class MeshNode {
  MeshNode(this.transport, this.host, {required this.nodeId, MeshLog? log, this.maxDirect = 6, int Function()? clock})
      : log = log ?? MeshLog(),
        _now = clock ?? (() => DateTime.now().millisecondsSinceEpoch);

  static const protocol = 'SF1';
  final MeshTransport transport;
  final MeshHost host;
  final String nodeId;
  final MeshLog log;
  final int maxDirect;
  final int Function() _now;

  final Map<String, _Link> _links = {};
  final Map<String, int> _candidates = {}; // endpoint → وقت ما ظهر
  final Map<String, String> _candidateNode = {};
  final Map<String, MeshPeer> peers = {};
  final _changes = StreamController<void>.broadcast();
  StreamSubscription<MeshEvent>? _sub;
  Timer? _timer;
  bool running = false;
  String lastProblem = '';
  int _tick = 0;
  int? _snapshotRequestedAt;

  Stream<void> get changes => _changes.stream;
  void _changed() {
    if (!_changes.isClosed) _changes.add(null);
  }

  String get advertName => '$protocol|$nodeId|${host.displayName.replaceAll('|', ' ')}';
  int get directCount => _links.values.where((l) => l.authed).length;

  Future<void> start() async {
    if (running) return;
    running = true;
    _sub = transport.events.listen(_onEvent);
    await transport.start(advertName);
    _timer = Timer.periodic(const Duration(seconds: 5), (_) => maintain());
    _changed();
  }

  Future<void> stop() async {
    running = false;
    _timer?.cancel();
    _timer = null;
    await _sub?.cancel();
    _sub = null;
    _links.clear();
    _candidates.clear();
    for (final p in peers.values) {
      p.direct = false;
    }
    await transport.stop();
    _changed();
  }

  /// زرار "إعادة الاتصال": بيقفل الاتصالات الضعيفة ويدور من الأول
  Future<void> reconnect() async {
    for (final link in _links.values.toList()) {
      if (!link.authed || link.quality == 1 || (link.rtt ?? 0) > 2500) {
        await transport.disconnect(link.endpointId);
        _drop(link.endpointId);
      }
    }
    _candidates.clear();
    await transport.restart();
    _changed();
  }

  // ===== إضافة سطر جديد من الجهاز ده =====
  MeshEntry publish(String kind, Map<String, dynamic> data) {
    final seq = log.maxSeq(nodeId) + 1;
    final entry = <String, dynamic>{'e': '$nodeId:$seq', 'o': nodeId, 's': seq, 'k': kind, 'at': _now(), 'd': data};
    log.add(entry);
    host.saveLog();
    _broadcast({'t': 'e', 'es': [entry]});
    _changed();
    return entry;
  }

  // ===== الأحداث من النقل =====
  void _onEvent(MeshEvent ev) {
    switch (ev.type) {
      case 'found':
        final parts = (ev.name ?? '').split('|');
        if (parts.length < 2 || parts[0] != protocol || parts[1] == nodeId) return;
        if (_links.values.any((l) => l.node == parts[1] || l.endpointId == ev.id)) return;
        _candidates[ev.id] = _now();
        _candidateNode[ev.id] = parts[1];
        // الجهاز الأصغر هو اللي بيطلب الاتصال (عشان الاتنين ميطلبوش في نفس اللحظة)
        if (nodeId.compareTo(parts[1]) < 0) _tryConnect(ev.id);
      case 'lost':
        _candidates.remove(ev.id);
      case 'initiated':
        final link = _links.putIfAbsent(ev.id, () => _Link(ev.id));
        final parts = (ev.name ?? '').split('|');
        if (parts.length >= 2 && parts[0] == protocol) link.node = parts[1];
        link.outgoing = ev.incoming == false;
        _candidates.remove(ev.id);
      case 'result':
        final link = _links[ev.id];
        if (link == null) return;
        if (ev.ok == true) {
          link.connected = true;
          link.lastRx = _now();
          _send(link, {'t': 'n', 'n': link.nonce});
        } else {
          _drop(ev.id);
        }
      case 'disconnected':
        _drop(ev.id);
      case 'bandwidth':
        final link = _links[ev.id];
        if (link != null) {
          link.quality = ev.quality ?? 0;
          final peer = link.node == null ? null : peers[link.node];
          if (peer != null) peer.quality = link.quality;
          _changed();
        }
      case 'payload':
        final link = _links[ev.id];
        if (link == null || ev.data == null) return;
        link.lastRx = _now();
        _receive(link, ev.data!);
      case 'error':
        lastProblem = ev.message ?? '';
        _changed();
    }
  }

  Future<void> _tryConnect(String endpointId) async {
    if (directCount + _links.values.where((l) => !l.authed).length >= maxDirect) return;
    _links.putIfAbsent(endpointId, () => _Link(endpointId)).node ??= _candidateNode[endpointId];
    _candidates.remove(endpointId);
    final ok = await transport.connect(endpointId);
    if (!ok) _links.remove(endpointId);
  }

  void _drop(String endpointId) {
    final link = _links.remove(endpointId);
    if (link?.node != null && !_links.values.any((l) => l.authed && l.node == link!.node)) {
      final peer = peers[link!.node];
      if (peer != null) {
        peer.direct = false;
        peer.quality = 0;
      }
    }
    _changed();
  }

  // ===== الرسايل =====
  final Map<String, int> _seenBeacons = {};

  void _receive(_Link link, Uint8List bytes) {
    Map<String, dynamic> msg;
    try {
      msg = (jsonDecode(utf8.decode(bytes)) as Map).cast<String, dynamic>();
    } catch (_) {
      return;
    }
    if (msg['t'] == '~') {
      final x = '${msg['x']}';
      final n = msg['n'] as int;
      final list = link.parts.putIfAbsent(x, () => List<String?>.filled(n, null));
      list[msg['i'] as int] = '${msg['d']}';
      if (list.any((p) => p == null)) return;
      link.parts.remove(x);
      try {
        final raw = gzip.decode(base64Decode(list.join()));
        msg = (jsonDecode(utf8.decode(raw)) as Map).cast<String, dynamic>();
      } catch (_) {
        return;
      }
    }
    _handle(link, msg);
  }

  void _handle(_Link link, Map<String, dynamic> msg) {
    final t = msg['t'];
    if (t == 'n') {
      link.peerNonce = '${msg['n']}';
      _sendHello(link);
      return;
    }
    if (t == 'h') {
      final node = '${msg['node']}';
      final proof = hmacHex(host.meshKey, 'h|$node|${link.nonce}');
      if (host.meshKey.isEmpty || msg['proof'] != proof || node == nodeId) {
        lastProblem = 'جهاز حاول يتوصل ومعهوش مفتاح الشبكة الصحيح';
        transport.disconnect(link.endpointId);
        _drop(link.endpointId);
        return;
      }
      // متوصلين بنفس الجهاز مرتين (الاتنين بدأوا الاتصال في نفس اللحظة): الطرفين لازم يسيبوا نفس الاتصال —
      // اللي بدأه الجهاز صاحب الرقم الأصغر
      final other = _links.values.where((l) => l != link && l.authed && l.node == node).firstOrNull;
      if (other != null) {
        final smaller = nodeId.compareTo(node) < 0 ? nodeId : node;
        final keepNew = (link.outgoing ? nodeId : node) == smaller;
        final loser = keepNew ? other : link;
        transport.disconnect(loser.endpointId);
        _links.remove(loser.endpointId);
        if (!keepNew) return;
      }
      link.node = node;
      link.authed = true;
      final peer = peers.putIfAbsent(node, () => MeshPeer(node));
      peer
        ..name = '${msg['name'] ?? ''}'
        ..user = '${msg['user'] ?? ''}'
        ..role = '${msg['role'] ?? ''}'
        ..direct = true
        ..hops = 1
        ..quality = link.quality
        ..snapAt = (msg['snapAt'] as int?) ?? 0
        ..pending = (msg['pending'] as int?) ?? 0
        ..lastSeen = _now();
      _send(link, {'t': 's', 'sum': log.summary()});
      // البيانات اللي عنده أحدث من اللي عندي بـ 5 دقايق أو أكتر: ناخدها
      if (peer.snapAt > host.snapshotAt + 5 * 60 * 1000) requestSnapshot(from: node);
      _changed();
      return;
    }
    if (!link.authed) return; // أي حاجة تانية لازم بعد التأكد من المفتاح
    final peer = peers[link.node];
    peer?.lastSeen = _now();
    switch (t) {
      case 's':
        final missing = log.missingFor((msg['sum'] as Map).cast<String, dynamic>());
        for (var i = 0; i < missing.length; i += 200) {
          _send(link, {'t': 'e', 'es': missing.sublist(i, min(i + 200, missing.length))});
        }
      case 'e':
        final added = <MeshEntry>[];
        for (final e in (msg['es'] as List? ?? [])) {
          if (e is Map && log.add(e.cast<String, dynamic>())) added.add(e.cast<String, dynamic>());
        }
        if (added.isNotEmpty) {
          host.onEntries(added);
          host.saveLog();
          _broadcast({'t': 'e', 'es': added}, except: link);
          _changed();
        }
      case 'b':
        _onBeacon(link, msg);
      case 'p':
        _send(link, {'t': 'q', 'x': msg['x']});
      case 'q':
        if (link.pingAt != null && msg['x'] == link.pingAt) {
          link.rtt = _now() - link.pingAt!;
          link.pingAt = null;
          peer?.rttMs = link.rtt;
          _changed();
        }
      case 'r':
        host.snapshotRaw().then((raw) {
          if (raw != null) _send(link, {'t': 'S', 'at': host.snapshotAt, 'raw': raw, 'from': host.displayName});
        });
      case 'S':
        final at = (msg['at'] as int?) ?? 0;
        _snapshotRequestedAt = null;
        if (at > host.snapshotAt && msg['raw'] is String) {
          host.onSnapshot(msg['raw'] as String, at, '${msg['from'] ?? peer?.name ?? ''}');
          _changed();
        }
    }
  }

  void _sendHello(_Link link) {
    if (link.peerNonce == null || link.helloSent) return;
    link.helloSent = true;
    _send(link, {
      't': 'h',
      'node': nodeId,
      'name': host.displayName,
      'user': host.userName,
      'role': host.role,
      'snapAt': host.snapshotAt,
      'pending': host.pendingCount,
      'proof': hmacHex(host.meshKey, 'h|$nodeId|${link.peerNonce}'),
    });
  }

  void _onBeacon(_Link from, Map<String, dynamic> msg) {
    final node = '${msg['node']}';
    final at = (msg['at'] as int?) ?? 0;
    if (node == nodeId || (_seenBeacons[node] ?? 0) >= at) return;
    _seenBeacons[node] = at;
    final hops = ((msg['hops'] as int?) ?? 0) + 1;
    final peer = peers.putIfAbsent(node, () => MeshPeer(node));
    peer
      ..name = '${msg['name'] ?? peer.name}'
      ..user = '${msg['user'] ?? peer.user}'
      ..role = '${msg['role'] ?? peer.role}'
      ..snapAt = (msg['snapAt'] as int?) ?? peer.snapAt
      ..pending = (msg['pending'] as int?) ?? peer.pending
      ..lastSeen = _now()
      ..beaconAt = at;
    if (!peer.direct) peer.hops = hops;
    _changed();
    if (hops < 8) _broadcast({...msg, 'hops': hops}, except: from);
  }

  /// "خد كل البيانات": نسخة البيانات من أحدث جهاز متوصل + أي عمليات ناقصة من كل الأجهزة
  bool requestSnapshot({String? from}) {
    final candidates = _links.values.where((l) => l.authed && (from == null || l.node == from)).toList()
      ..sort((a, b) => (peers[b.node]?.snapAt ?? 0).compareTo(peers[a.node]?.snapAt ?? 0));
    for (final link in _links.values.where((l) => l.authed)) {
      _send(link, {'t': 's', 'sum': log.summary()});
    }
    if (candidates.isEmpty) return false;
    _snapshotRequestedAt = _now();
    _send(candidates.first, {'t': 'r'});
    return true;
  }

  bool get snapshotInFlight => _snapshotRequestedAt != null && _now() - _snapshotRequestedAt! < 120 * 1000;

  void _broadcast(Map<String, dynamic> msg, {_Link? except}) {
    for (final link in _links.values.toList()) {
      if (link.authed && link != except) _send(link, msg);
    }
  }

  Future<void> _send(_Link link, Map<String, dynamic> msg) async {
    final bytes = utf8.encode(jsonEncode(msg));
    final limit = transport.maxBytes - 512;
    if (bytes.length <= limit) {
      await transport.send(link.endpointId, Uint8List.fromList(bytes));
      return;
    }
    final packed = base64Encode(gzip.encode(bytes));
    final size = limit - 200;
    final n = (packed.length / size).ceil();
    final x = _randomHex(6);
    for (var i = 0; i < n; i++) {
      final part = {'t': '~', 'x': x, 'i': i, 'n': n, 'd': packed.substring(i * size, min((i + 1) * size, packed.length))};
      final ok = await transport.send(link.endpointId, Uint8List.fromList(utf8.encode(jsonEncode(part))));
      if (!ok) return;
    }
  }

  // ===== الصيانة الدورية =====
  void maintain() {
    if (!running) return;
    _tick++;
    final now = _now();
    for (final link in _links.values.toList()) {
      if (link.authed && now - link.lastRx > 45 * 1000) {
        // مفيش رد من 45 ثانية: الاتصال مات
        transport.disconnect(link.endpointId);
        _drop(link.endpointId);
        continue;
      }
      if (!link.authed && now - link.lastRx > 30 * 1000) {
        transport.disconnect(link.endpointId);
        _drop(link.endpointId);
        continue;
      }
      if (link.authed && _tick % 2 == 0) {
        link.pingAt = now;
        _send(link, {'t': 'p', 'x': now});
      }
    }
    // اللاسلكي بيلاقي أجهزة: لو مفيش رد من الجهاز الأكبر بعد 15 ثانية نطلب احنا
    for (final entry in _candidates.entries.toList()) {
      if (now - entry.value > 15 * 1000) _tryConnect(entry.key);
    }
    // أحسن إشارة: لو الأماكن كاملة وفيه اتصال ضعيف وفيه أجهزة تانية متاحة، نسيب الضعيف
    if (_tick % 12 == 0 && directCount >= maxDirect && _candidates.isNotEmpty) {
      final weak = _links.values.where((l) => l.authed && (l.quality == 1 || (l.rtt ?? 0) > 2500)).toList();
      if (weak.isNotEmpty) {
        transport.disconnect(weak.first.endpointId);
        _drop(weak.first.endpointId);
      }
    }
    if (_tick % 4 == 0) {
      // نعرّف الكل بنفسنا (بيعدي من جهاز للتاني) + نقارن السجلات للتأكد إن مفيش حاجة وقعت
      _seenBeacons[nodeId] = now;
      _broadcast({
        't': 'b', 'node': nodeId, 'at': now, 'hops': 0, 'name': host.displayName, 'user': host.userName,
        'role': host.role, 'snapAt': host.snapshotAt, 'pending': host.pendingCount,
      });
    }
    if (_tick % 6 == 0) _broadcast({'t': 's', 'sum': log.summary()});
    _changed();
  }

  /// الأجهزة اللي اتشافت (مباشر أو عن طريق أجهزة تانية)، الأحدث الأول
  List<MeshPeer> visiblePeers() {
    final now = _now();
    final list = peers.values.where((p) => p.direct || now - p.lastSeen < 6 * 60 * 60 * 1000).toList()
      ..sort((a, b) {
        if (a.direct != b.direct) return a.direct ? -1 : 1;
        return b.lastSeen.compareTo(a.lastSeen);
      });
    return list;
  }

  bool isOnline(MeshPeer p) => p.direct || _now() - p.lastSeen < 90 * 1000;

  Future<void> dispose() async {
    await stop();
    await _changes.close();
  }
}
