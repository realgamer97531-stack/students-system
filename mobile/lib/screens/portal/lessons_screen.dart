import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../services/api.dart';
import '../../services/cache.dart';
import '../../services/session_store.dart';
import '../../theme.dart';
import '../../widgets/ads.dart';
import '../../widgets/broadcasts.dart';
import '../../widgets/cached_view.dart';
import '../../widgets/common.dart';
import '../../widgets/popup_question.dart';
import '../../widgets/video_source.dart';
import 'lesson_view_screen.dart';
import 'quiz_screen.dart';
import 'video_screen.dart';

const _statusLabels = {
  'free': ('مجانية', AppColors.successSoft, AppColors.successText),
  'granted': ('متاحة', Color(0xFFE0E7FF), AppColors.primary),
  'exhausted': ('انتهت المشاهدات', AppColors.neutralSoft, AppColors.muted),
  'expired': ('انتهت المدة', AppColors.neutralSoft, AppColors.muted),
  'locked': ('تحتاج فتح', AppColors.warningSoft, AppColors.warningText),
};

class LessonsData {
  LessonsData(this.lessons, this.popupResults, {this.quizMode = false, this.quizzes = const [], this.shamelQuizzes = const []});
  final List<Map<String, dynamic>> lessons;
  final Map<String, dynamic> popupResults;
  // اختبار المنصة: لو مفعّل للمادة كارت الاختبار بيحل محل روابط جوجل فورم، والأسبوع بيتقفل لحد ما يتحل
  final bool quizMode;
  final List<Map<String, dynamic>> quizzes;
  // الشامل: كارت لوحده بين الأسابيع، مش جوه أسبوع
  final List<Map<String, dynamic>> shamelQuizzes;

  List<Map<String, dynamic>> quizzesForWeek(int? week) => quizzes.where((q) => week != null && asInt(q['weekNumber']) == week).toList();
}

List<Map<String, dynamic>> _maps(dynamic list) => ((list as List?) ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList();

class _Week {
  _Week(this.number, this.label);
  final int? number;
  final String label;
  final List<Map<String, dynamic>> lessons = [];
}

List<_Week> _buildWeeks(List<Map<String, dynamic>> lessons, [List<Map<String, dynamic>> quizzes = const []]) {
  final map = <String, _Week>{};
  // أسبوع فيه اختبار ولسه مفيهوش فيديوهات بيظهر برضه
  for (final q in quizzes) {
    final n = asInt(q['weekNumber']);
    if (n != null && n > 0) map.putIfAbsent('w$n', () => _Week(n, 'الأسبوع $n'));
  }
  for (final l in lessons) {
    final n = asInt(l['weekNumber'] ?? l['week_number']);
    final week = n != null && n > 0 ? n : null;
    final key = week == null ? 'unassigned' : 'w$week';
    map.putIfAbsent(key, () => _Week(week, week == null ? 'غير مرتبط بأسبوع' : 'الأسبوع $week')).lessons.add(l);
  }
  final weeks = map.values.toList();
  for (final w in weeks) {
    w.lessons.sort((a, b) => (asInt(a['lessonNumber']) ?? 0).compareTo(asInt(b['lessonNumber']) ?? 0));
  }
  weeks.sort((a, b) {
    if (a.number == null) return 1;
    if (b.number == null) return -1;
    return a.number!.compareTo(b.number!);
  });
  return weeks;
}

/// الأسابيع + كروت الشامل، كل شامل بعد الأسبوع اللي اتحدد له (الأسابيع من غير رقم في الآخر)
List<Object> _gridItems(List<_Week> weeks, List<Map<String, dynamic>> shamel) {
  final items = <(int, int, Object)>[
    for (final w in weeks) (w.number ?? 1 << 30, 0, w),
    for (final q in shamel) (asInt(q['weekNumber']) ?? 0, 1, q),
  ];
  items.sort((a, b) => a.$1 != b.$1 ? a.$1.compareTo(b.$1) : a.$2.compareTo(b.$2));
  return [for (final item in items) item.$3];
}

class _ShamelCard extends StatelessWidget {
  const _ShamelCard({required this.quiz, required this.onChanged});
  final Map<String, dynamic> quiz;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final submitted = '${quiz['status']}' == 'submitted';
    final price = (quiz['price'] as num?) ?? 0;
    return Card(
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: const BorderSide(color: AppColors.warning, width: 2)),
      child: InkWell(
        onTap: () async {
          await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => QuizScreen(quizId: asInt(quiz['id'])!, title: '${quiz['title'] ?? ''}')));
          onChanged();
        },
        child: Container(
          decoration: const BoxDecoration(color: AppColors.warningSoft),
          padding: const EdgeInsets.all(12),
          child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
            const Pill('🎓 امتحان شامل', AppColors.warningSoft, AppColors.warningText),
            const SizedBox(height: 8),
            Text('${quiz['title'] ?? ''}', textAlign: TextAlign.center, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
            const SizedBox(height: 6),
            if (submitted)
              Pill('📝 ${quiz['score']} / ${quiz['maxScore']}', AppColors.successSoft, AppColors.successText)
            else
              Text(price > 0 ? '$price ج' : 'مجاني', style: const TextStyle(color: AppColors.warningText, fontWeight: FontWeight.w700)),
          ]),
        ),
      ),
    );
  }
}

