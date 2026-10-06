import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config.dart';
import 'net.dart';
import 'session_store.dart';
import 'updater.dart';

/// الجهاز اتلغى تسجيله من السيستم (/admin/sync-devices)
class DeviceNotAuthorized implements Exception {
  @override
  String toString() => 'الموبايل ده مش متسجل في السيستم أو اتلغى تسجيله — لازم أدمن يسجله تاني';
}

/// نتيجة عملية اتبعتت للسيرفر
class OpResult {
  OpResult({required this.ok, required this.message, required this.data, this.duplicate = false});
  final bool ok;
  final String message;
  final Map<String, dynamic> data;
  final bool duplicate;
}

/// الكلام مع السيستم من موبايل الموظف.
/// الموبايل "جهاز متسجل" زي برنامج الديسكتوب بالظبط: كل عملية بتتبعت لنفس صفحات السيستم
/// باسم الموظف وفي الحصة اللي كانت مختارة وقتها، وكل عملية ليها رقم ثابت فمستحيل تتسجل مرتين.
class StaffApi {
  static http.Client get client => Net.client;
  static Uri _uri(String path) => Uri.parse('${AppConfig.staffWebBase}$path');

  static Future<String> registerDevice(String username, String password, String deviceName) async {
    final version = await Updater.currentVersion().catchError((_) => '');
    final body = await Net.json(() => client.post(
          _uri('/api/sync/register-device'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'username': username, 'password': password, 'device_name': deviceName, 'app_version': 'mobile $version'}),
        ));
    return body['token'] as String;
  }

  static Future<Map<String, String>> _deviceHeaders() async {
    final token = await SessionStore.deviceToken();
    if (token == null) throw DeviceNotAuthorized();
    return {'X-Sync-Device-Token': token, 'Accept': 'application/json'};
  }

  static Future<Map<String, dynamic>> _deviceJson(Future<http.Response> Function() request) async {
    final response = await Net.raw(request);
    if (response.statusCode == 401) {
      final body = Net.decode(response);
      if (body['code'] == 'DEVICE_NOT_AUTHORIZED') throw DeviceNotAuthorized();
      throw ApiException('${body['message'] ?? 'غير مسموح'}', unauthorized: true, status: 401);
    }
    final body = Net.decode(response);
    if (response.statusCode >= 500) throw ApiException('${body['message'] ?? 'السيرفر مش متاح دلوقتي'}', offline: true, status: response.statusCode);
    if (response.statusCode >= 400 || body['success'] == false) {
      throw ApiException('${body['message'] ?? 'حصلت مشكلة (${response.statusCode})'}', status: response.statusCode);
    }
    return body;
  }

  /// يتأكد من يوزر وباسورد الموظف ويرجع بياناته وصلاحياته
  static Future<StaffUser> login(String username, String password) async {
    final headers = await _deviceHeaders();
    final body = await _deviceJson(() => client.post(
          _uri('/api/sync/mobile/staff-login'),
          headers: {...headers, 'Content-Type': 'application/json'},
          body: jsonEncode({'username': username, 'password': password}),
        ));
    return StaffUser.fromJson({...(body['user'] as Map).cast<String, dynamic>(), 'username': username});
  }

  /// نسخة المسح أوفلاين: الحصص الأخيرة + الطلاب + حضورهم وواجبهم
  static Future<Map<String, dynamic>> snapshot() async {
    final headers = await _deviceHeaders();
    return _deviceJson(() => client.get(_uri('/api/sync/mobile/snapshot'), headers: headers).timeout(const Duration(seconds: 60)));
  }

  /// طلب لصفحة من السيستم باسم الموظف.
  /// opId: للعمليات اللي بتكتب (بتتسجل على السيرفر ومستحيل تتكرر). من غيره: طلب قراءة عادي.
  static Future<OpResult> call(
    String path,
    Map<String, dynamic> body, {
    required int userId,
    int? activeSessionId,
    String? opId,
    DateTime? clientTime,
  }) async {
    final headers = await _deviceHeaders();
    final context = base64Encode(utf8.encode(jsonEncode({
      'userId': userId,
      'activeSessionId': ?activeSessionId,
      'clientTime': (clientTime ?? DateTime.now()).millisecondsSinceEpoch,
    })));
    final response = await Net.raw(() => client.post(
          _uri(path),
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            'X-Sync-Context': context,
            'X-Sync-Op-Id': ?opId,
          },
          body: jsonEncode(body),
        ));
    final json = Net.decode(response);
    if (response.statusCode == 401 && json['code'] == 'DEVICE_NOT_AUTHORIZED') throw DeviceNotAuthorized();
    if (response.statusCode == 409) {
      // العملية لسه بتتنفذ على السيرفر (OP_IN_PROGRESS) أو اتعلقت (OP_STUCK)
      if (json['code'] == 'OP_STUCK') return OpResult(ok: false, message: '${json['message']}', data: json);
      throw ApiException('${json['message'] ?? 'العملية لسه بتتنفذ'}', offline: true, status: 409);
    }
    if (response.statusCode >= 500) throw ApiException('${json['message'] ?? 'السيرفر مش متاح دلوقتي'}', offline: true, status: response.statusCode);
    if (json['envelope'] == true) {
      Map<String, dynamic> inner = {};
      try {
        final decoded = jsonDecode('${json['body'] ?? ''}');
        if (decoded is Map) inner = decoded.cast<String, dynamic>();
      } catch (_) {}
      final ok = json['ok'] == true;
      return OpResult(
        ok: ok,
        message: '${inner['message'] ?? json['message'] ?? (ok ? 'تم' : 'السيرفر رفض العملية')}',
        data: inner,
        duplicate: json['duplicate'] == true,
      );
    }
    final ok = response.statusCode < 400 && json['success'] != false;
    return OpResult(ok: ok, message: '${json['message'] ?? ''}', data: json);
  }
}
