import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import '../config.dart';
import 'session_store.dart';

/// خطأ برسالة جاهزة تتعرض للمستخدم
class ApiException implements Exception {
  ApiException(this.message, {this.unauthorized = false});
  final String message;
  final bool unauthorized;
  @override
  String toString() => message;
}

/// الكلام مع API بوابة الطالب/ولي الأمر الموجودة على السيرفر
class PortalApi {
  static const _timeout = Duration(seconds: 25);

  /// بيتبدل في الاختبارات بردود جاهزة
  static http.Client client = http.Client();

  static Future<Map<String, dynamic>> _send(Future<http.Response> Function() request) async {
    http.Response response;
    try {
      response = await request().timeout(_timeout);
    } on SocketException {
      throw ApiException('مفيش اتصال بالإنترنت — اتأكد من النت وجرب تاني');
    } on HttpException {
      throw ApiException('مفيش اتصال بالإنترنت — اتأكد من النت وجرب تاني');
    } on Exception {
      throw ApiException('السيرفر مش بيرد دلوقتي — جرب تاني بعد شوية');
    }
    Map<String, dynamic> body;
    try {
      body = jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
    } catch (_) {
      throw ApiException('رد غير متوقع من السيرفر (${response.statusCode})');
    }
    if (response.statusCode == 401) {
      throw ApiException(body['message']?.toString() ?? 'لازم تسجل دخول تاني', unauthorized: true);
    }
    if (response.statusCode >= 400 || body['success'] == false) {
      throw ApiException(body['message']?.toString() ?? 'حصلت مشكلة (${response.statusCode})');
    }
    return body;
  }

  static Future<Map<String, String>> _authHeaders() async {
    final token = await SessionStore.token();
    return {'Authorization': 'Bearer $token', 'Accept': 'application/json'};
  }

  static Uri _uri(String path) => Uri.parse('${AppConfig.apiBase}$path');

  /// دخول الطالب: رقم تليفون الطالب + الكود
  static Future<String> studentLogin(String phone, String code) async {
    final body = await _send(() => client.post(
          _uri('/api/portal/student-login'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'phone': phone, 'student_code': code}),
        ));
    return body['token'] as String;
  }

  /// دخول ولي الأمر: رقم تليفون ولي الأمر + كود الطالب
  static Future<String> parentLogin(String parentPhone, String code) async {
    final body = await _send(() => client.post(
          _uri('/api/portal/parent-login'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'parent_phone': parentPhone, 'student_code': code}),
        ));
    return body['token'] as String;
  }

  /// كل بيانات الطالب (البروفايل + الحصص + المعاملات...)
  static Future<Map<String, dynamic>> studentData(AccountType type) async {
    final path = type == AccountType.parent ? '/api/portal/parent/data' : '/api/portal/student/data';
    final headers = await _authHeaders();
    final body = await _send(() => client.get(_uri(path), headers: headers));
    return body['data'] as Map<String, dynamic>;
  }

  /// صورة الـ QR بتاعة الطالب (SVG)
  static Future<String?> qrSvg() async {
    final headers = await _authHeaders();
    final body = await _send(() => client.get(_uri('/api/portal/student/qrcode'), headers: headers));
    final dataUrl = body['qrCodeImage'] as String?;
    if (dataUrl == null || !dataUrl.contains('base64,')) return null;
    return utf8.decode(base64Decode(dataUrl.split('base64,').last));
  }

  /// ترتيب الطالب بين زمايله في النقط
  static Future<Map<String, dynamic>> leaderboard() async {
    final headers = await _authHeaders();
    return _send(() => client.get(_uri('/api/portal/leaderboard'), headers: headers));
  }
}
