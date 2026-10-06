import 'dart:async';

import 'package:flutter/material.dart';

import '../../services/api.dart';
import '../../services/cache.dart';
import '../../services/outbox.dart';
import '../../services/session_store.dart';
import '../../theme.dart';
import '../../widgets/ads.dart';
import '../../widgets/broadcasts.dart';
import '../../widgets/common.dart';
import '../../widgets/lesson_video.dart';
import '../../widgets/popup_question.dart';
import '../../widgets/video_source.dart';

/// مشاهدة الدرس (نفس lesson-view.html): شرح / أسئلة / حل الواجب + الأسئلة المنبثقة + تسجيل المشاهدة
class LessonViewScreen extends StatefulWidget {
  const LessonViewScreen({super.key, required this.videoId, required this.title});
  final int videoId;
  final String title;
  @override
  State<LessonViewScreen> createState() => _LessonViewScreenState();
}

class _LessonViewScreenState extends State<LessonViewScreen> {
  static const _categories = ['explanation', 'questions', 'homework_solution'];
  static const _categoryLabels = {'explanation': '📖 الشرح', 'questions': '❓ الأسئلة', 'homework_solution': '✅ حل الواجب'};

  Map<String, List<Map<String, dynamic>>> _parts = {};
  String _title = '';
  String _questionsDisplay = 'inside';
  List<Map<String, dynamic>> _popups = [];
  bool _loading = true;
  String? _error;
  bool _fromCache = false;

  String _category = 'explanation';
  int _index = 0;
  int _playerKey = 0;
  final _video = LessonVideoController();

  // تسجيل المشاهدة والأسئلة
  List<Map<String, dynamic>> _partPopups = [];
  bool _popupActive = false;
  Timer? _estimateTimer;
  Timer? _popupPoll;
  DateTime? _openedAt;
  int _estimateBase = 0;
  int _estimateLastSent = 0;
  int? _estimatePartId;
  int _lastDirectSent = 0;
  int _lastYtSent = 0;
  final Map<int, int> _inFlight = {};
  final Map<int, int> _latest = {};

  @override
  void initState() {
    super.initState();
    _title = widget.title;
    _load();
    WidgetsBinding.instance.addPostFrameCallback((_) => Ads.showFor(context, AccountType.student, 'lesson-view'));
  }

  @override
  void dispose() {
    _stopTracking();
    super.dispose();
  }

  String get _cacheKey => 'parts_${widget.videoId}';

  Future<void> _load() async {
    Map<String, dynamic>? res;
    try {
      res = await PortalApi.lessonParts(widget.videoId);
      await Cache.write(_cacheKey, res);
    } on ApiException catch (e) {
      if (!e.offline) {
        if (!mounted) return;
        toast(context, e.message.isEmpty ? 'لا يمكن فتح هذا الدرس' : e.message, error: true);
        Navigator.of(context).pop();
        return;
      }
      res = ((await Cache.read(_cacheKey))?.data as Map?)?.cast<String, dynamic>();
      _fromCache = true;
      if (res == null) {
        if (mounted) setState(() { _loading = false; _error = 'الفيديوهات محتاجة نت — اتأكد من النت وجرب تاني'; });
        return;
      }
    }
    final incoming = (res['parts'] as Map?)?.cast<String, dynamic>() ?? {};
    List<Map<String, dynamic>> pick(List<String> keys) {
      for (final k in keys) {
        if (incoming[k] is List) return (incoming[k] as List).map((e) => (e as Map).cast<String, dynamic>()).toList();
      }
      return [];
    }

    _parts = {
      'explanation': pick(['explanation', 'explanations', 'explanation_parts']),
      'questions': pick(['questions', 'question', 'qna', 'questions_parts']),
      'homework_solution': pick(['homework_solution', 'homework', 'homework_solutions', 'homeworks', 'homework_parts']),
    };
    _title = '${res['title'] ?? widget.title}';
    _questionsDisplay = '${res['questionsDisplay'] ?? 'inside'}';
    try {
      _popups = (await PortalApi.popupQuestions(widget.videoId)).map((q) => {...q}).toList();
    } catch (_) {
      _popups = [];
    }
    if (!mounted) return;
    setState(() => _loading = false);
    _switchCategory('explanation');
  }

  List<String> get _eligible => _categories.where((c) => c != 'questions' || _questionsDisplay != 'outside').toList();

