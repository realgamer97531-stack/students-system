import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../../services/api.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import '../../widgets/math_text.dart';
import 'video_screen.dart';

const _letters = ['أ', 'ب', 'ج', 'د', 'هـ', 'و'];

double _num(dynamic v) => v is num ? v.toDouble() : (double.tryParse('$v') ?? 0);
String _fmt(dynamic v) {
  final d = _num(v);
  return d == d.roundToDouble() ? d.toInt().toString() : d.toStringAsFixed(d * 10 == (d * 10).roundToDouble() ? 1 : 2);
}

/// اختبار المنصة: قبل البداية / أثناء الحل (حفظ تلقائي + وقت) / النتيجة وفيديو الشرح.
/// بيرجع true لو الطالب سلّم (عشان صفحة الأسبوع تتحدث وتفتح الحصص).
class QuizScreen extends StatefulWidget {
  const QuizScreen({super.key, required this.quizId, this.title});
  final int quizId;
  final String? title;
  @override
  State<QuizScreen> createState() => _QuizScreenState();
}

class _QuizScreenState extends State<QuizScreen> {
  Map<String, dynamic>? _data;
  String? _error;
  bool _loading = true;
  bool _starting = false;
  bool _submitting = false;
  bool _changed = false;
  Map<String, dynamic> _answers = {};
  final Map<String, TextEditingController> _essay = {};
  String? _uploading;
  Duration _clockOffset = Duration.zero;
  Timer? _timer;
  Timer? _saveTimer;
  bool _saveInFlight = false;
  String _saveState = '';
  final _scroll = ScrollController();

  Map<String, dynamic> get _quiz => (_data!['quiz'] as Map).cast<String, dynamic>();
  Map<String, dynamic>? get _attempt => (_data?['attempt'] as Map?)?.cast<String, dynamic>();
  List<Map<String, dynamic>> get _questions => ((_data?['questions'] as List?) ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _timer?.cancel();
    _saveTimer?.cancel();
    // لو فيه إجابات لسه متبعتتش نحاول نبعتها قبل ما الشاشة تتقفل
    if (_saveState == 'pending' && _attempt?['status'] == 'in_progress') {
      PortalApi.saveQuiz(widget.quizId, _answers).catchError((_) => <String, dynamic>{});
    }
    for (final c in _essay.values) {
      c.dispose();
    }
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    _timer?.cancel();
    setState(() => _loading = true);
    try {
      final data = await PortalApi.quiz(widget.quizId);
      final serverNow = DateTime.tryParse('${data['serverNow']}');
      if (!mounted) return;
      setState(() {
        _data = data;
        _error = null;
        _loading = false;
        if (serverNow != null) _clockOffset = serverNow.difference(DateTime.now());
        final attempt = _attempt;
        if (attempt != null && attempt['status'] == 'in_progress') {
          _answers = ((attempt['answers'] as Map?) ?? {}).map((k, v) => MapEntry('$k', v));
          for (final q in _questions.where((q) => q['type'] == 'essay' && q['requiresAnswer'] == true)) {
            final id = '${q['id']}';
            (_essay[id] ??= TextEditingController()).text = '${(_answers[id] as Map?)?['text'] ?? ''}';
          }
          _startTimer();
        }
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.status == 404 ? 'الاختبار ده مش متاح ليك' : (e.offline ? 'الاختبار محتاج نت — اتأكد من النت وجرب تاني' : e.message);
      });
    }
  }

