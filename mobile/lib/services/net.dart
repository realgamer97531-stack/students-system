import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

/// خطأ برسالة جاهزة تتعرض للمستخدم
class ApiException implements Exception {
  ApiException(this.message, {this.unauthorized = false, this.offline = false, this.status});
  final String message;
  final bool unauthorized;

  /// مفيش نت أو السيرفر مش بيرد — العملية ممكن تتعاد بعدين
  final bool offline;
  final int? status;
  @override
  String toString() => message;
}

const offlineMessage = 'مفيش اتصال بالإنترنت — اتأكد من النت وجرب تاني';

/// بيبعت الطلب ويرجع الرد كـ JSON، وبيحوّل أي مشكلة لرسالة مفهومة
class Net {
  static const timeout = Duration(seconds: 25);

  /// بيتبدل في الاختبارات بردود جاهزة
  static http.Client client = http.Client();

  static Future<http.Response> raw(Future<http.Response> Function() request, {Duration? limit}) async {
    try {
      return await request().timeout(limit ?? timeout);
    } on SocketException {
      throw ApiException(offlineMessage, offline: true);
    } on HttpException {
      throw ApiException(offlineMessage, offline: true);
    } on http.ClientException {
      throw ApiException(offlineMessage, offline: true);
    } on TimeoutException {
      throw ApiException('السيرفر مش بيرد دلوقتي — جرب تاني بعد شوية', offline: true);
    } on HandshakeException {
      throw ApiException(offlineMessage, offline: true);
    }
  }

  static Map<String, dynamic> decode(http.Response response) {
    try {
      final body = jsonDecode(utf8.decode(response.bodyBytes));
      if (body is Map<String, dynamic>) return body;
    } catch (_) {}
    if (response.statusCode >= 500 || response.statusCode == 404) {
      throw ApiException('السيرفر مش متاح دلوقتي (${response.statusCode}) — جرب تاني بعد شوية', offline: true, status: response.statusCode);
    }
    throw ApiException('رد غير متوقع من السيرفر (${response.statusCode})', status: response.statusCode);
  }

  /// طلب JSON عادي: بيرمي ApiException لو success = false
  static Future<Map<String, dynamic>> json(Future<http.Response> Function() request, {Duration? limit}) async {
    final response = await raw(request, limit: limit);
    final body = decode(response);
    if (response.statusCode == 401) {
      throw ApiException(body['message']?.toString() ?? 'لازم تسجل دخول تاني', unauthorized: true, status: 401);
    }
    if (response.statusCode >= 500) {
      throw ApiException(body['message']?.toString() ?? 'السيرفر مش متاح دلوقتي', offline: true, status: response.statusCode);
    }
    if (response.statusCode >= 400 || body['success'] == false) {
      throw ApiException(body['message']?.toString() ?? 'حصلت مشكلة (${response.statusCode})', status: response.statusCode);
    }
    return body;
  }
}

/// حالة الاتصال بالنت — الشاشات بتسمع لها عشان تحدّث نفسها وتبعت العمليات المتأجلة لما النت يرجع
class Connection {
  static final online = ValueNotifier<bool>(true);
  static StreamSubscription<List<ConnectivityResult>>? _sub;

  static Future<void> start() async {
    if (_sub != null) return;
    try {
      final connectivity = Connectivity();
      _apply(await connectivity.checkConnectivity());
      _sub = connectivity.onConnectivityChanged.listen(_apply);
    } catch (_) {
      // في الاختبارات مفيش plugin — نعتبر النت موجود
    }
  }

  static void _apply(List<ConnectivityResult> results) {
    online.value = results.any((r) => r != ConnectivityResult.none);
  }

  /// لما طلب يفشل بسبب النت بنعلّم إننا أوفلاين، ولما ينجح بنعلّم إننا أونلاين
  static void report(bool ok) {
    if (online.value != ok) online.value = ok;
  }
}
