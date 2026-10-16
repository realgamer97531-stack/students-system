// الموبايل (Dart) والكمبيوتر (desktop/runtime/mesh — JavaScript) بيتكلموا بالواي فاي على نفس الجهاز (loopback):
// اكتشاف UDP + اتصال TCP + التأكد من المفتاح + تبادل العمليات + نسخة البيانات الكبيرة.
// محتاج node على الجهاز (بيتخطى لو مش موجود).
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:studyisfunny_app/services/mesh/lan_transport.dart';
import 'package:studyisfunny_app/services/mesh/mesh_core.dart';

class _Host implements MeshHost {
  _Host(this.meshKey);
  @override
  final String meshKey;
  @override
  String get displayName => 'phone';
  @override
  String get userName => 'asst';
  @override
  String get role => 'مساعد';
  @override
  int snapshotAt = 0;
  String? raw;
  String? from;
  final received = <MeshEntry>[];
  @override
  Future<String?> snapshotRaw() async => raw;
  @override
  Future<void> onSnapshot(String r, int at, String fromName) async {
    raw = r;
    snapshotAt = at;
    from = fromName;
  }

  @override
  void onEntries(List<MeshEntry> added) => received.addAll(added);
  @override
  void saveLog() {}
  @override
  int get pendingCount => 0;
}

const _pcScript = r'''
const path = require('path');
const { MeshNode } = require(path.join(process.argv[2], 'desktop/runtime/mesh/core.js'));
const { LanTransport } = require(path.join(process.argv[2], 'desktop/runtime/mesh/lan.js'));
const big = JSON.stringify({ meshKey: 'K', students: Array.from({ length: 4000 }, (_, i) => [i, 'STU-' + i, 'طالب ' + i]) });
const host = { meshKey: 'K', displayName: 'PC-1', userName: '', role: 'كمبيوتر', snapshotAt: 9000000, pendingCount: 0, wantsSnapshots: false,
  snapshotRaw: async () => big, onSnapshot() {}, saveLog() {},
  onEntries(list) { for (const e of list) console.log('GOT ' + JSON.stringify(e.d)); } };
const node = new MeshNode(new LanTransport({ discoveryPort: 47931, probePorts: [47931, 47932], targets: ['127.0.0.1'], probeEveryMs: 300 }), host, { nodeId: 'pcA' });
node.start().then(() => {
  console.log('READY ' + big.length);
  setTimeout(() => node.publish('op', { id: 'from-pc', kind: 'attendance', sid: 9, ct: 5, user: 'PC', body: { student_code: 'STU-00007' } }), 1500);
});
setTimeout(() => process.exit(0), 20000);
''';

void main() {
  test('phone (Dart) and PC (JS) mesh over Wi-Fi sockets', () async {
    final root = Directory.current.parent.path; // mobile/.. = المشروع
    final script = File('${Directory.systemTemp.path}/sf_mesh_pc_${DateTime.now().microsecondsSinceEpoch}.js')..writeAsStringSync(_pcScript);
    Process pc;
    try {
      pc = await Process.start('node', [script.path, root]);
    } catch (_) {
      markTestSkipped('node is not installed');
      return;
    }
    final lines = <String>[];
    final ready = Completer<int>();
    pc.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((l) {
      lines.add(l);
      if (l.startsWith('READY ') && !ready.isCompleted) ready.complete(int.parse(l.substring(6)));
    });
    pc.stderr.transform(utf8.decoder).listen((l) => lines.add('ERR $l'));
    final bigLength = await ready.future.timeout(const Duration(seconds: 15));

    final host = _Host('K');
    final phone = MeshNode(
      LanTransport(discoveryPort: 47932, probePorts: [47931, 47932], targets: ['127.0.0.1'], probeEvery: const Duration(milliseconds: 300)),
      host,
      nodeId: 'zphone', // أكبر من pcA، فالكمبيوتر هو اللي بيبدأ الاتصال (زي الواقع)
    );
    await phone.start();
    phone.publish('op', {'id': 'from-phone', 'kind': 'attendance', 'sid': 9, 'ct': 6, 'user': 'Mona', 'body': {'student_code': 'STU-00007', 'payment_collected': 60}});

    for (var i = 0; i < 80 && (host.received.isEmpty || host.raw == null || !lines.any((l) => l.contains('from-phone'))); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    try {
      expect(phone.directCount, 1, reason: lines.join('\n'));
      expect(host.received.map((e) => e['d']['id']), contains('from-pc'));
      expect(lines.any((l) => l.startsWith('GOT ') && l.contains('from-phone')), isTrue, reason: lines.join('\n'));
      expect(host.raw?.length, bigLength, reason: 'phone took the full data copy from the PC');
      expect(host.from, 'PC-1');
      final st = computeStatuses(phone.log);
      expect(st['from-pc']!.state, OpState.pending);
      expect(st['from-phone']!.state, OpState.review, reason: 'same student+session after the PC, with money');
    } finally {
      await phone.dispose();
      pc.kill();
      script.deleteSync();
    }
  });
}
