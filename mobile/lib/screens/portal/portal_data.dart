import 'package:flutter/foundation.dart';

import '../../services/api.dart';
import '../../services/cache.dart';
import '../../services/net.dart';
import '../../services/session_store.dart';

/// بيانات الطالب الأساسية (البروفايل + الحصص + المعاملات + الـ QR + الترتيب).
/// بتتعرض من النسخة المحفوظة على طول، وبتتحدث من السيرفر لما يكون فيه نت.
class PortalData extends ChangeNotifier {
  PortalData(this.type, {required this.onUnauthorized});
  final AccountType type;
  final VoidCallback onUnauthorized;

  Map<String, dynamic>? data;
  String? qrSvg;
  Map<String, dynamic>? rank;
  DateTime? savedAt;
  bool loading = true;
  bool stale = false;
  String? error;

  bool get isStudent => type == AccountType.student;
  Map<String, dynamic> get student => (data?['student'] as Map?)?.cast<String, dynamic>() ?? {};
  List<Map<String, dynamic>> get sessions => ((data?['sessions'] as List?) ?? []).cast<Map<String, dynamic>>();
  List<Map<String, dynamic>> get transactions => ((data?['transactions'] as List?) ?? []).cast<Map<String, dynamic>>();

  Future<void> start() async {
    final cached = await Cache.read('data');
    if (cached != null) {
      data = (cached.data as Map).cast<String, dynamic>();
      savedAt = cached.savedAt;
      stale = true;
    }
    if (isStudent) {
      qrSvg = (await Cache.read('qr'))?.data as String?;
      rank = ((await Cache.read('leaderboard'))?.data as Map?)?.cast<String, dynamic>();
    }
    notifyListeners();
    Connection.online.addListener(_onConnection);
    await refresh();
  }

  void _onConnection() {
    if (Connection.online.value && stale) refresh();
  }

  bool _disposed = false;

  @override
  void dispose() {
    _disposed = true;
    Connection.online.removeListener(_onConnection);
    super.dispose();
  }

  @override
  void notifyListeners() {
    if (!_disposed) super.notifyListeners();
  }

  Future<void> refresh() async {
    loading = data == null;
    error = null;
    notifyListeners();
    try {
      final fresh = await PortalApi.studentData(type);
      data = fresh;
      savedAt = DateTime.now();
      stale = false;
      await Cache.write('data', fresh);
      if (isStudent) {
        // الـ QR مهم يفضل محفوظ عشان الطالب يورّيه في السنتر حتى لو مفيش نت
        try {
          final qr = await PortalApi.qrSvg();
          if (qr != null) {
            qrSvg = qr;
            await Cache.write('qr', qr);
          }
        } catch (_) {}
        try {
          rank = await PortalApi.leaderboard();
          await Cache.write('leaderboard', rank);
        } catch (_) {}
      }
    } on ApiException catch (e) {
      if (e.unauthorized) {
        onUnauthorized();
        return;
      }
      error = e.message;
      stale = true;
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  /// بعد الشحن أو تغيير الصورة
  void patchStudent(Map<String, dynamic> changes) {
    if (data == null) return;
    data = {...data!, 'student': {...student, ...changes}};
    Cache.write('data', data);
    notifyListeners();
  }
}
