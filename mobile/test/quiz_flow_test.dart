// اختبار المنصة في الأبلكيشن: الأسبوع مقفول ← الاختبار (معادلات + اختياري + مقالي) ← التسليم ← النتيجة ← الأسبوع بيتفتح.
// صفحة الأسبوع مالهاش صورة ثابتة لأن فيها عدّاد الوقت المتبقي. لتحديث صور الشاشات: flutter test test/quiz_flow_test.dart --update-goldens
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:studyisfunny_app/main.dart';
import 'package:studyisfunny_app/services/cache.dart';
import 'package:studyisfunny_app/services/net.dart';

String fixture(String name) => File('test/fixtures/$name').readAsStringSync();

Future<void> loadFont(String family, String path) async {
  final bytes = File(path).readAsBytesSync();
  await (FontLoader(family)..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
}

http.Response json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(body is String ? body : jsonEncode(body)), status, headers: {'content-type': 'application/json; charset=utf-8'});

/// سيرفر وهمي فيه اختبار للأسبوع 1 (نفس شكل ردود السيرفر الحقيقي)
class QuizServer {
  final requests = <http.Request>[];
  bool submitted = false;
  bool started = false;
  Map<String, dynamic> saved = {};

  static const questions = [
    {'id': 11, 'type': 'mcq', 'text': 'احسب طاقة الحركة \\(\\frac{1}{2}mv^2\\) لجسم كتلته 2 kg وسرعته 3 m/s', 'image': null, 'marks': 2, 'requiresAnswer': true,
      'choices': [{'text': '\\(9\\,\\mathrm{J}\\)', 'image': null}, {'text': '\\(18\\,\\mathrm{J}\\)', 'image': null}, {'text': '\\(6\\,\\mathrm{J}\\)', 'image': null}, {'text': '\\(\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}\\)', 'image': null}]},
    {'id': 12, 'type': 'essay', 'text': 'اشرح قانون نيوتن التاني \\[F = ma\\]', 'image': null, 'marks': 3, 'requiresAnswer': true, 'choices': []},
    {'id': 13, 'type': 'bonus', 'text': 'سؤال بونص', 'image': null, 'marks': 1, 'requiresAnswer': false, 'choices': []},
  ];

  Map<String, dynamic> summary() => {
        'id': 5, 'title': 'اختبار الأسبوع الأول', 'weekNumber': 1, 'timeLimitMinutes': 20, 'questionCount': 3, 'totalMarks': 6,
        'status': submitted ? 'submitted' : (started ? 'in_progress' : 'not_started'),
        'locked': !submitted, 'score': submitted ? 3 : null, 'maxScore': submitted ? 6 : null, 'pendingCount': submitted ? 1 : 0,
        'redoAvailable': false, 'answerVideoUrl': submitted ? 'https://youtu.be/dQw4w9WgXcQ' : null, 'url': 'https://shadyelsharkawy.com/quiz.html?id=5',
      };

  late final client = MockClient((request) async {
    requests.add(request);
    final path = request.url.path;
    switch (path) {
      case '/api/portal/student-login':
        return json('{"success":true,"token":"test-token"}');
      case '/api/portal/student/data':
        return json(fixture('student_data.json'));
      case '/api/portal/student/qrcode':
        return json(fixture('qrcode.json'));
      case '/api/portal/leaderboard':
        return json(fixture('leaderboard.json'));
      case '/api/portal/student/popup-results':
        return json('{"success":true,"results":{}}');
      case '/api/portal/student/lessons':
        final body = jsonDecode(fixture('lessons.json')) as Map<String, dynamic>;
        for (final l in (body['lessons'] as List).cast<Map<String, dynamic>>()) {
          l['quizLocked'] = !submitted;
          l['quizId'] = 5;
          l['examUrl'] = 'https://shadyelsharkawy.com/quiz.html?id=5';
        }
        return json({...body, 'quizMode': true, 'quizzes': [summary()]});
      case '/api/portal/student/quizzes/5':
        final out = <String, dynamic>{'success': true, 'serverNow': DateTime.now().toUtc().toIso8601String(), 'quiz': {...summary(), 'instructions': 'ركز في الوحدات \\(g = 9.8\\)'}};
        if (submitted) {
          out['attempt'] = {'id': 1, 'attemptNo': 1, 'status': 'submitted', 'answers': saved, 'score': 3, 'maxScore': 6, 'pendingCount': 1, 'autoSubmitted': false,
            'results': {'11': {'earned': saved['11']?['choice'] == 0 ? 2 : 0, 'max': 2, 'correct': saved['11']?['choice'] == 0}, '12': {'earned': 0, 'max': 3, 'pending': true}, '13': {'earned': 1, 'max': 1, 'correct': true}}};
          out['questions'] = questions.map((q) => {...q, if (q['type'] == 'mcq') 'correctIndex': 0}).toList();
        } else if (started) {
          out['attempt'] = {'id': 1, 'attemptNo': 1, 'status': 'in_progress', 'answers': saved, 'deadlineAt': null /* بدون عدّاد عشان صورة الشاشة متتغيرش كل ثانية */};
          out['questions'] = questions;
        }
        return json(out);
      case '/api/portal/student/quizzes/5/start':
        started = true;
        return json('{"success":true,"attemptId":1}');
      case '/api/portal/student/quizzes/5/save':
        saved = ((jsonDecode(request.body) as Map)['answers'] as Map).cast<String, dynamic>();
        return json('{"success":true}');
      case '/api/portal/student/quizzes/5/submit':
        saved = ((jsonDecode(request.body) as Map)['answers'] as Map).cast<String, dynamic>();
        submitted = true;
        return json('{"success":true}');
    }
    return json('{"success":false,"message":"not found"}', 404);
  });
}

