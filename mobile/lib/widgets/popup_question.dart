import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../services/api.dart';
import '../theme.dart';
import 'lesson_video.dart';
import 'video_source.dart';

Color _color(dynamic v, Color fallback) {
  var s = '${v ?? ''}'.trim().replaceFirst('#', '');
  if (s.length == 3) s = s.split('').map((c) => '$c$c').join();
  if (s.length == 6) s = 'FF$s';
  if (s.length == 8 && v.toString().length == 9) s = s.substring(6) + s.substring(0, 6); // #RRGGBBAA → AARRGGBB
  final n = int.tryParse(s, radix: 16);
  return n == null ? fallback : Color(n);
}

/// السؤال المنبثق (نفس popup-question.js في الموقع): بيقفل لحد ما الطالب يجاوب ويخلّص فيديو الحل لو موجود
Future<void> showPopupQuestion(
  BuildContext context,
  Map<String, dynamic> q, {
  required Future<Map<String, dynamic>> Function(String choice) onChoice,
  required Future<Map<String, dynamic>> Function(File image) onEssay,
}) {
  final d = (q['design'] as Map?)?.cast<String, dynamic>() ?? {};
  final opacity = ((d['overlayOpacity'] as num?) ?? 70) / 100;
  return showGeneralDialog(
    context: context,
    useRootNavigator: true,
    barrierDismissible: false,
    barrierColor: Colors.black.withValues(alpha: opacity.clamp(0.0, 0.95)),
    pageBuilder: (_, _, _) => _PopupQuestionDialog(q: q, onChoice: onChoice, onEssay: onEssay),
  );
}

class _PopupQuestionDialog extends StatefulWidget {
  const _PopupQuestionDialog({required this.q, required this.onChoice, required this.onEssay});
  final Map<String, dynamic> q;
  final Future<Map<String, dynamic>> Function(String choice) onChoice;
  final Future<Map<String, dynamic>> Function(File image) onEssay;
  @override
  State<_PopupQuestionDialog> createState() => _PopupQuestionDialogState();
}

class _PopupQuestionDialogState extends State<_PopupQuestionDialog> {
  late final Map<String, dynamic> d = (widget.q['design'] as Map?)?.cast<String, dynamic>() ?? {};
  late final bg = _color(d['bgColor'], Colors.white);
  late final fg = _color(d['textColor'], const Color(0xFF0F172A));
  late final accent = _color(d['accentColor'], const Color(0xFF6366F1));
  late final choiceBg = _color(d['choiceBgColor'], const Color(0xFFF1F5F9));
  late final okColor = _color(d['correctColor'], const Color(0xFF16A34A));
  late final badColor = _color(d['wrongColor'], const Color(0xFFDC2626));
  late final radius = ((d['borderRadius'] as num?) ?? 20).toDouble();
  late final fontSize = ((d['fontSize'] as num?) ?? 20).toDouble();

  bool get _isMcq => widget.q['type'] == 'mcq';

  bool _busy = false;
  String? _error;
  Map<String, dynamic>? _result;
  File? _image;

  // قفل الإغلاق لحد ما فيديو الحل يخلص
  bool _showFoot = false;
  bool _unlocked = false;
  bool _ended = false;
  bool _minPassed = true;
  int? _countdown;
  final List<Timer> _timers = [];
  final _video = LessonVideoController();

  @override
  void dispose() {
    for (final t in _timers) {
      t.cancel();
    }
    super.dispose();
  }

