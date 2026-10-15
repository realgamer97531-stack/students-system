// تشغيل شبكة الأجهزة أوفلاين جوه التطبيق: الراديو (Nearby) + ربطها ببيانات المسح (StaffStore) + الرفع.
import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../cache.dart';
import '../net.dart';
import '../session_store.dart';
import '../staff_api.dart';
import '../staff_store.dart';
import 'mesh_core.dart';

/// النقل الحقيقي: Google Nearby Connections (بلوتوث + Wi-Fi Direct) — الكود في MeshPlugin.kt
class NearbyTransport implements MeshTransport {
  static const _method = MethodChannel('sf/mesh');
  static const _events = EventChannel('sf/mesh/events');
  Stream<MeshEvent>? _stream;
  int _maxBytes = 32768;

  @override
  int get maxBytes => _maxBytes;

  @override
  Stream<MeshEvent> get events => _stream ??= _events.receiveBroadcastStream().map((raw) {
        final m = (raw as Map).cast<String, dynamic>();
        return MeshEvent(
          '${m['type']}',
          id: '${m['id'] ?? ''}',
          name: m['name'] as String?,
          data: m['data'] as Uint8List?,
          quality: (m['quality'] as num?)?.toInt(),
          ok: m['ok'] as bool?,
          incoming: m['incoming'] as bool?,
          message: m['message'] as String?,
        );
      }).asBroadcastStream();

  @override
  Future<void> start(String advertName) async {
    _maxBytes = (await _method.invokeMethod<int>('maxBytes')) ?? 32768;
    await _method.invokeMethod('start', {'name': advertName, 'serviceId': 'com.studyisfunny.mesh', 'notice': 'بيوصل البيانات بين أجهزة السنتر حتى من غير نت'});
  }

  @override
  Future<void> restart() => _method.invokeMethod('restart');
  @override
  Future<void> stop() => _method.invokeMethod('stop');
  @override
  Future<bool> connect(String endpointId) async => (await _method.invokeMethod<bool>('connect', {'id': endpointId})) ?? false;
  @override
  Future<void> disconnect(String endpointId) => _method.invokeMethod('disconnect', {'id': endpointId});
  @override
  Future<bool> send(String endpointId, Uint8List data) async => (await _method.invokeMethod<bool>('send', {'id': endpointId, 'data': data})) ?? false;
}

class MeshService implements MeshHost {
  MeshService._();
  static final instance = MeshService._();

  /// في الاختبارات: نقل وهمي
  static MeshTransport Function() transportFactory = NearbyTransport.new;

  MeshNode? _node;
  late String nodeId;
  MeshLog _log = MeshLog();
  StaffUser? _user;
  bool _loaded = false;
  Timer? _uploadTimer;
  Timer? _saveTimer;
  StreamSubscription<void>? _changesSub;

  final running = ValueNotifier<bool>(false);
  /// أي تغيير (أجهزة اتوصلت، عمليات وصلت...) — الشاشة بتسمع ده
  final revision = ValueNotifier<int>(0);
  final message = ValueNotifier<String>('');
  final uploading = ValueNotifier<bool>(false);
  Map<String, OpStatus> _statuses = {};
  bool _statusesDirty = true;

  MeshNode? get node => _node;
  String? get nodeIdOrNull => _loaded ? nodeId : null;
  MeshLog get log => _log;

  // ===== التحميل (بيحصل مع StaffStore.start حتى لو الشبكة مقفولة، عشان العمليات تتسجل في السجل) =====
  Future<void> load(StaffUser? user) async {
    _user = user;
    if (_loaded) {
      _uploadTimer ??= Timer.periodic(const Duration(seconds: 30), (_) => uploadForOthers());
      return;
    }
    _loaded = true;
    final prefs = await SharedPreferences.getInstance();
    var id = prefs.getString('mesh_node');
    if (id == null) {
      final r = Random.secure();
      id = List.generate(12, (_) => r.nextInt(36).toRadixString(36)).join();
      await prefs.setString('mesh_node', id);
    }
    nodeId = id;
    final saved = await Cache.read('mesh_log');
    _log = MeshLog.fromJson((saved?.data as Map?)?.cast<String, dynamic>());
    _statusesDirty = true;
    if (prefs.getBool('mesh_enabled') == true && await _permissionsGranted()) {
      unawaited(start());
    }
    _uploadTimer ??= Timer.periodic(const Duration(seconds: 30), (_) => uploadForOthers());
  }