void main() {
  late QuizServer server;

  setUpAll(() async {
    await initializeDateFormatting('ar');
    await loadFont('Cairo', 'assets/fonts/Cairo.ttf');
    final flutterRoot = File(Platform.resolvedExecutable).parent.parent.parent.parent.parent.parent.path;
    final icons = '$flutterRoot/bin/cache/artifacts/material_fonts/materialicons-regular.otf';
    if (File(icons).existsSync()) await loadFont('MaterialIcons', icons);
    // خطوط المعادلات (بتتحمل من الباكدج في البرنامج الحقيقي، في التست لازم نحملها بإيدينا)
    final pubCache = Platform.environment['PUB_CACHE'] ?? 'D:/dev/pub-cache';
    final katex = '$pubCache/hosted/pub.dev/flutter_math_fork-0.7.4/lib/katex_fonts/fonts';
    for (final f in ['Main-Regular', 'Math-Italic', 'Size1-Regular', 'Size2-Regular', 'Size3-Regular', 'Size4-Regular', 'AMS-Regular']) {
      final file = '$katex/KaTeX_$f.ttf';
      if (File(file).existsSync()) await loadFont('packages/flutter_math_fork/KaTeX_${f.split('-').first}', file);
    }
  });

  setUp(() {
    server = QuizServer();
    Net.client = server.client;
    Connection.online.value = true;
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    PackageInfo.setMockInitialValues(appName: 'Studyisfunny', packageName: 'com.studyisfunny.app', version: '1.1.0', buildNumber: '2', buildSignature: '');
    final dir = Directory.systemTemp.createTempSync('sif_quiz_test_');
    Cache.resetRoot();
    Cache.rootProvider = () async => dir;
  });

  testWidgets('quiz locks the week, student takes it, week opens with the explanation video', (tester) async {
    tester.view.physicalSize = const Size(412 * 2, 915 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(const StudyisfunnyApp());
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextFormField).at(0), '01000000001');
    await tester.enterText(find.byType(TextFormField).at(1), 'STU-00001');
    await tester.tap(find.text('دخول'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('الفيديوهات').last);
    await tester.pumpAndSettle();
    expect(find.text('🔒 محتاج اختبار'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/q1_weeks_locked.png'));

    await tester.tap(find.text('الأسبوع 1'));
    await tester.pumpAndSettle();
    expect(find.text('اختبار الأسبوع الأول'), findsOneWidget);
    expect(find.text('🔒 حل الاختبار الأول'), findsWidgets);
    expect(find.text('الاختبار'), findsNothing, reason: 'old Google Form card hidden in quiz mode');
    expect(find.text('فيديو الواجب'), findsNothing, reason: 'locked week hides homework videos');

    // كارت حصة مقفول بيودي على الاختبار
    await tester.tap(find.text('شرح الحركة'));
    await tester.pumpAndSettle();
    expect(find.text('ابدأ الاختبار'), findsOneWidget);
    expect(find.byType(Math), findsWidgets, reason: 'instructions render math');
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/q3_quiz_intro.png'));

    await tester.tap(find.text('ابدأ الاختبار'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('ابدأ').last); // تأكيد الوقت
    await tester.pumpAndSettle();
    expect(find.text('سؤال 1'), findsOneWidget);
    expect(find.byType(Math), findsWidgets);
    expect(find.text('جاوبت 0 من 2   '), findsOneWidget);

    await tester.tap(find.text('أ').first); // الاختيار أ (9 J)
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(server.saved['11'], {'choice': 0});
    await tester.enterText(find.byType(TextField), 'القوة = الكتلة × العجلة');
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(server.saved['12']['text'], 'القوة = الكتلة × العجلة');
    expect(find.textContaining('جاوبت 2 من 2'), findsOneWidget);
    expect(find.textContaining('✓ اتحفظ'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/q4_quiz_taking.png'));

    await tester.tap(find.text('تسليم'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('سلّم'));
    await tester.pumpAndSettle();
    expect(server.submitted, isTrue);
    expect(find.text('نتيجتك'), findsOneWidget);
    expect(find.text('شوف الشرح دلوقتي'), findsOneWidget);
    expect(find.textContaining('سؤال مقالي لسه بيتصحح'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/q5_quiz_result.png'));

    await tester.tap(find.text('هشوفه بعدين — افتح حصص الأسبوع'));
    await tester.pumpAndSettle();
    expect(find.text('🔒 حل الاختبار الأول'), findsNothing);
    expect(find.text('فيديو شرح الاختبار'), findsWidgets);
    expect(find.textContaining('درجتك: 3 / 6'), findsOneWidget);

    final paths = server.requests.map((r) => '${r.method} ${r.url.path}').toList();
    expect(paths, containsAll(['POST /api/portal/student/quizzes/5/start', 'POST /api/portal/student/quizzes/5/save', 'POST /api/portal/student/quizzes/5/submit']));
  });
}