  Future<void> _answer(Future<Map<String, dynamic>> Function() send) async {
    setState(() { _busy = true; _error = null; });
    try {
      final result = await send();
      if (!mounted) return;
      setState(() => _result = result);
      _startSolution((result['solution'] as Map?)?.cast<String, dynamic>());
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.offline ? 'مفيش نت — اتأكد من النت وجاوب تاني' : 'حصلت مشكلة، حاول تاني');
    } catch (_) {
      if (mounted) setState(() => _error = 'حصلت مشكلة، حاول تاني');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Map<String, dynamic>? _solution;

  void _startSolution(Map<String, dynamic>? sol) {
    _showFoot = true;
    if (sol == null || '${sol['url'] ?? ''}'.isEmpty) {
      setState(() => _unlocked = true);
      return;
    }
    _solution = sol;
    final start = (sol['start'] as num?)?.toInt() ?? 0;
    final end = (sol['end'] as num?)?.toInt() ?? 0;
    final min = (sol['minSeconds'] as num?)?.toInt() ?? 0;
    _minPassed = min <= 0;
    if (!_minPassed) {
      final t0 = DateTime.now();
      _timers.add(Timer.periodic(const Duration(milliseconds: 500), (t) {
        if (DateTime.now().difference(t0).inSeconds >= min) {
          t.cancel();
          _minPassed = true;
          _tryUnlock();
        }
      }));
    }
    final source = detectVideoSource('${sol['url']}');
    // المشغلات اللي مش بتقول إمتى خلصت: عداد بمدة الحل (أو 30 ثانية)
    if (!source.hasEvents || source.kind == VideoKind.vimeo || source.kind == VideoKind.mediadelivery) {
      if (source.kind == VideoKind.unknown) {
        _ended = true;
        _minPassed = true;
      } else {
        final seconds = source.hasEvents ? (end > start ? end - start : 30) : [min, end > start ? end - start : 30].reduce((a, b) => a > b ? a : b);
        final t0 = DateTime.now();
        _timers.add(Timer.periodic(const Duration(milliseconds: 500), (t) {
          final left = seconds - DateTime.now().difference(t0).inSeconds;
          if (left <= 0) {
            t.cancel();
            _onSolutionEnded();
          } else if (mounted) {
            setState(() => _countdown = left);
          }
        }));
      }
    }
    setState(() {});
    _tryUnlock();
  }

  void _onSolutionEnded() {
    _ended = true;
    _countdown = null;
    _tryUnlock();
  }

  void _tryUnlock() {
    if (_ended && _minPassed && mounted) setState(() => _unlocked = true);
  }

  Future<void> _pickImage(ImageSource from) async {
    try {
      final x = await ImagePicker().pickImage(source: from, maxWidth: 2000, imageQuality: 85);
      if (x != null && mounted) setState(() => _image = File(x.path));
    } catch (_) {
      if (mounted) setState(() => _error = 'مش قادر يفتح الكاميرا/الصور');
    }
  }

  Widget _choice(String key) {
    final choices = (widget.q['choices'] as Map?)?.cast<String, dynamic>() ?? {};
    final images = (widget.q['choiceImages'] as Map?)?.cast<String, dynamic>() ?? {};
    final text = '${choices[key] ?? ''}';
    final img = '${images[key] ?? ''}';
    Color border = Colors.transparent;
    Color fill = choiceBg;
    if (_result != null) {
      if (_result!['correctChoice'] == key) {
        border = okColor;
        fill = Color.alphaBlend(okColor.withValues(alpha: 0.18), choiceBg);
      } else if (_result!['selected'] == key) {
        border = badColor;
        fill = Color.alphaBlend(badColor.withValues(alpha: 0.18), choiceBg);
      }
    }
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Material(
        color: fill,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radius * 0.6), side: BorderSide(color: border, width: 2)),
        child: InkWell(
          borderRadius: BorderRadius.circular(radius * 0.6),
          onTap: _busy || _result != null ? null : () => _answer(() => widget.onChoice(key)),
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              CircleAvatar(
                radius: 17,
                backgroundColor: accent,
                child: Text(key.toUpperCase(), style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800)),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  if (img.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: ClipRRect(borderRadius: BorderRadius.circular(10), child: Image.network(img, height: 160, fit: BoxFit.contain)),
                    ),
                  if (text.isNotEmpty) Text(text, style: TextStyle(color: fg, fontSize: fontSize * 0.85)),
                ]),
              ),
            ]),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final q = widget.q;
    final bonus = (q['bonusPoints'] as num?)?.toInt() ?? 0;
    final header = '${d['headerText'] ?? ''}'.isNotEmpty ? '${d['headerText']}' : '❓ سؤال';
    final ok = _result?['isCorrect'] == true;
    final points = (_result?['pointsAwarded'] as num?)?.toInt() ?? 0;
    return PopScope(
      canPop: _unlocked,
      child: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 720),
              child: Material(
                color: bg,
                borderRadius: BorderRadius.circular(radius),
                clipBehavior: Clip.antiAlias,
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Container(
                    color: accent,
                    padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
                    child: Row(children: [
                      Expanded(child: Text(header, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 16))),
                      if (bonus > 0)
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                          decoration: BoxDecoration(color: Colors.white24, borderRadius: BorderRadius.circular(999)),
                          child: Text('⭐ +$bonus نقطة', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
                        ),
                    ]),
                  ),
                  Flexible(
                    child: SingleChildScrollView(
                      padding: const EdgeInsets.all(18),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                        if ('${q['text'] ?? ''}'.isNotEmpty)
                          Text('${q['text']}', style: TextStyle(color: fg, fontSize: fontSize, fontWeight: FontWeight.w700, height: 1.6)),
                        if ('${q['imageUrl'] ?? ''}'.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 12),
                            child: ClipRRect(borderRadius: BorderRadius.circular(12), child: Image.network('${q['imageUrl']}', fit: BoxFit.contain)),
                          ),
                        const SizedBox(height: 12),
                        if (_isMcq) ...[
                          Text('اختار إجابتك', style: TextStyle(color: fg.withValues(alpha: 0.75))),
                          for (final k in ['a', 'b', 'c', 'd']) _choice(k),
                        ] else ...[
                          Text('ارفع صورة إجابتك (حل مكتوب بخط اليد)', style: TextStyle(color: fg.withValues(alpha: 0.75))),
                          const SizedBox(height: 10),
                          if (_image != null)
                            ClipRRect(borderRadius: BorderRadius.circular(10), child: Image.file(_image!, height: 200, fit: BoxFit.contain)),
                          if (_result == null)
                            Wrap(spacing: 8, runSpacing: 8, children: [
                              OutlinedButton.icon(onPressed: _busy ? null : () => _pickImage(ImageSource.camera), icon: const Icon(Icons.photo_camera), label: const Text('صوّر الحل')),
                              OutlinedButton.icon(onPressed: _busy ? null : () => _pickImage(ImageSource.gallery), icon: const Icon(Icons.photo_library), label: const Text('من الصور')),
                              FilledButton(
                                style: FilledButton.styleFrom(minimumSize: const Size(130, 42), backgroundColor: accent),
                                onPressed: _busy || _image == null ? null : () => _answer(() => widget.onEssay(_image!)),
                                child: Text(_busy ? 'جاري الإرسال...' : 'إرسال الإجابة'),
                              ),
                            ]),
                        ],
                        if (_busy && _isMcq) const Padding(padding: EdgeInsets.only(top: 12), child: LinearProgressIndicator()),
                        if (_error != null) _msg(_error!, badColor),
                        if (_result != null)
                          _isMcq
                              ? _msg(ok ? '✅ إجابة صحيحة!${points > 0 ? ' حصلت على +$points نقطة' : ''}' : '❌ إجابة خاطئة', ok ? okColor : badColor)
                              : _msg('📨 تم استلام إجابتك. هتعرف النتيجة بعد ما المساعد يصححها، وهتظهر في صفحة الفيديوهات.', fg),
                        if (_solution != null) ...[
                          const SizedBox(height: 16),
                          Text('🎬 شاهد حل السؤال', style: TextStyle(color: fg, fontWeight: FontWeight.w800, fontSize: 16)),
                          const SizedBox(height: 8),
                          LessonVideo(
                            source: detectVideoSource('${_solution!['url']}'),
                            controller: _video,
                            autoplay: true,
                            startAt: (_solution!['start'] as num?)?.toInt() ?? 0,
                            endAt: (_solution!['end'] as num?)?.toInt() ?? 0,
                            onEnded: _onSolutionEnded,
                          ),
                        ],
                        if (_showFoot) ...[
                          const SizedBox(height: 14),
                          Row(children: [
                            Expanded(
                              child: Text(
                                _unlocked ? '' : (_countdown != null ? 'هتقدر تقفل بعد $_countdown ثانية' : 'كمّل مشاهدة الحل عشان تقدر تقفل'),
                                style: TextStyle(color: fg.withValues(alpha: 0.7), fontSize: 13),
                              ),
                            ),
                            FilledButton(
                              style: FilledButton.styleFrom(minimumSize: const Size(110, 42), backgroundColor: accent),
                              onPressed: _unlocked ? () => Navigator.of(context).pop() : null,
                              child: const Text('إغلاق ✔'),
                            ),
                          ]),
                        ],
                      ]),
                    ),
                  ),
                ]),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _msg(String text, Color color) => Container(
        margin: const EdgeInsets.only(top: 14),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: choiceBg, borderRadius: BorderRadius.circular(12)),
        child: Text(text, style: TextStyle(color: color, fontWeight: FontWeight.w700)),
      );
}

