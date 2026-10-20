import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studyisfunny_app/services/mesh/mesh_core.dart';

/// راديو وهمي: كل جهاز بيشوف بس الأجهزة اللي "جنبه" (زي البلوتوث)
class FakeAir {
  final Map<String, FakeTransport> radios = {};
  final Set<String> inRange = {};
  String _pair(String a, String b) => a.compareTo(b) < 0 ? '$a|$b' : '$b|$a';

  void near(String a, String b) {
    inRange.add(_pair(a, b));
    radios[a]!._found(b);
    radios[b]!._found(a);
  }

  void apart(String a, String b) {
    inRange.remove(_pair(a, b));
    radios[a]!._lostLink(b);
    radios[b]!._lostLink(a);
  }

  bool canTalk(String a, String b) => inRange.contains(_pair(a, b));
}

class FakeTransport implements MeshTransport {
  FakeTransport(this.air, this.me, {this.maxBytes = 4000}) {
    air.radios[me] = this;
  }
  final FakeAir air;
  final String me;
  @override
  final int maxBytes;
  String advert = '';
  bool on = false;
  final Set<String> connected = {};
  final _events = StreamController<MeshEvent>.broadcast();
  int sentBytes = 0;

  @override
  Stream<MeshEvent> get events => _events.stream;
  void _emit(MeshEvent e) => scheduleMicrotask(() => _events.add(e));

  void _found(String other) {
    final o = air.radios[other]!;
    if (on && o.on) _emit(MeshEvent('found', id: other, name: o.advert));
  }

  void _lostLink(String other) {
    if (connected.remove(other)) _emit(MeshEvent('disconnected', id: other));
  }

  @override
  Future<void> start(String advertName) async {
    advert = advertName;
    on = true;
    for (final o in air.radios.values) {
      if (o != this && air.canTalk(me, o.me) && o.on) {
        _found(o.me);
        o._found(me);
      }
    }
  }

  @override
  Future<void> restart() async {}
  @override
  Future<void> stop() async {
    on = false;
    for (final o in connected.toList()) {
      air.radios[o]!._lostLink(me);
    }
    connected.clear();
  }

  @override
  Future<bool> connect(String endpointId) async {
    final o = air.radios[endpointId];
    if (o == null || !air.canTalk(me, endpointId) || !o.on) return false;
    connected.add(endpointId);
    o.connected.add(me);
    _emit(MeshEvent('initiated', id: endpointId, name: o.advert, incoming: false));
    o._emit(MeshEvent('initiated', id: me, name: advert, incoming: true));
    _emit(MeshEvent('result', id: endpointId, ok: true));
    o._emit(MeshEvent('result', id: me, ok: true));
    return true;
  }

  @override
  Future<void> disconnect(String endpointId) async {
    if (connected.remove(endpointId)) {
      air.radios[endpointId]?._lostLink(me);
    }
  }

  @override
  Future<bool> send(String endpointId, Uint8List data) async {
    if (!connected.contains(endpointId)) return false;
    expect(data.length, lessThanOrEqualTo(maxBytes), reason: 'payload too big for the radio');
    sentBytes += data.length;
    air.radios[endpointId]!._emit(MeshEvent('payload', id: me, data: data));
    return true;
  }
}

class FakeHost implements MeshHost {
  FakeHost(this.displayName, {this.meshKey = 'k1', this.snapshotAt = 0, this.raw});
  @override
  final String meshKey;
  @override
  final String displayName;
  @override
  String get userName => 'user-$displayName';
  @override
  String get role => 'مساعد';
  @override
  int snapshotAt;
  String? raw;
  String? gotFrom;
  final List<MeshEntry> received = [];
  @override
  Future<String?> snapshotRaw() async => raw;
  @override
  Future<void> onSnapshot(String r, int at, String fromName) async {
    raw = r;
    snapshotAt = at;
    gotFrom = fromName;
  }

  @override
  void onEntries(List<MeshEntry> added) => received.addAll(added);
  @override
  void saveLog() {}
  @override
  int get pendingCount => 0;
}