  void _bump() {
    _statusesDirty = true;
    revision.value++;
  }

  // ===== تشغيل/إيقاف =====
  static List<Permission> get _permissions => [
        Permission.bluetoothScan,
        Permission.bluetoothAdvertise,
        Permission.bluetoothConnect,
        Permission.nearbyWifiDevices,
        Permission.locationWhenInUse,
      ];

  Future<bool> _permissionsGranted() async {
    for (final p in _permissions) {
      final s = await p.status;
      if (!(s.isGranted || s.isLimited)) {
        // الأذونات اللي مش موجودة في نسخة أندرويد دي بترجع "restricted/denied" دايمًا وده طبيعي
        if (p == Permission.nearbyWifiDevices || p == Permission.bluetoothScan || p == Permission.bluetoothAdvertise || p == Permission.bluetoothConnect) {
          if (s.isPermanentlyDenied) return false;
          if (s.isDenied && await p.request().then((x) => !(x.isGranted || x.isLimited))) return false;
          continue;
        }
        return false;
      }
    }
    return true;
  }

  /// بيطلب الأذونات (أول مرة) ويشغل الشبكة. بيرجع رسالة خطأ لو فيه مشكلة
  Future<String?> enable() async {
    if (meshKey.isEmpty) return 'لازم الموبايل ياخد بيانات المسح من السيرفر مرة (فيه نت) قبل ما يدخل الشبكة';
    final results = await _permissions.request();
    final denied = results.entries.where((e) => e.value.isPermanentlyDenied).toList();
    if (denied.isNotEmpty) {
      await openAppSettings();
      return 'لازم تسمح للتطبيق بالأجهزة القريبة والموقع من الإعدادات';
    }
    if (!(results[Permission.locationWhenInUse]?.isGranted ?? false)) return 'لازم تسمح بالموقع — Nearby محتاجه عشان يلاقي الأجهزة';
    await Permission.notification.request();
    if (!await Permission.locationWhenInUse.serviceStatus.isEnabled) {
      message.value = 'شغّل الـ Location (الموقع) من فوق — من غيره الاتصال بيقطع كتير';
    }
    (await SharedPreferences.getInstance()).setBool('mesh_enabled', true);
    return start();
  }

  Future<String?> start() async {
    if (_node?.running == true) return null;
    if (meshKey.isEmpty) return 'مفيش مفتاح شبكة لسه — افتح التطبيق مرة وفيه نت';
    _node = MeshNode(transportFactory(), this, nodeId: nodeId, log: _log);
    _changesSub = _node!.changes.listen((_) => _bump());
    try {
      await _node!.start();
      running.value = true;
      message.value = '';
      _bump();
      return null;
    } catch (e) {
      running.value = false;
      final text = '$e'.contains('8002') || '$e'.contains('MISSING_PERMISSION')
          ? 'ناقص إذن الأجهزة القريبة أو الموقع'
          : 'الشبكة مش راضية تشتغل: $e';
      message.value = text;
      return text;
    }
  }

  Future<void> disable() async {
    (await SharedPreferences.getInstance()).setBool('mesh_enabled', false);
    await stop();
  }

  Future<void> stop() async {
    await _changesSub?.cancel();
    _changesSub = null;
    await _node?.stop();
    _node = null;
    running.value = false;
    _bump();
  }

  Future<void> reconnect() async {
    if (_node == null) {
      await start();
      return;
    }
    await _node!.reconnect();
  }