String formatRemaining(int seconds) {
  final s = seconds < 0 ? 0 : seconds;
  final d = s ~/ 86400, h = (s % 86400) ~/ 3600, m = (s % 3600) ~/ 60;
  if (d > 0) return '$d يوم $h ساعة $m دقيقة';
  if (h > 0) return '$h ساعة $m دقيقة';
  return '$m دقيقة';
}

/// الفيديوهات: قايمة الأسابيع
class LessonsScreen extends StatefulWidget {
  const LessonsScreen({super.key, required this.onUnauthorized});
  final VoidCallback onUnauthorized;
  @override
  State<LessonsScreen> createState() => _LessonsScreenState();
}

class _LessonsScreenState extends State<LessonsScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => Ads.showFor(context, AccountType.student, 'lessons'));
  }

  static Future<dynamic> _fetch() async {
    final body = await PortalApi.lessonsFull();
    final lessons = _maps(body['lessons']);
    Map<String, dynamic> popup = {};
    try {
      popup = await PortalApi.popupResults();
    } catch (_) {
      popup = ((await Cache.read('lessons'))?.data as Map?)?['popup'] as Map<String, dynamic>? ?? {};
    }
    return {'lessons': lessons, 'popup': popup, 'quizMode': body['quizMode'] == true, 'quizzes': body['quizzes'] ?? [], 'shamelQuizzes': body['shamelQuizzes'] ?? []};
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('الفيديوهات')),
      floatingActionButton: const BroadcastsButton(page: 'lessons'),
      body: CachedView<LessonsData>(
        cacheKey: 'lessons',
        fetch: _fetch,
        onUnauthorized: widget.onUnauthorized,
        decode: (j) => LessonsData(
          _maps((j as Map)['lessons']),
          (j['popup'] as Map?)?.cast<String, dynamic>() ?? {},
          quizMode: j['quizMode'] == true,
          quizzes: _maps(j['quizzes']),
          shamelQuizzes: _maps(j['shamelQuizzes']),
        ),
        builder: (context, data, refresh) {
          if (data.lessons.isEmpty && data.quizzes.isEmpty && data.shamelQuizzes.isEmpty) return const EmptyView('لا يوجد دروس فيديو متاحة حاليًا', icon: Icons.ondemand_video_outlined);
          final weeks = _buildWeeks(data.lessons, data.quizzes);
          final items = _gridItems(weeks, data.shamelQuizzes);
          return GridView.builder(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 90),
            gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 260, mainAxisExtent: 150, crossAxisSpacing: 12, mainAxisSpacing: 12),
            itemCount: items.length,
            itemBuilder: (context, i) {
              final item = items[i];
              if (item is Map<String, dynamic>) return _ShamelCard(quiz: item, onChanged: refresh);
              final w = item as _Week;
              final weekQuizzes = data.quizzesForWeek(w.number);
              return Card(
                clipBehavior: Clip.antiAlias,
                child: InkWell(
                  onTap: () => Navigator.of(context).push(MaterialPageRoute(
                    builder: (_) => WeekScreen(
                      title: w.label,
                      lessons: w.lessons,
                      popupResults: data.popupResults,
                      onChanged: refresh,
                      weekNumber: w.number,
                      quizMode: data.quizMode,
                      quizzes: weekQuizzes,
                    ),
                  )),
                  child: Container(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(colors: [AppColors.primary.withValues(alpha: 0.07), AppColors.accent.withValues(alpha: 0.06)]),
                    ),
                    padding: const EdgeInsets.all(16),
                    child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                      const Pill('الأسبوع', Color(0x1A4F46E5), AppColors.primary),
                      const SizedBox(height: 10),
                      Text(w.label, textAlign: TextAlign.center, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                      Text('${w.lessons.length} حصة', style: const TextStyle(color: AppColors.muted)),
                      if (weekQuizzes.any((q) => q['locked'] == true))
                        const Padding(padding: EdgeInsets.only(top: 6), child: Pill('🔒 محتاج اختبار', AppColors.warningSoft, AppColors.warningText))
                      else
                        for (final q in weekQuizzes)
                          Padding(
                            padding: const EdgeInsets.only(top: 6),
                            child: Pill('📝 ${q['score']} / ${q['maxScore']}', AppColors.successSoft, AppColors.successText),
                          ),
                    ]),
                  ),
                ),
              );
            },
          );
        },
      ),
    );
  }
}