  String _resolve(String c) {
    if (_eligible.contains(c) && (_parts[c]?.isNotEmpty ?? false)) return c;
    return _eligible.firstWhere((x) => _parts[x]?.isNotEmpty ?? false, orElse: () => 'explanation');
  }

  void _switchCategory(String c) {
    setState(() {
      _category = _resolve(c);
      _index = 0;
    });
    _startPart();
  }

  void _changePart(int dir) {
    final parts = _parts[_category] ?? [];
    final next = _index + dir;
    if (next < 0 || next >= parts.length) return;
    setState(() => _index = next);
    _startPart();
  }

  Map<String, dynamic>? get _part {
    final parts = _parts[_category] ?? [];
    if (parts.isEmpty) return null;
    return parts[_index.clamp(0, parts.length - 1)];
  }

  // ===== المشاهدة =====

  void _sendProgress(int partId, int seconds) {
    if (seconds < 0) return;
    if (_inFlight.containsKey(partId)) {
      _latest[partId] = seconds > (_latest[partId] ?? 0) ? seconds : _latest[partId]!;
      return;
    }
    _inFlight[partId] = seconds;
    PortalApi.watchProgress(partId, seconds).catchError((Object e) {
      if (e is ApiException && e.offline) Outbox.addWatch(partId, seconds);
    }).whenComplete(() {
      _inFlight.remove(partId);
      final latest = _latest.remove(partId);
      if (latest != null && latest > seconds) _sendProgress(partId, latest);
    });
  }

  void _flushEstimate() {
    if (_estimatePartId != null && _estimateLastSent > 0) _sendProgress(_estimatePartId!, _estimateLastSent);
  }

  void _stopTracking() {
    _estimateTimer?.cancel();
    _estimateTimer = null;
    _popupPoll?.cancel();
    _popupPoll = null;
    _flushEstimate();
    _estimatePartId = null;
  }

  void _startPart() {
    _stopTracking();
    final part = _part;
    setState(() => _playerKey++);
    if (part == null) return;
    final partId = asInt(part['id'])!;
    _partPopups = _popups.where((p) => p['videoPartId'] == partId && p['answered'] != true).toList();
    for (final p in _partPopups) {
      p['shown'] = false;
    }
    _lastDirectSent = 0;
    _lastYtSent = 0;
    _openedAt = DateTime.now();
    final source = sourceForPart(part);
    final duration = asInt(part['durationSeconds']) ?? 0;
    if (source.kind == VideoKind.vimeo || source.kind == VideoKind.mediadelivery || source.kind == VideoKind.iframe) {
      // نفس الموقع: المشغلات دي الوقت بيتحسب من لحظة الفتح
      _estimatePartId = partId;
      _estimateBase = asInt(part['watchedSeconds']) ?? 0;
      _estimateLastSent = _estimateBase;
      if (_estimateBase > 0) _sendProgress(partId, _estimateBase);
      void update() {
        final elapsed = DateTime.now().difference(_openedAt!).inSeconds;
        final total = duration > 0 ? (_estimateBase + elapsed).clamp(0, duration) : _estimateBase + elapsed;
        if (total > _estimateLastSent) {
          _estimateLastSent = total;
          _sendProgress(partId, total);
        }
      }

      update();
      _estimateTimer = Timer.periodic(const Duration(seconds: 5), (_) => update());
      if (source.kind == VideoKind.iframe && _partPopups.isNotEmpty) {
        _popupPoll = Timer.periodic(const Duration(seconds: 1), (_) {
          if (_popupActive) return;
          final pos = DateTime.now().difference(_openedAt!).inSeconds.toDouble();
          _firePopups('time', pos);
          if (duration > 0 && pos >= duration) _firePopups('end', pos);
        });
      }
    }
  }

  void _onTime(Map<String, dynamic> part, VideoSource source, double secs, double? dur, bool playing) {
    final partId = asInt(part['id'])!;
    if (source.kind == VideoKind.direct) {
      final current = secs.floor();
      if (current - _lastDirectSent >= 5) {
        _lastDirectSent = current;
        _sendProgress(partId, current);
      }
      if (playing) _firePopups('time', secs);
    } else if (source.kind == VideoKind.youtube) {
      final current = secs.floor();
      if (current - _lastYtSent >= 5) {
        _lastYtSent = current;
        _sendProgress(partId, current);
      }
      if (playing) _firePopups('time', secs);
    } else if (source.kind == VideoKind.vimeo || source.kind == VideoKind.mediadelivery) {
      _firePopups('time', secs);
      if (dur != null && secs >= dur - 0.5) _firePopups('end', secs);
    }
  }

