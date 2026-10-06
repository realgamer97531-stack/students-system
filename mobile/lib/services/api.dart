import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import '../config.dart';
import 'net.dart';
import 'session_store.dart';

export 'net.dart' show ApiException;

/// الكلام مع API بوابة الطالب/ولي الأمر الموجودة على السيرفر (نفس اللي الموقع بيستخدمه بالظبط)
class PortalApi {
  static http.Client get client => Net.client;
  static set client(http.Client c) => Net.client = c;

  static Uri _uri(String path) => Uri.parse('${AppConfig.apiBase}$path');

  // ===== الدخول =====

  /// دخول الطالب: رقم تليفون الطالب + الكود
  static Future<String> studentLogin(String phone, String code) async {
    final body = await Net.json(() => client.post(
          _uri('/api/portal/student-login'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'phone': phone, 'student_code': code}),
        ));
    return body['token'] as String;
  }

  /// دخول ولي الأمر: رقم تليفون ولي الأمر + كود الطالب
  static Future<String> parentLogin(String parentPhone, String code) async {
    final body = await Net.json(() => client.post(
          _uri('/api/portal/parent-login'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'parent_phone': parentPhone, 'student_code': code}),
        ));
    return body['token'] as String;
  }

  static Future<bool>? _relogin;

  /// صلاحية الدخول خلصت على السيرفر: ندخل تاني لوحدنا بالتليفون والكود المحفوظين.
  /// بيرجع false لو البيانات المحفوظة مبقتش صحيحة (ساعتها بس المستخدم بيخرج).
  static Future<bool> _reloginOnce() => _relogin ??= () async {
        try {
          final type = await SessionStore.type();
          final phone = await SessionStore.phone();
          final code = await SessionStore.studentCode();
          if (type == null || type == AccountType.staff || phone == null || code == null) return false;
          final token = type == AccountType.parent ? await parentLogin(phone, code) : await studentLogin(phone, code);
          await SessionStore.updateToken(token);
          return true;
        } on ApiException catch (e) {
          if (e.offline) rethrow;
          return false;
        } finally {
          _relogin = null;
        }
      }();

  static Future<Map<String, String>> _headers({bool json = false}) async {
    final token = await SessionStore.token();
    return {
      'Authorization': 'Bearer $token',
      'Accept': 'application/json',
      if (json) 'Content-Type': 'application/json',
    };
  }

  /// طلب بصلاحية الطالب. لو الصلاحية خلصت بيدخل تاني ويعيد الطلب مرة واحدة.
  /// lenient: بيرجع الرد حتى لو success = false (زي "محتاج تدفع")
  static Future<Map<String, dynamic>> _authed(
    Future<http.Response> Function(Map<String, String> headers) request, {
    bool json = false,
    bool lenient = false,
  }) async {
    Future<Map<String, dynamic>> attempt() async {
      final headers = await _headers(json: json);
      if (!lenient) return Net.json(() => request(headers));
      final response = await Net.raw(() => request(headers));
      final body = Net.decode(response);
      if (response.statusCode == 401) throw ApiException('${body['message'] ?? 'لازم تسجل دخول تاني'}', unauthorized: true, status: 401);
      if (response.statusCode >= 500) throw ApiException('${body['message'] ?? 'السيرفر مش متاح دلوقتي'}', offline: true, status: response.statusCode);
      return body;
    }

    try {
      final result = await attempt();
      Connection.report(true);
      return result;
    } on ApiException catch (e) {
      if (e.offline) Connection.report(false);
      if (!e.unauthorized) rethrow;
      if (!await _reloginOnce()) rethrow;
      return attempt();
    }
  }

  static Future<Map<String, dynamic>> _get(String path) => _authed((h) => client.get(_uri(path), headers: h));
  static Future<Map<String, dynamic>> _post(String path, [Map<String, dynamic>? body, bool lenient = false]) =>
      _authed((h) => client.post(_uri(path), headers: h, body: jsonEncode(body ?? {})), json: true, lenient: lenient);

  // ===== البيانات =====

  /// كل بيانات الطالب (البروفايل + الحصص + المعاملات + امتحانات الشامل...)
  static Future<Map<String, dynamic>> studentData(AccountType type) async {
    final path = type == AccountType.parent ? '/api/portal/parent/data' : '/api/portal/student/data';
    final body = await _get(path);
    return (body['data'] as Map).cast<String, dynamic>();
  }

  /// صورة الـ QR بتاعة الطالب (SVG)
  static Future<String?> qrSvg() async {
    final body = await _get('/api/portal/student/qrcode');
    final dataUrl = body['qrCodeImage'] as String?;
    if (dataUrl == null || !dataUrl.contains('base64,')) return null;
    return utf8.decode(base64Decode(dataUrl.split('base64,').last));
  }

  /// ترتيب الطالب بين زمايله في النقط
  static Future<Map<String, dynamic>> leaderboard() => _get('/api/portal/leaderboard');

  static Future<Map<String, dynamic>> recharge(String code) => _post('/api/portal/recharge', {'code': code});

  // ===== الفيديوهات =====

  static Future<List<Map<String, dynamic>>> lessons() async {
    final body = await _get('/api/portal/student/lessons');
    return ((body['lessons'] as List?) ?? []).cast<Map<String, dynamic>>();
  }

  /// نتايج الأسئلة المنبثقة لكل درس (بتظهر على كارت الدرس)
  static Future<Map<String, dynamic>> popupResults() async {
    final body = await _get('/api/portal/student/popup-results');
    return (body['results'] as Map?)?.cast<String, dynamic>() ?? {};
  }

  /// فتح الدرس: لو محتاج دفع بيرجع requiresPayment + رسالة
  static Future<Map<String, dynamic>> lessonAccess(int videoId, {required bool confirmPayment}) =>
      _post('/api/portal/student/lessons/$videoId/access', {'confirm_payment': confirmPayment}, true);

  static Future<Map<String, dynamic>> lessonParts(int videoId) => _get('/api/portal/student/lessons/$videoId/parts');

  static Future<List<Map<String, dynamic>>> popupQuestions(int videoId) async {
    final body = await _get('/api/portal/student/lessons/$videoId/popups');
    return ((body['questions'] as List?) ?? []).cast<Map<String, dynamic>>();
  }

  static Future<Map<String, dynamic>> answerPopup(int questionId, String choice) async {
    final body = await _post('/api/portal/student/popup-questions/$questionId/answer', {'choice': choice});
    return (body['result'] as Map).cast<String, dynamic>();
  }

  static Future<Map<String, dynamic>> answerPopupEssay(int questionId, File image) async {
    final body = await _authed((h) async {
      final req = http.MultipartRequest('POST', _uri('/api/portal/student/popup-questions/$questionId/essay'))
        ..headers.addAll(h)
        ..files.add(await http.MultipartFile.fromPath('image', image.path));
      return http.Response.fromStream(await client.send(req));
    });
    return (body['result'] as Map).cast<String, dynamic>();
  }

  static Future<void> watchProgress(int partId, int seconds) =>
      _post('/api/portal/watch-progress', {'video_part_id': partId, 'watched_seconds': seconds});

  /// الفيديوهات الإضافية (البث) المتاحة في صفحة معينة
  static Future<List<Map<String, dynamic>>> broadcasts(String page) async {
    final body = await _get('/api/portal/student/video-broadcasts?page=${Uri.encodeQueryComponent(page)}');
    return ((body['videos'] as List?) ?? []).cast<Map<String, dynamic>>();
  }

  static Future<Map<String, dynamic>> purchaseBroadcast(int id, {required bool confirmPayment}) =>
      _post('/api/portal/student/video-broadcasts/$id/purchase', {if (confirmPayment) 'confirm_payment': true}, true);

  static Future<List<Map<String, dynamic>>> ads(AccountType type, String page) async {
    final who = type == AccountType.parent ? 'parent' : 'student';
    final body = await _get('/api/portal/$who/ads?page=${Uri.encodeQueryComponent(page)}');
    return ((body['ads'] as List?) ?? []).cast<Map<String, dynamic>>();
  }

  // ===== الواجب والبوكليتس =====

  static Future<List<Map<String, dynamic>>> homework() async {
    final body = await _get('/api/portal/homework');
    return ((body['assignments'] as List?) ?? []).cast<Map<String, dynamic>>();
  }

  /// رفع ملفات الواجب على الموقع (نفس upload.php اللي الموقع بيستخدمه) وبعدين تسجيل التسليم على السيرفر
  static Future<String> submitHomework(int assignmentId, List<File> files, String comment) async {
    final upload = http.MultipartRequest('POST', Uri.parse('${AppConfig.portalWebBase}/upload.php'));
    for (final f in files) {
      upload.files.add(await http.MultipartFile.fromPath('files[]', f.path));
    }
    final uploadRes = await Net.raw(() async => http.Response.fromStream(await client.send(upload)), limit: const Duration(minutes: 5));
    final uploadBody = Net.decode(uploadRes);
    if (uploadBody['success'] != true) {
      throw ApiException('❌ فشل رفع الصور: ${uploadBody['message'] ?? ''}');
    }
    final paths = ((uploadBody['paths'] as List?) ?? []).map((e) => '$e').toList();
    final body = await _post('/api/portal/homework/$assignmentId/submit', {
      'imagePaths': paths.where((p) => !p.toLowerCase().endsWith('.pdf')).toList(),
      'pdfPaths': paths.where((p) => p.toLowerCase().endsWith('.pdf')).toList(),
      'comment': comment,
    });
    return '${body['message'] ?? '✅ تم رفع الواجب بنجاح!'}';
  }

  static Future<List<Map<String, dynamic>>> booklets() async {
    final body = await _get('/api/portal/booklets');
    return ((body['booklets'] as List?) ?? []).cast<Map<String, dynamic>>();
  }

  // ===== صورة البروفايل =====

  /// الصور الجاهزة (أفاتار) اللي على الموقع
  static Future<List<String>> avatars() async {
    final response = await Net.raw(() => client.get(Uri.parse('${AppConfig.portalWebBase}/get_avatars.php')));
    final body = Net.decode(response);
    // نفس اللي المتصفح بيعمله: المسافات وغيرها بتتحول لـ %20
    return ((body['avatars'] as List?) ?? []).map((a) => '${AppConfig.portalWebBase}/${Uri.encodeFull('$a')}').toList();
  }

  static Future<String> uploadPhoto(File photo) async {
    final code = await SessionStore.studentCode();
    final req = http.MultipartRequest('POST', Uri.parse('${AppConfig.portalWebBase}/upload_photo.php'))
      ..fields['student_code'] = code ?? 'unknown'
      ..files.add(await http.MultipartFile.fromPath('photo', photo.path));
    final response = await Net.raw(() async => http.Response.fromStream(await client.send(req)), limit: const Duration(minutes: 2));
    final body = Net.decode(response);
    if (body['success'] != true) throw ApiException('${body['message'] ?? '❌ فشل الرفع'}');
    return '${AppConfig.portalWebBase}/${Uri.encodeFull('${body['url']}')}';
  }

  static Future<void> savePhotoUrl(String url) => _post('/api/portal/student/profile-photo', {'photo_url': url});
}