/// صلاحية الدروس اللي اتفتحت في الجلسة دي (زي sessionStorage في الموقع)
final Map<int, Map<String, dynamic>> _accessCache = {};

void cacheLessonAccess(int videoId, Map<String, dynamic> lesson) {
  if (lesson['status'] != 'free' && lesson['accessExpiresAt'] == null) return;
  _accessCache[videoId] = {'status': lesson['status'], 'accessExpiresAt': lesson['accessExpiresAt']};
}

bool _hasCachedAccess(int videoId) {
  final e = _accessCache[videoId];
  if (e == null) return false;
  final exp = e['accessExpiresAt'] == null ? null : DateTime.tryParse('${e['accessExpiresAt']}');
  if (e['status'] != 'free' && exp == null) return false;
  if (exp != null && exp.isBefore(DateTime.now())) {
    _accessCache.remove(videoId);
    return false;
  }
  return true;
}

/// نفس openProtectedAction في الموقع: يتأكد إن الطالب له صلاحية، ولو محتاج يدفع يسأله الأول
Future<bool> ensureLessonAccess(BuildContext context, int videoId) async {
  if (_hasCachedAccess(videoId)) return true;
  try {
    var res = await PortalApi.lessonAccess(videoId, confirmPayment: false);
    if (res['requiresPayment'] == true) {
      if (!context.mounted) return false;
      final ok = await confirmDialog(context, title: 'تأكيد الدفع', message: '${res['message'] ?? ''}', ok: 'موافق، ادفع وشاهد', cancel: 'رفض');
      if (!ok) return false;
      res = await PortalApi.lessonAccess(videoId, confirmPayment: true);
    }
    if (res['success'] != true) {
      if (context.mounted) toast(context, '${res['message'] ?? 'لا يمكن فتح هذا الدرس'}', error: true);
      return false;
    }
    cacheLessonAccess(videoId, {'status': 'granted', ...res});
    return true;
  } on ApiException catch (e) {
    if (context.mounted) toast(context, e.offline ? 'الفيديوهات محتاجة نت — اتأكد من النت وجرب تاني' : e.message, error: true);
    return false;
  }
}

class WeekScreen extends StatefulWidget {
  const WeekScreen({
    super.key,
    required this.title,
    required this.lessons,
    required this.popupResults,
    required this.onChanged,
    this.weekNumber,
    this.quizMode = false,
    this.quizzes = const [],
  });
  final String title;
  final List<Map<String, dynamic>> lessons;
  final Map<String, dynamic> popupResults;
  final Future<void> Function() onChanged;
  final int? weekNumber;
  final bool quizMode;
  final List<Map<String, dynamic>> quizzes;
  @override
  State<WeekScreen> createState() => _WeekScreenState();
}

class _WeekScreenState extends State<WeekScreen> {
  Timer? _tick;
  late List<Map<String, dynamic>> _lessons = widget.lessons;
  late List<Map<String, dynamic>> _quizzes = widget.quizzes;
  late bool _quizMode = widget.quizMode;

