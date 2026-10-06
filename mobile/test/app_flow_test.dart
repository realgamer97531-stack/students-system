// اختبار البرنامج كأنه مستخدم: دخول غلط، دخول صح، وكل تبويبات الطالب — بردود حقيقية متسجلة من السيرفر (test/fixtures).
// لتحديث صور الشاشات: flutter test --update-goldens
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:studyisfunny_app/main.dart';
import 'package:studyisfunny_app/services/api.dart';

String fixture(String name) => File('test/fixtures/$name').readAsStringSync();

Future<void> loadFont(String family, String path) async {
  final bytes = File(path).readAsBytesSync();
  await (FontLoader(family)..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
}

void main() {
  final requests = <String>[];

  setUpAll(() async {
    await initializeDateFormatting('ar');
    await loadFont('Cairo', 'assets/fonts/Cairo.ttf');
    final flutterRoot = File(Platform.resolvedExecutable).parent.parent.parent.parent.parent.parent.path;
    final icons = '$flutterRoot/bin/cache/artifacts/material_fonts/materialicons-regular.otf';
    if (File(icons).existsSync()) await loadFont('MaterialIcons', icons);
  });

  setUp(() {
    requests.clear();
    SharedPreferences.setMockInitialValues({});
    PackageInfo.setMockInitialValues(appName: 'Studyisfunny', packageName: 'com.studyisfunny.app', version: '1.0.0', buildNumber: '1', buildSignature: '');
    PortalApi.client = MockClient((request) async {
      requests.add('${request.method} ${request.url.path}');
      switch (request.url.path) {
        case '/api/portal/student-login':
          final ok = request.body.contains('01000000001');
          return json(ok ? '{"success":true,"token":"test-token"}' : fixture('login_fail.json'), ok ? 200 : 401);
        case '/api/portal/student/data':
          expect(request.headers['Authorization'], 'Bearer test-token');
          return json(fixture('student_data.json'), 200);
        case '/api/portal/student/qrcode':
          return json(fixture('qrcode.json'), 200);
        case '/api/portal/leaderboard':
          return json(fixture('leaderboard.json'), 200);
      }
      return http.Response('{"success":false}', 404);
    });
  });

  Future<void> phone(WidgetTester tester) async {
    tester.view.physicalSize = const Size(412 * 2, 915 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
  }

  testWidgets('student login → home, lessons, transactions, more', (tester) async {
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
    expect(find.text('طالب واحد'), findsOneWidget);
    expect(find.text('250 ج'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/3_home.png'));

    await tester.drag(find.byType(ListView).first, const Offset(0, -700));
    await tester.pumpAndSettle();
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/4_home_scrolled.png'));

    await tester.tap(find.text('حصصي').last);
    await tester.pumpAndSettle();
    expect(find.text('حصة 1'), findsOneWidget);
    expect(find.text('حضر'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/5_lessons.png'));

    await tester.tap(find.text('المعاملات').last);
    await tester.pumpAndSettle();
    expect(find.text('دفع نقدي وقت الحضور'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/6_transactions.png'));

    await tester.tap(find.text('المزيد').last);
    await tester.pumpAndSettle();
    expect(find.text('الفيديوهات'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/7_more.png'));

    expect(requests, containsAll(['POST /api/portal/student-login', 'GET /api/portal/student/data', 'GET /api/portal/student/qrcode']));
  });

  testWidgets('staff option shows explanation instead of fields', (tester) async {
    await phone(tester);
    await tester.pumpWidget(const StudyisfunnyApp());
    await tester.pumpAndSettle();
    await tester.tap(find.text('موظف'));
    await tester.pumpAndSettle();
    expect(find.text('فتح سيستم الموظفين'), findsOneWidget);
    expect(find.byType(TextFormField), findsNothing);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/8_login_staff.png'));
  });
}

http.Response json(String body, int status) =>
    http.Response.bytes(utf8.encode(body), status, headers: {'content-type': 'application/json; charset=utf-8'});