  void _onPlayState(Map<String, dynamic> part, VideoSource source, bool playing, double secs) {
    if (playing) return;
    if (source.kind == VideoKind.direct || source.kind == VideoKind.youtube) {
      _sendProgress(asInt(part['id'])!, secs.floor());
    }
  }

  Future<void> _firePopups(String kind, double position) async {
    if (_popupActive) return;
    final q = _partPopups.where((p) =>
        p['answered'] != true &&
        p['shown'] != true &&
        (kind == 'end' || (p['triggerType'] == 'time' && position >= ((p['triggerSeconds'] as num?) ?? 0)))).firstOrNull;
    if (q == null) return;
    q['shown'] = true;
    _popupActive = true;
    _video.pause();
    await _video.exitFullscreen();
    if (!mounted) return;
    final id = asInt(q['id'])!;
    await showPopupQuestion(
      context,
      q,
      onChoice: (choice) => PortalApi.answerPopup(id, choice),
      onEssay: (file) => PortalApi.answerPopupEssay(id, file),
    );
    _popupActive = false;
    q['answered'] = true;
    if (!mounted) return;
    if (kind == 'time') _video.play();
    _firePopups(kind, position);
  }

  // ===== الواجهة =====

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_title.isEmpty ? 'مشاهدة الدرس' : _title)),
      floatingActionButton: const BroadcastsButton(page: 'lesson-view'),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? ErrorView(message: _error!, onRetry: () { setState(() { _loading = true; _error = null; }); _load(); })
              : _body(),
    );
  }

  Widget _body() {
    final parts = _parts[_category] ?? [];
    final part = _part;
    final showQuestions = (_parts['questions']?.isNotEmpty ?? false) && _questionsDisplay != 'outside';
    final source = part == null ? null : sourceForPart(part);
    return ListView(padding: const EdgeInsets.fromLTRB(16, 12, 16, 90), children: [
      if (_fromCache) const Padding(padding: EdgeInsets.only(bottom: 10), child: OfflineBanner(savedAt: null, message: 'مفيش نت — الفيديو محتاج نت عشان يشتغل')),
      Wrap(spacing: 8, runSpacing: 8, children: [
        for (final c in _categories)
          if (c != 'questions' || showQuestions)
            ChoiceChip(
              label: Text(_categoryLabels[c]!),
              selected: _category == c,
              onSelected: (_) => _switchCategory(c),
              selectedColor: AppColors.primary.withValues(alpha: 0.15),
            ),
      ]),
      const SizedBox(height: 14),
      if (part == null)
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 40),
          child: Text('لا يوجد فيديو من هذا النوع لهذا الدرس', textAlign: TextAlign.center, style: TextStyle(color: AppColors.muted)),
        )
      else ...[
        LessonVideo(
          key: ValueKey(_playerKey),
          source: source!,
          controller: _video,
          startAt: source.kind == VideoKind.direct || source.kind == VideoKind.youtube ? (asInt(part['watchedSeconds']) ?? 0) : 0,
          onTime: (s, d, p) => _onTime(part, source, s, d, p),
          onPlayState: (p, s) => _onPlayState(part, source, p, s),
          onEnded: () => _firePopups('end', 0),
        ),
        if (source.kind == VideoKind.drive)
          const Padding(
            padding: EdgeInsets.only(top: 6),
            child: Text('⚠️ لا يمكن تتبع وقت المشاهدة لفيديوهات Google Drive بدقة', style: TextStyle(color: AppColors.muted, fontSize: 12.5)),
          ),
        if (source.kind == VideoKind.vimeo || source.kind == VideoKind.mediadelivery || source.kind == VideoKind.iframe)
          const Padding(
            padding: EdgeInsets.only(top: 6),
            child: Text('لو الفيديو مبدأش لوحده، اضغط تشغيل جوه الفيديو وشغّل الصوت لو مقفول.', style: TextStyle(color: AppColors.muted, fontSize: 12.5)),
          ),
        if (parts.length > 1) ...[
          const SizedBox(height: 12),
          Row(children: [
            OutlinedButton(onPressed: _index > 0 ? () => _changePart(-1) : null, child: const Text('السابق')),
            Expanded(child: Text('${_index + 1} / ${parts.length}', textAlign: TextAlign.center, style: const TextStyle(color: AppColors.muted))),
            OutlinedButton(onPressed: _index < parts.length - 1 ? () => _changePart(1) : null, child: const Text('التالي')),
          ]),
        ],
      ],
    ]);
  }
}