  // ===== المضيف (MeshHost) =====
  @override
  String get meshKey => '${StaffStore.snapshot.value?.raw['meshKey'] ?? ''}';
  @override
  String get displayName => _user?.name.isNotEmpty == true ? _user!.name : 'جهاز';
  @override
  String get userName => _user?.username ?? '';
  @override
  String get role {
    final u = _user;
    if (u == null) return '';
    if (u.isAdmin) return 'أدمن';
    if (u.can('door_scan') && !u.can('attendance_scan')) return 'الباب';
    return 'مساعد';
  }

  @override
  int get snapshotAt => StaffStore.snapshotAt.value?.millisecondsSinceEpoch ?? 0;
  @override
  Future<String?> snapshotRaw() async => (await Cache.readRaw('snapshot'))?.$1;
  @override
  Future<void> onSnapshot(String raw, int at, String fromName) async {
    final ok = await StaffStore.adoptPeerSnapshot(raw, DateTime.fromMillisecondsSinceEpoch(at), fromName);
    if (ok) message.value = '✔ اتاخدت بيانات أحدث من $fromName';
  }

  @override
  void onEntries(List<MeshEntry> added) {
    _statusesDirty = true;
    StaffStore.applyMeshEntries(added.where((e) => e['o'] != nodeId).toList());
    // إيصال عملية من عندي اترفعت عن طريق جهاز تاني → تتشال من الطابور
    if (added.any((e) => e['k'] == 'rc')) unawaited(StaffStore.flushMeshUploaded());
  }

  @override
  void saveLog() {
    _statusesDirty = true;
    _saveTimer?.cancel();
    _saveTimer = Timer(const Duration(milliseconds: 600), () {
      _log.prune(DateTime.now().subtract(const Duration(days: 3)).millisecondsSinceEpoch, _isDone);
      Cache.write('mesh_log', _log.toJson());
    });
  }

  bool _isDone(MeshEntry e) {
    final k = e['k'];
    if (k == 'cfg') return false;
    if (k != 'op') return true;
    final s = statusOf('${e['d']?['id']}')?.state;
    return s != null && s != OpState.pending && s != OpState.review;
  }

  @override
  int get pendingCount => StaffStore.queue.value.length;

  // ===== حالة العمليات =====
  Map<String, OpStatus> get statuses {
    if (_statusesDirty) {
      _statuses = computeStatuses(_log, normalizeCode: normalizeStudentCode);
      _statusesDirty = false;
    }
    return _statuses;
  }

  OpStatus? statusOf(String opId) => statuses[opId];

  List<MeshEntry> get opEntries => _log.ofKind('op').toList()..sort((a, b) => ((b['d']['ct'] as num?) ?? 0).compareTo((a['d']['ct'] as num?) ?? 0));

  List<MeshEntry> get reviewItems => opEntries.where((e) => statusOf('${e['d']['id']}')?.state == OpState.review).toList();

  // ===== تسجيل عمليات الجهاز ده في السجل =====
  MeshEntry _publish(String kind, Map<String, dynamic> data) {
    if (_node != null) return _node!.publish(kind, data);
    final seq = _log.maxSeq(nodeId) + 1;
    final entry = <String, dynamic>{'e': '$nodeId:$seq', 'o': nodeId, 's': seq, 'k': kind, 'at': DateTime.now().millisecondsSinceEpoch, 'd': data};
    _log.add(entry);
    saveLog();
    _bump();
    return entry;
  }

  /// كل عملية مسح من الموبايل ده: بتتوقع بمفتاح الجهاز وتتبعت للشبكة (لو شغالة)
  Future<void> recordOwn(Map<String, dynamic> op) async {
    if (!_loaded) return;
    if (_log.entries.values.any((e) => e['k'] == 'op' && e['d']?['id'] == op['id'])) return;
    final local = op['kind'] == 'force';
    final body = Map<String, dynamic>.from(op['body'] as Map)..remove('password');
    final data = <String, dynamic>{
      'id': op['id'],
      'kind': op['kind'],
      'path': op['path'],
      'body': body,
      'userId': op['userId'],
      'sid': op['activeSessionId'],
      'ct': op['clientTime'],
      'label': op['label'],
      'user': displayName,
      if (local) 'local': true,
    };
    if (!local) {
      final token = await SessionStore.deviceToken();
      if (token != null) {
        final tokenHash = sha256.convert(utf8.encode(token)).toString();
        final p = jsonEncode([op['id'], op['path'], op['body'], op['userId'], op['activeSessionId'], op['clientTime']]);
        data['dev'] = sha256.convert(utf8.encode(tokenHash)).toString();
        data['p'] = p;
        data['sig'] = hmacHex(tokenHash, p);
      }
    }
    _publish('op', data);
  }

