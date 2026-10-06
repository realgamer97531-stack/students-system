// اختبار البرنامج كأنه مستخدم، بردود حقيقية متسجلة من السيرفر (test/fixtures):
//  - الطالب: دخول غلط/صح، كل الصفحات (من غير صفحات الموقع)، الفيديوهات والواجب والبوكليتس
//  - الدخول بيفضل محفوظ، والبيانات بتظهر من غير نت، والدخول بيتجدد لوحده لو صلاحيته خلصت
//  - الموظف: تسجيل الموبايل، الدخول، مسح حضور من غير نت وبعدين يتبعت لوحده لما النت يرجع
// لتحديث صور الشاشات: flutter test --update-goldens
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:studyisfunny_app/main.dart';
import 'package:studyisfunny_app/screens/staff/scanner_box.dart';
import 'package:studyisfunny_app/services/cache.dart';
import 'package:studyisfunny_app/services/net.dart';
import 'package:studyisfunny_app/services/staff_store.dart';

String fixture(String name) => File('test/fixtures/$name').readAsStringSync();

Future<void> loadFont(String family, String path) async {
  final bytes = File(path).readAsBytesSync();
  await (FontLoader(family)..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
}

http.Response json(String body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(body), status, headers: {'content-type': 'application/json; charset=utf-8'});

/// سيرفر وهمي: بيرد من الـ fixtures، وينفع نقطع النت عنه
class FakeServer {
  final requests = <http.Request>[];
  bool offline = false;
  String validToken = 'test-token';
  int logins = 0;
  final routes = <String, http.Response Function(http.Request)>{};

  List<String> get paths => requests.map((r) => '${r.method} ${r.url.path}').toList();

  late final client = MockClient((request) async {
    if (offline) throw const SocketException('offline');
    requests.add(request);
    final path = request.url.path;
    final handler = routes[path];
    if (handler != null) return handler(request);
    if (path.startsWith('/api/portal/') && path != '/api/portal/student-login' && path != '/api/portal/parent-login') {
      if (request.headers['Authorization'] != 'Bearer $validToken') {
        return json('{"success":false,"message":"انتهت صلاحية الدخول، سجل دخول تاني"}', 401);
      }
    }
    switch (path) {
      case '/api/portal/student-login':
        final ok = request.body.contains('01000000001');
        if (ok) logins++;
        return ok ? json('{"success":true,"token":"$validToken"}') : json(fixture('login_fail.json'), 401);
      case '/api/portal/student/data':
        return json(fixture('student_data.json'));
      case '/api/portal/student/qrcode':
        return json(fixture('qrcode.json'));
      case '/api/portal/leaderboard':
        return json(fixture('leaderboard.json'));
      case '/api/portal/student/lessons':
        return json(fixture('lessons.json'));
      case '/api/portal/student/popup-results':
        return json('{"success":true,"results":{"7":[{"type":"mcq","isCorrect":true},{"type":"mcq","isCorrect":false}]}}');
      case '/api/portal/homework':
        return json(fixture('homework.json'));
      case '/api/portal/booklets':
        return json(fixture('booklets.json'));
    }
    return json('{"success":false,"message":"not found"}', 404);
  });
}

void main() {
  late FakeServer server;

  setUpAll(() async {
    await initializeDateFormatting('ar');
    await loadFont('Cairo', 'assets/fonts/Cairo.ttf');
    final flutterRoot = File(Platform.resolvedExecutable).parent.parent.parent.parent.parent.parent.path;
    final icons = '$flutterRoot/bin/cache/artifacts/material_fonts/materialicons-regular.otf';
    if (File(icons).existsSync()) await loadFont('MaterialIcons', icons);
    ScannerBox.useCamera = false;
    StaffStore.useIsolate = false;
  });

  setUp(() {
    server = FakeServer();
    Net.client = server.client;
    Connection.online.value = true;
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    PackageInfo.setMockInitialValues(appName: 'Studyisfunny', packageName: 'com.studyisfunny.app', version: '1.1.0', buildNumber: '2', buildSignature: '');
    final dir = Directory.systemTemp.createTempSync('sif_test_');
    Cache.resetRoot();
    Cache.rootProvider = () async => dir;
  });

  Future<void> phone(WidgetTester tester) async {
    tester.view.physicalSize = const Size(412 * 2, 915 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
  }

  Future<void> loginStudent(WidgetTester tester) async {
    await tester.pumpWidget(const StudyisfunnyApp());
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextFormField).at(0), '01000000001');
    await tester.enterText(find.byType(TextFormField).at(1), 'STU-00001');
    await tester.tap(find.text('دخول'));
    await tester.pumpAndSettle();
  }

  testWidgets('student: login, home, sessions, videos, homework, booklets — all native', (tester) async {
    await phone(tester);
    await tester.pumpWidget(const StudyisfunnyApp());
    await tester.pumpAndSettle();
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/1_login.png'));

    // دخول غلط
    await tester.enterText(find.byType(TextFormField).at(0), '01099999999');
    await tester.enterText(find.byType(TextFormField).at(1), 'STU-00001');
    await tester.tap(find.text('دخول'));
    await tester.pumpAndSettle();
    expect(find.text('رقم التليفون أو الكود غير صحيح'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/2_login_error.png'));

    // دخول صح
    await tester.enterText(find.byType(TextFormField).at(0), '01000000001');
    await tester.tap(find.text('دخول'));
    await tester.pumpAndSettle();
    expect(find.text('أهلاً، طالب واحد'), findsOneWidget);
    expect(find.text('250 ج'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/3_home.png'));

    await tester.drag(find.byType(ListView).first, const Offset(0, -900));
    await tester.pumpAndSettle();
    expect(find.text('كود الحضور'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/4_home_scrolled.png'));

    await tester.tap(find.text('حصصي').last);
    await tester.pumpAndSettle();
    expect(find.text('حصة 1'), findsOneWidget);
    expect(find.text('حضر'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/5_sessions.png'));

    // الفيديوهات: الأسابيع ← الحصص (كله جوه البرنامج)
    await tester.tap(find.text('الفيديوهات').last);
    await tester.pumpAndSettle();
    expect(find.text('الأسبوع 1'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/6_videos_weeks.png'));
    await tester.tap(find.text('الأسبوع 1'));
    await tester.pumpAndSettle();
    expect(find.text('شرح الحركة'), findsOneWidget);
    expect(find.text('متاحة'), findsWidgets);
    expect(find.text('فيديو الواجب'), findsWidgets);
    expect(find.text('🎯 الأسئلة المنبثقة: 1 صح من 2'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/7_videos_week.png'));

    // من جوه صفحة الفيديوهات نروح أي صفحة تانية من الشريط اللي تحت، ونرجع نلاقيها زي ما هي
    await tester.tap(find.text('الواجب').last);
    await tester.pumpAndSettle();
    expect(find.text('واجب الحصة الأولى'), findsOneWidget);
    expect(find.text('📤 رفع الواجب'), findsOneWidget);
    expect(find.text('صُحِّح في السنتر'), findsWidgets);
    expect(find.text('كامل ✅'), findsNothing);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/8_homework.png'));
    await tester.tap(find.text('الفيديوهات').last);
    await tester.pumpAndSettle();
    expect(find.text('شرح الحركة'), findsOneWidget);

    await tester.tap(find.text('المزيد').last);
    await tester.pumpAndSettle();
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/9_more.png'));
    await tester.tap(find.text('البوكليتس'));
    await tester.pumpAndSettle();
    expect(find.text('بوكليت الترم الأول'), findsOneWidget);
    expect(find.text('100 ج'), findsWidgets);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/10_booklets.png'));

    expect(server.paths, containsAll(['POST /api/portal/student-login', 'GET /api/portal/student/data', 'GET /api/portal/student/qrcode', 'GET /api/portal/student/lessons', 'GET /api/portal/homework']));
  });

  testWidgets('student stays logged in and sees saved data with no internet', (tester) async {
    await phone(tester);
    await loginStudent(tester);
    expect(find.text('أهلاً، طالب واحد'), findsOneWidget);
    await tester.tap(find.text('الفيديوهات').last);
    await tester.pumpAndSettle();

    // البرنامج اتقفل واتفتح تاني والنت فاصل
    server.offline = true;
    await tester.pumpWidget(const SizedBox());
    final session = await AppSession.restore();
    expect(session, isNotNull);
    await tester.pumpWidget(StudyisfunnyApp(initial: session));
    await tester.pumpAndSettle();
    expect(find.text('أهلاً، طالب واحد'), findsOneWidget);
    expect(find.text('250 ج'), findsOneWidget);
    expect(find.textContaining('مفيش نت'), findsWidgets);
    await tester.drag(find.byType(ListView).first, const Offset(0, -900));
    await tester.pumpAndSettle();
    expect(find.text('كود الحضور'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/11_offline_home.png'));

    await tester.tap(find.text('الفيديوهات').last);
    await tester.pumpAndSettle();
    expect(find.text('الأسبوع 1'), findsOneWidget);
  });

  testWidgets('expired token: logs in again by itself, no logout', (tester) async {
    await phone(tester);
    await loginStudent(tester);
    expect(server.logins, 1);

    // السيرفر غيّر الصلاحية (زي ما بيحصل بعد 30 يوم)
    server.validToken = 'new-token';
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(StudyisfunnyApp(initial: await AppSession.restore()));
    await tester.pumpAndSettle();
    expect(server.logins, 2);
    expect(find.text('أهلاً، طالب واحد'), findsOneWidget);
    expect(find.text('دخول'), findsNothing);
  });

  testWidgets('staff: register phone, login, scan attendance offline, synced later', (tester) async {
    await phone(tester);
    final ops = <http.Request>[];
    server.routes['/api/sync/register-device'] = (r) => json('{"success":true,"token":"device-1","deviceName":"موبايل"}');
    server.routes['/api/sync/mobile/staff-login'] = (r) {
      expect(r.headers['X-Sync-Device-Token'], 'device-1');
      return json('{"success":true,"user":{"id":3,"name":"أسيستانت تجربة","role":"admin","permissions":[]}}');
    };
    server.routes['/api/sync/mobile/snapshot'] = (r) => json(fixture('snapshot.json'));
    server.routes['/attendance/scan'] = (r) {
      ops.add(r);
      return json(jsonEncode({
        'envelope': true,
        'ok': true,
        'status': 200,
        'body': jsonEncode({'success': true, 'message': 'تم تسجيل الحضور والخصم بنجاح', 'student_name': 'طالب واحد', 'remaining_balance': 200}),
      }));
    };

    await tester.pumpWidget(const StudyisfunnyApp());
    await tester.pumpAndSettle();
    await tester.tap(find.text('موظف'));
    await tester.pumpAndSettle();
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/12_login_staff.png'));
    await tester.enterText(find.byType(TextFormField).at(0), 'admin');
    await tester.enterText(find.byType(TextFormField).at(1), 'secret');
    await tester.tap(find.text('دخول'));
    await tester.pumpAndSettle();
    expect(find.text('أسيستانت تجربة'), findsOneWidget);
    expect(StaffStore.snapshot.value?.byCode['STU-00001']?.name, 'طالب واحد');

    // اختيار الحصة
    await tester.tap(find.text('اضغط هنا واختار الحصة').first);
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('حصة 2 — سنتر الاختبار'));
    await tester.pumpAndSettle();
    expect(find.textContaining('حصة 2 — سنتر الاختبار'), findsWidgets);

    // النت فصل: الحضور بيتحفظ
    server.offline = true;
    await tester.enterText(find.byType(TextField).first, '1');
    await tester.tap(find.text('بحث').first);
    await tester.pumpAndSettle();
    expect(find.text('طالب واحد'), findsOneWidget);
    expect(find.textContaining('مفيش نت — البيانات دي من آخر تحديث'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/13_staff_offline_confirm.png'));
    await tester.tap(find.text('✅ تأكيد الحضور'));
    await tester.pumpAndSettle();
    expect(find.textContaining('اتحفظ على الموبايل'), findsOneWidget);
    expect(StaffStore.queue.value, hasLength(1));
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/14_staff_queued.png'));

    // نفس الطالب تاني وهو أوفلاين: البرنامج عارف إنه اتسجل
    await tester.enterText(find.byType(TextField).first, 'STU-00001');
    await tester.tap(find.text('بحث').first);
    await tester.pumpAndSettle();
    expect(find.text('طالب واحد مسجل حضوره من قبل'), findsOneWidget);

    // النت رجع: العملية بتتبعت لوحدها باسم الموظف وفي الحصة اللي اتسجلت فيها
    server.offline = false;
    await StaffStore.flush();
    await tester.pumpAndSettle();
    expect(StaffStore.queue.value, isEmpty);
    expect(ops, hasLength(1));
    final op = ops.single;
    expect(op.headers['X-Sync-Op-Id'], isNotEmpty);
    final context = jsonDecode(utf8.decode(base64Decode(op.headers['X-Sync-Context']!))) as Map;
    expect(context['userId'], 3);
    expect(context['activeSessionId'], 12);
    expect(jsonDecode(op.body)['student_code'], '1');

    // قايمة الطلاب جوه البرنامج ومن غير نت
    server.offline = true;
    await tester.tap(find.text('الطلاب').last);
    await tester.pumpAndSettle();
    expect(find.text('طالب واحد'), findsOneWidget);
    await tester.enterText(find.byType(TextField).last, '01000000001');
    await tester.pumpAndSettle();
    expect(find.text('1 طالب'), findsOneWidget);
    await tester.tap(find.text('طالب واحد'));
    await tester.pumpAndSettle();
    expect(find.text('تليفون الطالب'), findsOneWidget);
    expect(find.text('حضر (سنتر الاختبار)'), findsWidgets);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/15_staff_student.png'));

    // تنظيف التايمرز
    await tester.pumpWidget(const SizedBox());
  });
}