  Future<void> _start() async {
    final minutes = asInt(_quiz['timeLimitMinutes']);
    if (minutes != null && minutes > 0) {
      final ok = await confirmDialog(context, title: '⏱ الاختبار بوقت', message: 'الوقت ($minutes دقيقة) هيبدأ أول ما تدوس ابدأ، ومينفعش يتوقف. جاهز؟', ok: 'ابدأ', cancel: 'لسه');
      if (!ok) return;
    }
    setState(() => _starting = true);
    try {
      final res = await PortalApi.startQuiz(widget.quizId);
      if (res['success'] != true && mounted) toast(context, '${res['message'] ?? 'حصلت مشكلة'}', error: true);
      _answers = {};
      await _load();
    } on ApiException catch (e) {
      if (mounted) toast(context, e.message, error: true);
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  // ===== أثناء الحل =====

  bool _needsAnswer(Map<String, dynamic> q) => q['type'] == 'mcq' || (q['type'] == 'essay' && q['requiresAnswer'] == true);
  bool _isAnswered(Map<String, dynamic> q) {
    final a = _answers['${q['id']}'] as Map?;
    if (a == null) return false;
    if (q['type'] == 'mcq') return a['choice'] is int;
    return '${a['text'] ?? ''}'.trim().isNotEmpty || a['image'] != null;
  }

  void _scheduleSave() {
    setState(() => _saveState = 'pending');
    _saveTimer?.cancel();
    _saveTimer = Timer(const Duration(milliseconds: 800), _saveNow);
  }

  Future<void> _saveNow() async {
    if (_submitting || !mounted) return;
    if (_saveInFlight) {
      _saveTimer = Timer(const Duration(milliseconds: 500), _saveNow);
      return;
    }
    _saveInFlight = true;
    try {
      final res = await PortalApi.saveQuiz(widget.quizId, _answers);
      if (!mounted) return;
      if (res['submitted'] == true) {
        _changed = true;
        await _load();
        return;
      }
      setState(() => _saveState = res['success'] == true ? 'saved' : 'offline');
    } on ApiException catch (_) {
      if (!mounted) return;
      setState(() => _saveState = 'offline');
      _saveTimer = Timer(const Duration(seconds: 5), _saveNow);
    } finally {
      _saveInFlight = false;
    }
  }

  void _startTimer() {
    final deadline = DateTime.tryParse('${_attempt?['deadlineAt'] ?? ''}');
    if (deadline == null) return;
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() {});
      if (_secondsLeft(deadline) <= 0) {
        _timer?.cancel();
        _submit(timeUp: true);
      }
    });
  }

  int _secondsLeft(DateTime deadline) => deadline.difference(DateTime.now().add(_clockOffset)).inSeconds;

  Future<void> _pickPhoto(String qid) async {
    final source = await showModalBottomSheet<ImageSource>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Wrap(children: [
          ListTile(leading: const Icon(Icons.photo_camera), title: const Text('صوّر الحل'), onTap: () => Navigator.pop(ctx, ImageSource.camera)),
          ListTile(leading: const Icon(Icons.photo_library), title: const Text('من الصور'), onTap: () => Navigator.pop(ctx, ImageSource.gallery)),
        ]),
      ),
    );
    if (source == null) return;
    final x = await ImagePicker().pickImage(source: source, maxWidth: 1600, imageQuality: 85);
    if (x == null || !mounted) return;
    setState(() => _uploading = qid);
    try {
      final url = await PortalApi.uploadQuizAnswerImage(widget.quizId, File(x.path));
      _answers[qid] = {...((_answers[qid] as Map?) ?? {}), 'image': url};
      _scheduleSave();
    } on ApiException catch (e) {
      if (mounted) toast(context, e.offline ? 'رفع الصورة محتاج نت' : e.message, error: true);
    } finally {
      if (mounted) setState(() => _uploading = null);
    }
  }

  Future<void> _submit({bool timeUp = false}) async {
    if (_submitting) return;
    if (!timeUp) {
      final left = _questions.where((q) => _needsAnswer(q) && !_isAnswered(q)).length;
      final ok = await confirmDialog(
        context,
        title: 'تسليم الاختبار',
        message: left > 0 ? 'لسه فيه $left سؤال مجاوبتش عليه.\nتسلّم برضه؟ مش هتقدر تغيّر إجاباتك بعد التسليم.' : 'تسلّم الاختبار؟ مش هتقدر تغيّر إجاباتك بعد التسليم.',
        ok: 'سلّم',
        cancel: 'لسه',
      );
      if (!ok) return;
    }
    _saveTimer?.cancel();
    setState(() => _submitting = true);
    if (timeUp && mounted) toast(context, '⏰ الوقت خلص — بنسلّم إجاباتك…');
    for (var tries = 0; tries < 4; tries++) {
      try {
        final res = await PortalApi.submitQuiz(widget.quizId, _answers);
        if (res['success'] == true || res['submitted'] == true) {
          _changed = true;
          _timer?.cancel();
          if (!mounted) return;
          setState(() => _submitting = false);
          if (_scroll.hasClients) _scroll.jumpTo(0);
          await _load();
          return;
        }
        if (mounted) toast(context, '${res['message'] ?? 'حصلت مشكلة'}', error: true);
        break;
      } on ApiException catch (e) {
        if (!e.offline) {
          if (mounted) toast(context, e.message, error: true);
          break;
        }
        await Future.delayed(Duration(seconds: 2 * (tries + 1)));
      }
    }
    if (mounted) {
      setState(() {
        _submitting = false;
        _saveState = 'offline';
      });
      toast(context, 'التسليم محتاج نت — إجاباتك محفوظة، جرب تاني', error: true);
    }
  }

  // ===== الواجهة =====

  Widget _image(String? url, {double maxHeight = 360}) {
    if (url == null || url.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: GestureDetector(
        onTap: () => showDialog(
          context: context,
          builder: (_) => Dialog(
            insetPadding: const EdgeInsets.all(8),
            child: InteractiveViewer(maxScale: 5, child: Image.network(url)),
          ),
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(12),
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: maxHeight),
            child: Image.network(url, fit: BoxFit.contain, errorBuilder: (_, _, _) => const Icon(Icons.broken_image_outlined, color: AppColors.muted)),
          ),
        ),
      ),
    );
  }

  Widget _questionHeader(int i, Map<String, dynamic> q) => Row(children: [
        Text('سؤال ${i + 1}', style: const TextStyle(fontWeight: FontWeight.w800, color: AppColors.primary, fontSize: 15)),
        const Spacer(),
        Pill('${_fmt(q['marks'])} درجة', AppColors.neutralSoft, AppColors.muted),
      ]);

  Widget _choice(Map<String, dynamic> c, int ci, {required Color border, required Color fill, required Color letterBg, required Color letterFg, VoidCallback? onTap}) {
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Material(
        color: fill,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: BorderSide(color: border, width: 2)),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
              Container(
                width: 32,
                height: 32,
                alignment: Alignment.center,
                decoration: BoxDecoration(color: letterBg, shape: BoxShape.circle, border: Border.all(color: border, width: 2)),
                child: Text(_letters[ci], style: TextStyle(fontWeight: FontWeight.w800, color: letterFg)),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  if ('${c['text'] ?? ''}'.trim().isNotEmpty) MathText('${c['text']}', style: const TextStyle(fontSize: 16)),
                  _image(c['image'] as String?, maxHeight: 180),
                ]),
              ),
            ]),
          ),
        ),
      ),
    );
  }

  Widget _takingQuestion(int i, Map<String, dynamic> q) {
    final id = '${q['id']}';
    final a = _answers[id] as Map?;
    Widget body;
    if (q['type'] == 'mcq') {
      final choices = ((q['choices'] as List?) ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList();
      body = Column(children: [
        for (var ci = 0; ci < choices.length; ci++)
          _choice(
            choices[ci],
            ci,
            border: a?['choice'] == ci ? AppColors.primary : const Color(0xFFE2E8F0),
            fill: a?['choice'] == ci ? AppColors.primary.withValues(alpha: 0.08) : Colors.transparent,
            letterBg: a?['choice'] == ci ? AppColors.primary : Colors.transparent,
            letterFg: a?['choice'] == ci ? Colors.white : AppColors.muted,
            onTap: () {
              setState(() => _answers[id] = {'choice': ci});
              _scheduleSave();
            },
          ),
      ]);
    } else if (q['type'] == 'essay' && q['requiresAnswer'] == true) {
      final image = a?['image'] as String?;
      body = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const SizedBox(height: 12),
        TextField(
          controller: _essay[id] ??= TextEditingController(),
          minLines: 3,
          maxLines: 10,
          decoration: const InputDecoration(hintText: 'اكتب إجابتك هنا…', border: OutlineInputBorder()),
          onChanged: (v) {
            _answers[id] = {...((_answers[id] as Map?) ?? {}), 'text': v};
            _scheduleSave();
          },
        ),
        const SizedBox(height: 8),
        Row(children: [
          OutlinedButton.icon(
            onPressed: _uploading != null ? null : () => _pickPhoto(id),
            icon: _uploading == id ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.photo_camera_outlined),
            label: Text(image == null ? 'صورة الحل' : 'غيّر الصورة'),
          ),
          if (image != null)
            TextButton(
              onPressed: () {
                setState(() => (_answers[id] as Map).remove('image'));
                _scheduleSave();
              },
              child: const Text('شيل الصورة', style: TextStyle(color: AppColors.danger)),
            ),
        ]),
        _image(image, maxHeight: 200),
      ]);
    } else {
      body = Container(
        margin: const EdgeInsets.only(top: 12),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: AppColors.successSoft, borderRadius: BorderRadius.circular(12)),
        child: const Text('⭐ السؤال ده درجته عندك تلقائي — مش محتاج تجاوب.', style: TextStyle(color: AppColors.successText, fontWeight: FontWeight.w700)),
      );
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          _questionHeader(i, q),
          const SizedBox(height: 10),
          if ('${q['text'] ?? ''}'.trim().isNotEmpty) MathText('${q['text']}', style: const TextStyle(fontSize: 17, height: 1.7)),
          _image(q['image'] as String?),
          body,
        ]),
      ),
    );
  }

  Widget _taking() {
    final qs = _questions;
    final required = qs.where(_needsAnswer).toList();
    final done = required.where(_isAnswered).length;
    final saveLabel = switch (_saveState) {
      'pending' => '⏳ بيتحفظ…',
      'saved' => '✓ اتحفظ',
      'offline' => '⚠️ مفيش نت — هيتحفظ لما يرجع',
      _ => '',
    };
    return Column(children: [
      Expanded(
        child: ListView.separated(
          controller: _scroll,
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
          itemCount: qs.length,
          separatorBuilder: (_, _) => const SizedBox(height: 12),
          itemBuilder: (_, i) => _takingQuestion(i, qs[i]),
        ),
      ),
      Material(
        elevation: 8,
        child: SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
            child: Row(children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(99),
                    child: LinearProgressIndicator(value: required.isEmpty ? 1 : done / required.length, minHeight: 8),
                  ),
                  const SizedBox(height: 4),
                  Text('جاوبت $done من ${required.length}   $saveLabel', style: const TextStyle(fontSize: 12, color: AppColors.muted, fontWeight: FontWeight.w700)),
                ]),
              ),
              const SizedBox(width: 12),
              FilledButton.icon(
                // الثيم بيخلي FilledButton بعرض الشاشة — جوه Row لازم عرض محدد
                style: FilledButton.styleFrom(minimumSize: const Size(110, 46)),
                onPressed: _submitting ? null : () => _submit(),
                icon: _submitting ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : const Icon(Icons.check_circle_outline),
                label: const Text('تسليم'),
              ),
            ]),
          ),
        ),
      ),
    ]);
  }

  Widget _fact(String value, String label) => Container(
        width: 96,
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: BoxDecoration(border: Border.all(color: const Color(0xFFE2E8F0)), borderRadius: BorderRadius.circular(14)),
        child: Column(children: [
          Text(value, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: AppColors.primary)),
          Text(label, style: const TextStyle(fontSize: 12, color: AppColors.muted, fontWeight: FontWeight.w600)),
        ]),
      );

  Widget _intro() {
    final q = _quiz;
    final minutes = asInt(q['timeLimitMinutes']);
    return ListView(padding: const EdgeInsets.all(16), children: [
      Card(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(children: [
            Container(
              width: 68,
              height: 68,
              decoration: BoxDecoration(gradient: const LinearGradient(colors: [AppColors.accent, AppColors.primary]), borderRadius: BorderRadius.circular(20)),
              child: const Icon(Icons.quiz_outlined, color: Colors.white, size: 34),
            ),
            const SizedBox(height: 12),
            Text('الأسبوع ${q['weekNumber']}', style: const TextStyle(color: AppColors.muted, fontWeight: FontWeight.w700)),
            Text('${q['title']}', textAlign: TextAlign.center, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
            const SizedBox(height: 16),
            Wrap(spacing: 10, runSpacing: 10, alignment: WrapAlignment.center, children: [
              _fact('${q['questionCount']}', 'سؤال'),
              _fact(_fmt(q['totalMarks']), 'درجة'),
              _fact(minutes != null && minutes > 0 ? '$minutes' : '∞', minutes != null && minutes > 0 ? 'دقيقة' : 'من غير وقت'),
            ]),
            if ('${q['instructions'] ?? ''}'.trim().isNotEmpty) ...[
              const SizedBox(height: 14),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: AppColors.primary.withValues(alpha: 0.07), borderRadius: BorderRadius.circular(12)),
                child: MathText('${q['instructions']}', style: const TextStyle(height: 1.7)),
              ),
            ],
            const SizedBox(height: 14),
            const Text('معاك محاولة واحدة بس. إجاباتك بتتحفظ أول بأول.', textAlign: TextAlign.center, style: TextStyle(color: AppColors.muted, fontSize: 13)),
            if (q['locked'] == true)
              const Padding(
                padding: EdgeInsets.only(top: 6),
                child: Text('🔒 حصص الأسبوع ده هتفتح أول ما تسلّم الاختبار.', textAlign: TextAlign.center, style: TextStyle(color: AppColors.warningText, fontWeight: FontWeight.w700)),
              ),
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: _starting ? null : _start,
                style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 14)),
                icon: const Icon(Icons.rocket_launch_outlined),
                label: const Text('ابدأ الاختبار', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
              ),
            ),
          ]),
        ),
      ),
    ]);
  }

  Widget _result() {
    final a = _attempt!;
    final q = _quiz;
    final score = _num(a['score']);
    final max = _num(a['maxScore']);
    final pct = max > 0 ? score / max : 0.0;
    final pending = asInt(a['pendingCount']) ?? 0;
    final results = ((a['results'] as Map?) ?? {}).map((k, v) => MapEntry('$k', (v as Map).cast<String, dynamic>()));
    final answers = ((a['answers'] as Map?) ?? {}).map((k, v) => MapEntry('$k', v));
    final video = '${q['answerVideoUrl'] ?? ''}';
    return ListView(controller: _scroll, padding: const EdgeInsets.all(16), children: [
      Card(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(children: [
            const Text('نتيجتك', style: TextStyle(color: AppColors.muted, fontWeight: FontWeight.w700)),
            const SizedBox(height: 12),
            SizedBox(
              width: 150,
              height: 150,
              child: Stack(alignment: Alignment.center, children: [
                SizedBox.expand(child: CircularProgressIndicator(value: pct.clamp(0, 1).toDouble(), strokeWidth: 12, backgroundColor: const Color(0xFFE2E8F0), color: AppColors.accent)),
                Column(mainAxisSize: MainAxisSize.min, children: [
                  Directionality(
                    textDirection: TextDirection.ltr,
                    child: Text.rich(TextSpan(children: [
                      TextSpan(text: _fmt(score), style: const TextStyle(fontSize: 32, fontWeight: FontWeight.w900)),
                      TextSpan(text: ' / ${_fmt(max)}', style: const TextStyle(fontSize: 15, color: AppColors.muted, fontWeight: FontWeight.w700)),
                    ])),
                  ),
                  Text('${(pct * 100).round()}%', style: const TextStyle(color: AppColors.muted, fontWeight: FontWeight.w700)),
                ]),
              ]),
            ),
            if (pending > 0)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text('⏳ فيه $pending سؤال مقالي لسه بيتصحح — درجتك ممكن تزيد.', textAlign: TextAlign.center, style: const TextStyle(color: AppColors.warningText, fontWeight: FontWeight.w700)),
              ),
            if (a['autoSubmitted'] == true)
              const Padding(padding: EdgeInsets.only(top: 6), child: Text('الاختبار اتسلّم تلقائي لما الوقت خلص.', style: TextStyle(color: AppColors.muted, fontSize: 13))),
            if (q['redoAvailable'] == true) ...[
              const SizedBox(height: 12),
              const Text('المدرس سمحلك تحل تاني. آخر محاولة هي اللي هتتحسب.', textAlign: TextAlign.center, style: TextStyle(color: AppColors.primary, fontSize: 13)),
              const SizedBox(height: 6),
              OutlinedButton.icon(onPressed: _starting ? null : _start, icon: const Icon(Icons.replay), label: const Text('حل الاختبار تاني')),
            ],
          ]),
        ),
      ),
      const SizedBox(height: 12),
      Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            if (video.isNotEmpty) ...[
              const Text('🎬 فيديو شرح الاختبار', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
              const SizedBox(height: 10),
              FilledButton.icon(
                onPressed: () => openVideoOrLink(context, video, 'فيديو شرح الاختبار'),
                style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 12)),
                icon: const Icon(Icons.play_circle_outline),
                label: const Text('شوف الشرح دلوقتي'),
              ),
              const SizedBox(height: 8),
            ],
            OutlinedButton.icon(
              onPressed: () => Navigator.of(context).pop(true),
              style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 12)),
              icon: const Icon(Icons.video_library_outlined),
              label: Text(video.isNotEmpty ? 'هشوفه بعدين — افتح حصص الأسبوع' : 'افتح حصص الأسبوع'),
            ),
            if (video.isNotEmpty)
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: Text('الفيديو هيفضل موجود جوه الأسبوع تقدر ترجعله في أي وقت.', style: TextStyle(color: AppColors.muted, fontSize: 12.5)),
              ),
          ]),
        ),
      ),
      const Padding(padding: EdgeInsets.fromLTRB(4, 20, 4, 8), child: Text('مراجعة إجاباتك', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 17))),
      for (var i = 0; i < _questions.length; i++) ...[
        _reviewQuestion(i, _questions[i], results['${_questions[i]['id']}'], answers['${_questions[i]['id']}'] as Map?),
        const SizedBox(height: 12),
      ],
    ]);
  }

  Widget _reviewQuestion(int i, Map<String, dynamic> q, Map<String, dynamic>? r, Map? a) {
    final auto = q['type'] == 'bonus' || (q['type'] == 'essay' && q['requiresAnswer'] != true);
    Widget body = const SizedBox.shrink();
    if (q['type'] == 'mcq') {
      final choices = ((q['choices'] as List?) ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList();
      final chosen = a?['choice'];
      final correct = q['correctIndex'];
      body = Column(children: [
        for (var ci = 0; ci < choices.length; ci++)
          _choice(
            choices[ci],
            ci,
            border: ci == correct ? AppColors.successText : (ci == chosen ? AppColors.danger : const Color(0xFFE2E8F0)),
            fill: ci == correct ? AppColors.successSoft : (ci == chosen ? AppColors.dangerSoft : Colors.transparent),
            letterBg: ci == correct ? AppColors.successText : (ci == chosen ? AppColors.danger : Colors.transparent),
            letterFg: ci == correct || ci == chosen ? Colors.white : AppColors.muted,
          ),
      ]);
    } else if (q['type'] == 'essay' && q['requiresAnswer'] == true && a != null) {
      body = Container(
        margin: const EdgeInsets.only(top: 12),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: AppColors.primary.withValues(alpha: 0.06), borderRadius: BorderRadius.circular(12)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('إجابتك', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 12.5)),
          if ('${a['text'] ?? ''}'.trim().isNotEmpty) Text('${a['text']}'),
          _image(a['image'] as String?, maxHeight: 220),
        ]),
      );
    }
    Widget? verdict;
    if (r != null) {
      final pending = r['pending'] == true;
      final right = r['correct'] == true || _num(r['earned']) > 0;
      final label = pending ? '⏳ مستني التصحيح' : auto ? '⭐ درجة كاملة' : r['unanswered'] == true ? 'مجاوبتش' : right ? '✔ صح' : '✘ غلط';
      final bg = pending ? AppColors.warningSoft : (auto || right ? AppColors.successSoft : AppColors.dangerSoft);
      final fg = pending ? AppColors.warningText : (auto || right ? AppColors.successText : AppColors.dangerText);
      verdict = Container(
        margin: const EdgeInsets.only(top: 12),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12)),
        child: Row(children: [
          Text(label, style: TextStyle(color: fg, fontWeight: FontWeight.w800)),
          const Spacer(),
          Text(pending ? '— / ${_fmt(r['max'])}' : '${_fmt(r['earned'])} / ${_fmt(r['max'])}', textDirection: TextDirection.ltr, style: TextStyle(color: fg, fontWeight: FontWeight.w800)),
        ]),
      );
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          _questionHeader(i, q),
          const SizedBox(height: 10),
          if ('${q['text'] ?? ''}'.trim().isNotEmpty) MathText('${q['text']}', style: const TextStyle(fontSize: 16.5, height: 1.7)),
          _image(q['image'] as String?),
          body,
          ?verdict,
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final attempt = _attempt;
    final deadline = attempt?['status'] == 'in_progress' ? DateTime.tryParse('${attempt?['deadlineAt'] ?? ''}') : null;
    final left = deadline == null ? null : _secondsLeft(deadline).clamp(0, 1 << 30);
    Widget body;
    if (_loading && _data == null) {
      body = const Center(child: CircularProgressIndicator());
    } else if (_error != null) {
      body = ErrorView(message: _error!, onRetry: _load);
    } else if (attempt != null && attempt['status'] == 'in_progress') {
      body = _taking();
    } else if (attempt != null && attempt['status'] == 'submitted') {
      body = _result();
    } else {
      body = _intro();
    }
    return PopScope(
      canPop: attempt?['status'] != 'in_progress',
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        // أثناء الحل: الخروج مش بيسلّم، الإجابات بتفضل محفوظة والوقت (لو فيه) شغال
        final ok = await confirmDialog(context, title: 'تخرج من الاختبار؟', message: 'إجاباتك محفوظة وتقدر تكمّل بعدين${deadline != null ? '، بس الوقت هيفضل شغال' : ''}.', ok: 'اخرج', cancel: 'كمّل');
        if (ok && context.mounted) {
          await _saveNow();
          if (context.mounted) Navigator.of(context).pop(_changed);
        }
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text('${_data == null ? (widget.title ?? 'الاختبار') : _quiz['title']}', overflow: TextOverflow.ellipsis),
          leading: BackButton(onPressed: () => Navigator.of(context).maybePop(_changed)),
          actions: [
            if (left != null)
              Container(
                margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                padding: const EdgeInsets.symmetric(horizontal: 10),
                alignment: Alignment.center,
                decoration: BoxDecoration(color: left <= 60 ? AppColors.dangerSoft : Colors.white.withValues(alpha: 0.9), borderRadius: BorderRadius.circular(10)),
                child: Text(
                  '${left ~/ 60}:${(left % 60).toString().padLeft(2, '0')}',
                  textDirection: TextDirection.ltr,
                  style: TextStyle(fontWeight: FontWeight.w800, color: left <= 60 ? AppColors.dangerText : AppColors.primary, fontFeatures: const [FontFeature.tabularFigures()]),
                ),
              ),
          ],
        ),
        body: body,
      ),
    );
  }
}