  @override
  void initState() {
    super.initState();
    for (final l in widget.lessons) {
      final id = asInt(l['videoId']);
      if (id != null) cacheLessonAccess(id, l);
    }
    _tick = Timer.periodic(const Duration(minutes: 1), (_) => mounted ? setState(() {}) : null);
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  /// بعد حل الاختبار: نجيب الأسبوع من جديد (الحصص بتتفتح وكارت فيديو الشرح بيظهر)
  Future<void> _reloadWeek() async {
    try {
      final body = await PortalApi.lessonsFull();
      if (!mounted) return;
      setState(() {
        _quizMode = body['quizMode'] == true;
        _lessons = _maps(body['lessons']).where((l) => asInt(l['weekNumber']) == widget.weekNumber).toList()
          ..sort((a, b) => (asInt(a['lessonNumber']) ?? 0).compareTo(asInt(b['lessonNumber']) ?? 0));
        _quizzes = _maps(body['quizzes']).where((q) => widget.weekNumber != null && asInt(q['weekNumber']) == widget.weekNumber).toList();
      });
    } on ApiException catch (_) {
      // النت فاصل: الشاشة بتفضل زي ما هي
    }
    widget.onChanged();
  }

  Future<void> _openQuiz(int quizId, String title) async {
    final changed = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => QuizScreen(quizId: quizId, title: title)));
    if (mounted && changed != false) await _reloadWeek();
  }

  Widget _quizCard(Map<String, dynamic> q) {
    final locked = q['locked'] == true;
    final status = '${q['status']}';
    final action = status == 'in_progress' ? 'كمّل الاختبار' : status == 'submitted' ? 'شوف نتيجتك' : 'ابدأ الاختبار';
    final minutes = asInt(q['timeLimitMinutes']);
    return Card(
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: BorderSide(color: locked ? AppColors.warning : AppColors.accent.withValues(alpha: 0.5), width: 2)),
      child: InkWell(
        onTap: () => _openQuiz(asInt(q['id'])!, '${q['title'] ?? ''}'),
        child: Container(
          decoration: BoxDecoration(gradient: LinearGradient(colors: [AppColors.primary.withValues(alpha: 0.08), AppColors.accent.withValues(alpha: 0.08)])),
          padding: const EdgeInsets.all(16),
          child: Row(children: [
            Container(
              width: 52,
              height: 52,
              decoration: BoxDecoration(gradient: const LinearGradient(colors: [AppColors.accent, AppColors.primary]), borderRadius: BorderRadius.circular(16)),
              child: const Icon(Icons.quiz_outlined, color: Colors.white, size: 28),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Pill('اختبار الأسبوع', Color(0x1A4F46E5), AppColors.primary),
                const SizedBox(height: 4),
                Text('${q['title'] ?? ''}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
                Text('${q['questionCount']} سؤال${minutes != null && minutes > 0 ? ' · ⏱ $minutes دقيقة' : ''}', style: const TextStyle(color: AppColors.muted, fontSize: 13)),
                if (locked)
                  const Padding(
                    padding: EdgeInsets.only(top: 4),
                    child: Text('🔒 حصص الأسبوع ده هتفتح بعد ما تحل الاختبار', style: TextStyle(color: AppColors.warningText, fontWeight: FontWeight.w700, fontSize: 12.5)),
                  ),
                if (status == 'submitted')
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(
                      'درجتك: ${q['score']} / ${q['maxScore']}${(asInt(q['pendingCount']) ?? 0) > 0 ? ' · ⏳ مقالي بيتصحح' : ''}${q['redoAvailable'] == true ? ' · ↻ متاح تحل تاني' : ''}',
                      style: const TextStyle(color: AppColors.successText, fontWeight: FontWeight.w800),
                    ),
                  ),
              ]),
            ),
            const SizedBox(width: 8),
            Text(action, style: const TextStyle(color: AppColors.primary, fontWeight: FontWeight.w800, fontSize: 13)),
          ]),
        ),
      ),
    );
  }

  Future<void> _openLesson(Map<String, dynamic> lesson) async {
    final id = asInt(lesson['videoId'])!;
    if (!await ensureLessonAccess(context, id) || !mounted) return;
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => LessonViewScreen(videoId: id, title: '${lesson['title'] ?? ''}')));
    widget.onChanged();
  }

  /// كل فيديوهات الواجب للدرس (السيرفر القديم كان بيبعت لينك واحد بس في realHomeworkUrl)
  List<Map<String, dynamic>> _homeworkVideos(Map<String, dynamic> lesson) {
    final list = ((lesson['homeworkVideos'] as List?) ?? []).whereType<Map>().map((p) => p.cast<String, dynamic>()).toList();
    if (list.isNotEmpty) return list;
    final url = '${lesson['realHomeworkUrl'] ?? ''}';
    return url.isEmpty ? [] : [{'sourceType': 'url', 'videoUrl': url}];
  }

  Future<void> _openHomework(Map<String, dynamic> lesson) async {
    final parts = _homeworkVideos(lesson).map((p) {
      final url = '${p['videoUrl'] ?? ''}'.trim();
      if (p['sourceType'] == 'upload' || url.isEmpty || url.startsWith('http://') || url.startsWith('https://')) return p;
      return {...p, 'videoUrl': 'https://$url'};
    }).toList();
    if (parts.isEmpty) return;
    // لينك واحد مش فيديو (موقع عادي) بيفتح في المتصفح زي الأول، غير كده كله جوه البرنامج
    if (parts.length == 1 && sourceForPart(parts.first).kind == VideoKind.unknown) {
      await openVideoOrLink(context, '${parts.first['videoUrl']}', 'فيديو الواجب');
      return;
    }
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => VideoScreen(title: 'فيديو الواجب', parts: parts)));
  }

  Future<void> _openQuestions(Map<String, dynamic> lesson) async {
    final id = asInt(lesson['videoId'])!;
    if (!await ensureLessonAccess(context, id) || !mounted) return;
    try {
      final res = await PortalApi.lessonParts(id);
      final questions = (((res['parts'] as Map?)?['questions'] as List?) ?? []).cast<Map<String, dynamic>>();
      if (questions.isEmpty || !mounted) return;
      await Navigator.of(context).push(MaterialPageRoute(builder: (_) => VideoScreen(title: '❓ الأسئلة', parts: questions)));
    } on ApiException catch (e) {
      if (mounted) toast(context, e.message, error: true);
    }
  }

  Widget _card({required Color top, required Widget badge, required String number, required IconData icon, required List<Color> iconColors, required String title, required String date, List<Widget> extra = const [], required VoidCallback onTap}) {
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Container(
          decoration: BoxDecoration(border: Border(top: BorderSide(color: top, width: 4))),
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [badge, const Spacer(), Pill(number, top.withValues(alpha: 0.12), top)]),
            const SizedBox(height: 12),
            Row(children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(gradient: LinearGradient(colors: iconColors), borderRadius: BorderRadius.circular(12)),
                child: Icon(icon, color: Colors.white),
              ),
              const SizedBox(width: 12),
              Expanded(child: Text(title, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15.5))),
            ]),
            const SizedBox(height: 10),
            Text('📅 $date', style: const TextStyle(color: AppColors.muted, fontSize: 13)),
            ...extra,
          ]),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final cards = <Widget>[];
    for (final q in _quizzes) {
      cards.add(_quizCard(q));
      final video = '${q['answerVideoUrl'] ?? ''}';
      if (video.isNotEmpty) {
        cards.add(_card(
          top: AppColors.warning,
          badge: const Pill('فيديو شرح الاختبار', AppColors.warningSoft, AppColors.warningText),
          number: 'الأسبوع ${widget.weekNumber ?? ''}',
          icon: Icons.play_arrow_rounded,
          iconColors: const [AppColors.warning, Color(0xFFEF4444)],
          title: 'فيديو شرح الاختبار',
          date: '${q['title'] ?? ''}',
          onTap: () => openVideoOrLink(context, video, 'فيديو شرح الاختبار'),
        ));
      }
    }
    for (final l in _lessons) {
      // الأسبوع مقفول لحد ما الطالب يحل اختباره: الكارت بيوديه على الاختبار
      final quizLocked = _quizMode && l['quizLocked'] == true;
      final number = 'حصة ${l['lessonNumber']}';
      final date = '${l['date'] ?? '-'}';
      final status = '${l['status'] ?? 'locked'}';
      final label = _statusLabels[status];
      final badge = quizLocked
          ? const Pill('🔒 حل الاختبار الأول', AppColors.warningSoft, AppColors.warningText)
          : (label == null ? const SizedBox.shrink() : Pill(label.$1, label.$2, label.$3));
      final expires = l['accessExpiresAt'] == null ? null : DateTime.tryParse('${l['accessExpiresAt']}');
      final extra = <Widget>[
        if (status == 'expired')
          const Padding(padding: EdgeInsets.only(top: 6), child: Text('انتهت المدة', style: TextStyle(color: AppColors.muted, fontWeight: FontWeight.w600, fontSize: 13)))
        else if (expires != null)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              expires.isAfter(DateTime.now()) ? 'متبقي: ${formatRemaining(expires.difference(DateTime.now()).inSeconds)}' : 'انتهت المدة',
              style: const TextStyle(color: AppColors.muted, fontWeight: FontWeight.w600, fontSize: 13),
            ),
          )
        else if (status == 'granted' && l['unlimited'] == true)
          const Padding(padding: EdgeInsets.only(top: 6), child: Text('يبدأ الحساب عند أول فتح', style: TextStyle(color: AppColors.muted, fontWeight: FontWeight.w600, fontSize: 13))),
        ...popupResultPills(((widget.popupResults['${l['videoId']}'] as List?) ?? []).cast<Map<String, dynamic>>()),
      ];
      cards.add(_card(
        top: AppColors.primary,
        badge: badge,
        number: number,
        icon: Icons.play_arrow_rounded,
        iconColors: const [AppColors.primary, Color(0xFF6366F1)],
        title: '${l['title'] ?? ''}',
        date: date,
        extra: extra,
        onTap: () => quizLocked && asInt(l['quizId']) != null ? _openQuiz(asInt(l['quizId'])!, '') : _openLesson(l),
      ));
      if (!quizLocked && l['hasQuestions'] == true && (l['questionsDisplay'] == 'outside' || l['questionsDisplay'] == 'both')) {
        cards.add(_card(
          top: const Color(0xFFEC4899),
          badge: badge,
          number: number,
          icon: Icons.help_outline,
          iconColors: const [Color(0xFFEC4899), AppColors.warning],
          title: 'الأسئلة',
          date: date,
          onTap: () => _openQuestions(l),
        ));
      }
      // وضع اختبار المنصة: الروابط القديمة مبتظهرش (كارت الاختبار فوق مكانها)
      final examUrl = _quizMode ? '' : '${l['examUrl'] ?? l['exam_url'] ?? ''}';
      if (examUrl.isNotEmpty) {
        cards.add(_card(
          top: const Color(0xFF4F46E5),
          badge: const Pill('الاختبار', Color(0xFFE0E7FF), AppColors.primary),
          number: number,
          icon: Icons.quiz_outlined,
          iconColors: const [Color(0xFF4F46E5), Color(0xFF10B3A3)],
          title: 'الاختبار',
          date: date,
          onTap: () => launchUrl(Uri.parse(examUrl), mode: LaunchMode.externalApplication),
        ));
      }
      final examVideo = _quizMode ? '' : '${l['examVideoUrl'] ?? l['exam_video_url'] ?? ''}';
      if (examVideo.isNotEmpty) {
        cards.add(_card(
          top: AppColors.warning,
          badge: const Pill('فيديو إجابة الاختبار', AppColors.warningSoft, AppColors.warningText),
          number: number,
          icon: Icons.play_arrow_rounded,
          iconColors: const [AppColors.warning, Color(0xFFEF4444)],
          title: 'فيديو إجابة الاختبار',
          date: date,
          onTap: () => openVideoOrLink(context, examVideo, 'فيديو إجابة الاختبار'),
        ));
      }
      if (!quizLocked && _homeworkVideos(l).isNotEmpty) {
        cards.add(_card(
          top: const Color(0xFF10B3A3),
          badge: const Pill('فيديو الواجب', AppColors.successSoft, AppColors.successText),
          number: number,
          icon: Icons.play_arrow_rounded,
          iconColors: const [Color(0xFF10B3A3), Color(0xFF4F46E5)],
          title: 'فيديو الواجب',
          date: date,
          onTap: () => _openHomework(l),
        ));
      }
    }
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: ListView.separated(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 40),
        itemCount: cards.length,
        separatorBuilder: (_, _) => const SizedBox(height: 12),
        itemBuilder: (_, i) => cards[i],
      ),
    );
  }
}