  /// نتيجة رفع عملية (من الجهاز ده أو بالنيابة عن جهاز تاني) — بتوصل لكل الأجهزة فمحدش يرفعها تاني
  void receipt(String opId, {required bool ok, String message = '', bool duplicate = false}) {
    if (!_loaded) return;
    final existing = statusOf(opId)?.state;
    if (existing == OpState.uploaded) return;
    _publish('rc', {'op': opId, 'ok': ok, 'msg': message, 'dup': duplicate, 'by': displayName});
  }

  void decide(String opId, String action) => _publish('dec', {'op': opId, 'action': action, 'by': displayName});

  // ===== الرافع =====
  String? get uploaderNode {
    MeshEntry? latest;
    for (final e in _log.ofKind('cfg')) {
      if (!(e['d'] as Map).containsKey('uploader')) continue;
      if (latest == null || (e['at'] as int) > (latest['at'] as int)) latest = e;
    }
    final v = latest?['d']?['uploader'];
    return v == null ? null : '$v';
  }

  bool get isUploader => _loaded && uploaderNode == nodeId;

  void setUploader(String? node) => _publish('cfg', {'uploader': node, 'by': displayName});

  /// الرافع: بيرفع عمليات الأجهزة التانية (بعد تصفية المكرر هنا على الموبايل)
  Future<int> uploadForOthers({bool force = false}) async {
    if (!_loaded || uploading.value) return 0;
    if (!isUploader && !force) return 0;
    if (!Connection.online.value && !force) return 0;
    final pending = _log.ofKind('op').where((e) {
      final d = e['d'] as Map;
      return e['o'] != nodeId && d['local'] != true && d['sig'] != null && statusOf('${d['id']}')?.state == OpState.pending;
    }).toList()
      ..sort((a, b) => ((a['d']['ct'] as num?) ?? 0).compareTo((b['d']['ct'] as num?) ?? 0));
    if (pending.isEmpty) return 0;
    uploading.value = true;
    var sent = 0;
    try {
      for (var i = 0; i < pending.length; i += 100) {
        final batch = pending.sublist(i, min(i + 100, pending.length));
        final results = await StaffApi.relay([
          for (final e in batch) {'id': e['d']['id'], 'dev': e['d']['dev'], 'p': e['d']['p'], 'sig': e['d']['sig']},
        ]);
        Connection.report(true);
        for (final r in results) {
          if (r['retry'] == true) continue;
          receipt('${r['id']}', ok: r['ok'] == true, message: '${r['message'] ?? ''}', duplicate: r['duplicate'] == true);
          sent++;
        }
      }
    } on ApiException catch (e) {
      if (e.offline) Connection.report(false);
      message.value = 'الرفع وقف: ${e.message}';
    } catch (e) {
      message.value = 'الرفع وقف: $e';
    } finally {
      uploading.value = false;
      _bump();
    }
    return sent;
  }

  /// شاشة الموظف اتقفلت (خروج/تغيير حساب): نحفظ السجل حالًا ونوقف المؤقتات والراديو
  Future<void> detach() async {
    _uploadTimer?.cancel();
    _uploadTimer = null;
    if (_saveTimer?.isActive ?? false) {
      _saveTimer!.cancel();
      await Cache.write('mesh_log', _log.toJson());
    }
    _saveTimer = null;
    await stop();
  }

  /// للاختبارات
  @visibleForTesting
  Future<void> resetForTests() async {
    await stop();
    _loaded = false;
    _log = MeshLog();
    _uploadTimer?.cancel();
    _uploadTimer = null;
    _statusesDirty = true;
  }
}