Future<void> settle([int rounds = 30]) async {
  for (var i = 0; i < rounds; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

Map<String, dynamic> att(String id, String code, int sid, int ct, {String user = 'x', num pay = 0}) => {
      'id': id, 'kind': 'attendance', 'path': '/attendance/scan', 'sid': sid, 'ct': ct, 'user': user,
      'body': {'student_code': code, 'payment_collected': pay},
    };

void main() {
  test('scans hop across a chain A-B-C-D and receipts come back', () async {
    final air = FakeAir();
    final hosts = {for (final n in ['a', 'b', 'c', 'd']) n: FakeHost(n)};
    final nodes = {for (final n in ['a', 'b', 'c', 'd']) n: MeshNode(FakeTransport(air, n), hosts[n]!, nodeId: n)};
    for (final n in nodes.values) {
      await n.start();
    }
    air.near('a', 'b');
    air.near('b', 'c');
    air.near('c', 'd');
    await settle();
    expect(nodes['a']!.directCount, 1);
    expect(nodes['b']!.directCount, 2);

    nodes['a']!.publish('op', att('op1', 'STU-00001', 7, 1000, user: 'Ahmed'));
    await settle();
    expect(hosts['d']!.received.map((e) => e['d']['id']), ['op1']);

    // d بقى فيه نت ورفع: الإيصال يرجع لحد a
    nodes['d']!.publish('rc', {'op': 'op1', 'ok': true, 'msg': 'تم'});
    await settle();
    expect(computeStatuses(nodes['a']!.log)['op1']!.state, OpState.uploaded);

    // كل الأجهزة شايفة بعض (حتى اللي مش جنبها مباشرة) بعد الإعلانات الدورية
    for (final n in nodes.values) {
      n.maintain();
      n.maintain();
      n.maintain();
      n.maintain();
    }
    await settle(60);
    final seenByA = nodes['a']!.visiblePeers().map((p) => p.node).toSet();
    expect(seenByA, {'b', 'c', 'd'});
    expect(nodes['a']!.peers['d']!.hops, 3);
    for (final n in nodes.values) {
      await n.dispose();
    }
  });

  test('devices that were apart catch up when they meet (anti-entropy)', () async {
    final air = FakeAir();
    final ha = FakeHost('a'), hb = FakeHost('b');
    final a = MeshNode(FakeTransport(air, 'a'), ha, nodeId: 'a');
    final b = MeshNode(FakeTransport(air, 'b'), hb, nodeId: 'b');
    await a.start();
    await b.start();
    for (var i = 0; i < 50; i++) {
      a.publish('op', att('a$i', 'STU-0000$i', 1, i));
    }
    b.publish('op', att('b0', 'STU-00099', 1, 5));
    air.near('a', 'b');
    await settle(80);
    expect(a.log.entries.length, 51);
    expect(b.log.entries.length, 51);
    expect(hb.received.length, 50);
    await a.dispose();
    await b.dispose();
  });

  test('a device without the right network key is refused', () async {
    final air = FakeAir();
    final good = FakeHost('a');
    final bad = FakeHost('x', meshKey: 'wrong');
    final a = MeshNode(FakeTransport(air, 'a'), good, nodeId: 'a');
    final x = MeshNode(FakeTransport(air, 'x'), bad, nodeId: 'x');
    await a.start();
    await x.start();
    a.publish('op', att('secret', 'STU-00001', 1, 1));
    air.near('a', 'x');
    await settle(60);
    expect(a.directCount, 0);
    expect(x.log.entries, isEmpty);
    expect(a.lastProblem, contains('مفتاح'));
    await a.dispose();
    await x.dispose();
  });

  test('door device takes the full data copy in chunks from the newest peer', () async {
    final air = FakeAir();
    final big = jsonEncode({'students': [for (var i = 0; i < 3000; i++) [i, 'STU-$i', 'طالب رقم $i', 1, 2, 100, 90, 0, null]]});
    final source = FakeHost('assistant', snapshotAt: 2000000, raw: big);
    final door = FakeHost('door', snapshotAt: 0);
    final s = MeshNode(FakeTransport(air, 's', maxBytes: 4000), source, nodeId: 's');
    final d = MeshNode(FakeTransport(air, 'd', maxBytes: 4000), door, nodeId: 'd');
    await s.start();
    await d.start();
    air.near('s', 'd');
    await settle(400);
    // اتاخدت لوحدها لأن بياناته أحدث
    expect(door.raw, big);
    expect(door.snapshotAt, 2000000);
    expect(door.gotFrom, 'assistant');
    await s.dispose();
    await d.dispose();
  });

  test('duplicates: second attendance dropped, second with money goes to review, decisions apply', () {
    final log = MeshLog();
    var seq = 0;
    void add(String origin, String kind, Map<String, dynamic> d, {int at = 0}) {
      seq++;
      log.add({'e': '$origin:$seq', 'o': origin, 's': seq, 'k': kind, 'at': at, 'd': d});
    }

    add('a', 'op', att('first', 'stu-00001', 7, 100, user: 'Ahmed'));
    add('b', 'op', att('second', 'STU-00001', 7, 200, user: 'Mona'));
    add('c', 'op', att('paid', 'STU-00001', 7, 300, user: 'Sara', pay: 90));
    add('a', 'op', att('other-session', 'STU-00001', 8, 400));
    add('a', 'op', {'id': 'hw1', 'kind': 'homework', 'sid': 7, 'ct': 10, 'body': {'student_code': 'STU-00002', 'status': 'done'}});
    add('b', 'op', {'id': 'hw2', 'kind': 'homework', 'sid': 7, 'ct': 20, 'body': {'student_code': 'STU-00002', 'status': 'done'}});
    add('b', 'op', {'id': 'hw3', 'kind': 'homework', 'sid': 7, 'ct': 30, 'body': {'student_code': 'STU-00002', 'status': 'partial'}});

    var st = computeStatuses(log);
    expect(st['first']!.state, OpState.pending);
    expect(st['second']!.state, OpState.duplicate);
    expect(st['second']!.message, contains('Ahmed'));
    expect(st['paid']!.state, OpState.review);
    expect(st['other-session']!.state, OpState.pending);
    expect(st['hw1']!.state, OpState.pending);
    expect(st['hw2']!.state, OpState.duplicate);
    expect(st['hw3']!.state, OpState.pending);

    // السيرفر رفض الأولى → التانية تبقى هي الأساسية
    add('z', 'rc', {'op': 'first', 'ok': false, 'msg': 'رصيد غير كافي'});
    st = computeStatuses(log);
    expect(st['first']!.state, OpState.rejected);
    expect(st['second']!.state, OpState.pending);
    expect(st['paid']!.state, OpState.review);

    // الأدمن قرر يرفع اللي معاها فلوس
    add('z', 'dec', {'op': 'paid', 'action': 'upload'}, at: 5);
    expect(computeStatuses(log)['paid']!.state, OpState.pending);
    add('z', 'dec', {'op': 'paid', 'action': 'dismiss'}, at: 9);
    expect(computeStatuses(log)['paid']!.state, OpState.dismissed);
  });

  test('scan signature matches what the server computes (Node crypto)', () {
    // نفس الحسبة اللي في MeshService.recordOwn، والأرقام المتوقعة طالعة من Node (utils/sync/mesh.js)
    final tokenHash = sha256.convert(utf8.encode('device-token-123')).toString();
    final p = jsonEncode(['m-1', '/attendance/scan', {'student_code': 'STU-00001', 'payment_collected': 90, 'note': 'محمد'}, 2, 9, 1700000000000]);
    expect(p, '["m-1","/attendance/scan",{"student_code":"STU-00001","payment_collected":90,"note":"محمد"},2,9,1700000000000]');
    expect(sha256.convert(utf8.encode(tokenHash)).toString(), 'ee893942728540003c3aaacb9bc38bdc13454848914af7e5eaf9b071fbb91b9a');
    expect(hmacHex(tokenHash, p), '1112c7829dd849aa02ae482b5612316c55bb6acd89cd616c38b92b05b7e82ee3');
  });

  test('log survives save/load and pruning keeps the summary correct', () {
    final log = MeshLog();
    for (var i = 1; i <= 5; i++) {
      log.add({'e': 'a:$i', 'o': 'a', 's': i, 'k': 'op', 'at': i * 10, 'd': {'id': 'x$i'}});
    }
    log.prune(35, (_) => true); // 1..3 قديمة
    expect(log.entries.length, 2);
    expect(log.summary()['a'], 5);
    final again = MeshLog.fromJson(jsonDecode(jsonEncode(log.toJson())) as Map<String, dynamic>);
    expect(again.summary()['a'], 5);
    expect(again.add({'e': 'a:2', 'o': 'a', 's': 2, 'k': 'op', 'at': 0, 'd': {}}), isFalse, reason: 'old entries are not re-added');
    expect(again.missingFor({'a': 3}).map((e) => e['s']), [4, 5]);
  });

  test('PC Wi-Fi name/password match the desktop program (core.js pcWifiCredentials)', () {
    final c = pcWifiCredentials('test-key-123')!;
    expect(c.ssid, 'SF-64808A');
    expect(c.password, '4c40cbaae5fe77ea');
    expect(pcWifiCredentials(''), isNull);
  });
}