/// نتايج الأسئلة المنبثقة على كارت الدرس (نفس اللي بيظهر في الموقع)
List<Widget> popupResultPills(List<Map<String, dynamic>> list) {
  Widget pill(Color bg, Color fg, String text) => Container(
        margin: const EdgeInsets.only(top: 8),
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(8)),
        child: Text(text, style: TextStyle(color: fg, fontSize: 12.5, fontWeight: FontWeight.w600)),
      );
  final out = <Widget>[];
  final mcq = list.where((x) => x['type'] == 'mcq').toList();
  if (mcq.isNotEmpty) {
    final ok = mcq.where((x) => x['isCorrect'] == true).length;
    out.add(pill(AppColors.primary.withValues(alpha: 0.1), const Color(0xFF4338CA), '🎯 الأسئلة المنبثقة: $ok صح من ${mcq.length}'));
  }
  for (final x in list.where((x) => x['type'] == 'essay')) {
    if (x['isCorrect'] == true) {
      out.add(pill(const Color(0x1F16A34A), const Color(0xFF15803D), '✅ السؤال المقالي: إجابتك صحيحة'));
    } else if (x['isCorrect'] == false) {
      out.add(pill(const Color(0x1FDC2626), const Color(0xFFB91C1C), '❌ السؤال المقالي: إجابتك خاطئة'));
    } else {
      out.add(pill(const Color(0x26F59E0B), const Color(0xFFB45309), '⏳ السؤال المقالي: في انتظار التصحيح'));
    }
  }
  return out;
}
