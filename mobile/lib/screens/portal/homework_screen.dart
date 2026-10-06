import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../services/api.dart';
import '../../services/outbox.dart';
import '../../services/session_store.dart';
import '../../theme.dart';
import '../../widgets/ads.dart';
import '../../widgets/broadcasts.dart';
import '../../widgets/cached_view.dart';
import '../../widgets/common.dart';

const _statusLabels = {
  'submitted': 'تم التسليم ⏳',
  'complete': 'كامل ✅',
  'incomplete': 'مش كامل ⚠️',
  'no_steps': 'من غير خطوات 📝',
  'not_done': 'مش معمول ❌',
  'center': 'صُحِّح في السنتر',
  'online': 'اتصحح اونلاين',
};
const _statusColors = {
  'submitted': Color(0xFF6B7280),
  'complete': Color(0xFF059669),
  'incomplete': Color(0xFFD97706),
  'no_steps': Color(0xFF6B7280),
  'not_done': Color(0xFFDC2626),
  'center': Color(0xFF2563EB),
  'online': Color(0xFF0EA5E9),
};

/// الواجب الأونلاين: القايمة + رفع الحل (ولو مفيش نت بيتحفظ ويترفع لوحده بعدين)
class HomeworkScreen extends StatefulWidget {
  const HomeworkScreen({super.key, required this.onUnauthorized});
  final VoidCallback onUnauthorized;
  @override
  State<HomeworkScreen> createState() => _HomeworkScreenState();
}

class _HomeworkScreenState extends State<HomeworkScreen> {
  final _view = GlobalKey<CachedViewState<List<Map<String, dynamic>>>>();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => Ads.showFor(context, AccountType.student, 'homework'));
  }

  Future<void> _upload(Map<String, dynamic> a) async {
    final sent = await showModalBottomSheet<bool>(
      context: context,
      useRootNavigator: true,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _UploadSheet(assignment: a),
    );
    if (sent == true) _view.currentState?.refresh();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('الواجب')),
      floatingActionButton: const BroadcastsButton(page: 'homework'),
      body: ValueListenableBuilder(
        valueListenable: Outbox.items,
        builder: (context, _, _) => CachedView<List<Map<String, dynamic>>>(
          key: _view,
          cacheKey: 'homework',
          fetch: PortalApi.homework,
          onUnauthorized: widget.onUnauthorized,
          decode: (j) => ((j as List?) ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList(),
          builder: (context, list, refresh) {
            if (list.isEmpty) return const EmptyView('لا يوجد واجبات حالياً', icon: Icons.assignment_outlined);
            return ListView.separated(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 90),
              itemCount: list.length,
              separatorBuilder: (_, _) => const SizedBox(height: 10),
              itemBuilder: (context, i) => _card(list[i]),
            );
          },
        ),
      ),
    );
  }

  Widget _card(Map<String, dynamic> a) {
    final id = asInt(a['id']) ?? 0;
    final today = DateTime.now().toIso8601String().substring(0, 10);
    final expired = today.compareTo('${a['endDate'] ?? '9999'}') > 0;
    final cs = a['centerStatus'];
    final correction = (cs == 'center' || cs == 'center_corrected' || cs == true)
        ? 'center'
        : (cs == 'online' || cs == 'online_corrected')
            ? 'online'
            : null;
    final status = correction ?? (a['submitted'] == true ? '${a['submissionStatus']}' : null);
    final color = _statusColors[status] ?? const Color(0xFFE5E7EB);
    final pending = Outbox.homeworkFor(id);

    Widget action;
    if (correction == 'center') {
      action = const Pill('صُحِّح في السنتر', AppColors.neutralSoft, AppColors.muted);
    } else if (correction == 'online') {
      action = const Pill('اتصحح اونلاين', Color(0xFFE0F2FE), Color(0xFF0369A1));
    } else if (a['submitted'] == true) {
      action = Pill('تم الإرسال', AppColors.primary.withValues(alpha: 0.12), AppColors.primary);
    } else if (pending.any((p) => p['failed'] != true)) {
      action = const Pill('⏳ هيتبعت لما النت يرجع', AppColors.warningSoft, AppColors.warningText);
    } else if (!expired && a['submissionType'] == 'link' && '${a['externalLink'] ?? ''}'.isNotEmpty) {
      action = FilledButton.tonal(
        style: FilledButton.styleFrom(minimumSize: const Size(0, 40)),
        onPressed: () => launchUrl(Uri.parse('${a['externalLink']}'), mode: LaunchMode.externalApplication),
        child: const Text('🔗 رابط الواجب'),
      );
    } else if (!expired) {
      action = FilledButton(
        style: FilledButton.styleFrom(minimumSize: const Size(0, 40)),
        onPressed: () => _upload(a),
        child: const Text('📤 رفع الواجب'),
      );
    } else {
      action = const Pill('انتهى وقت التسليم', AppColors.dangerSoft, AppColors.dangerText);
    }

    return Card(
      clipBehavior: Clip.antiAlias,
      child: Container(
        decoration: BoxDecoration(border: BorderDirectional(start: BorderSide(color: color, width: 4))),
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Wrap(spacing: 6, runSpacing: 6, children: [
            Pill('واجب ${a['orderNumber'] ?? ''}', AppColors.primary.withValues(alpha: 0.12), AppColors.primary),
            if (status != null) Pill(_statusLabels[status] ?? status, color.withValues(alpha: 0.12), color),
          ]),
          const SizedBox(height: 6),
          Text('${a['title'] ?? ''}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15.5)),
          if ('${a['description'] ?? ''}'.isNotEmpty) Text('${a['description']}', style: const TextStyle(color: AppColors.muted, fontSize: 13)),
          Text('📅 التسليم: ${a['startDate'] ?? ''} ← ${a['endDate'] ?? ''}', style: const TextStyle(color: AppColors.muted, fontSize: 13)),
          const SizedBox(height: 10),
          Align(alignment: AlignmentDirectional.centerEnd, child: action),
          for (final p in pending.where((p) => p['failed'] == true))
            Container(
              margin: const EdgeInsets.only(top: 10),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: AppColors.dangerSoft, borderRadius: BorderRadius.circular(10)),
              child: Row(children: [
                Expanded(child: Text('❌ الواجب اللي اتحفظ من غير نت مترفعش: ${p['error'] ?? ''}', style: const TextStyle(color: AppColors.dangerText, fontSize: 13))),
                TextButton(onPressed: () => Outbox.dismiss('${p['id']}'), child: const Text('إخفاء')),
              ]),
            ),
        ]),
      ),
    );
  }
}

class _UploadSheet extends StatefulWidget {
  const _UploadSheet({required this.assignment});
  final Map<String, dynamic> assignment;
  @override
  State<_UploadSheet> createState() => _UploadSheetState();
}

class _UploadSheetState extends State<_UploadSheet> {
  static const _maxBytes = 10 * 1024 * 1024;
  final List<File> _files = [];
  final _comment = TextEditingController();
  String? _message;
  bool _error = false;
  bool _busy = false;

  @override
  void dispose() {
    _comment.dispose();
    super.dispose();
  }

  bool _isPdf(File f) => f.path.toLowerCase().endsWith('.pdf');

  void _add(Iterable<File> files) {
    for (final f in files) {
      if (!_isPdf(f) && _files.where((x) => !_isPdf(x)).length >= 10) {
        setState(() { _message = 'لا يمكن رفع أكثر من 10 صور'; _error = true; });
        return;
      }
      if (_files.any((x) => x.path == f.path)) continue;
      _files.add(f);
    }
    setState(() => _message = null);
  }

  Future<void> _camera() async {
    final x = await ImagePicker().pickImage(source: ImageSource.camera, maxWidth: 2200, imageQuality: 85);
    if (x != null) _add([File(x.path)]);
  }

  Future<void> _gallery() async {
    final xs = await ImagePicker().pickMultiImage(maxWidth: 2200, imageQuality: 85);
    _add(xs.map((x) => File(x.path)));
  }

  Future<void> _pdf() async {
    final picked = await FilePicker.pickFiles(type: FileType.custom, allowedExtensions: ['pdf']);
    _add(picked.where((p) => p.path != null).map((p) => File(p.path!)));
  }

  Future<void> _submit() async {
    if (_files.isEmpty) {
      setState(() { _message = 'ارفع صورة أو ملف PDF واحد على الأقل'; _error = true; });
      return;
    }
    if (_files.any((f) => f.lengthSync() > _maxBytes)) {
      setState(() { _message = 'حجم كل ملف يجب أن يكون 10 ميجابايت أو أقل'; _error = true; });
      return;
    }
    final id = asInt(widget.assignment['id'])!;
    setState(() { _busy = true; _message = '⏳ جاري رفع الملفات...'; _error = false; });
    try {
      final msg = await PortalApi.submitHomework(id, _files, _comment.text);
      if (!mounted) return;
      toast(context, msg);
      Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (e.offline) {
        // مفيش نت: نحفظ الواجب على الموبايل ويترفع لوحده أول ما النت يرجع
        await Outbox.addHomework(id, '${widget.assignment['title'] ?? ''}', _files, _comment.text);
        if (!mounted) return;
        toast(context, '📴 مفيش نت — الواجب اتحفظ على الموبايل وهيترفع لوحده أول ما النت يرجع');
        Navigator.of(context).pop(true);
        return;
      }
      if (mounted) setState(() { _message = e.message; _error = true; });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('رفع: ${widget.assignment['title'] ?? ''}', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
            const SizedBox(height: 12),
            Wrap(spacing: 8, runSpacing: 8, children: [
              OutlinedButton.icon(onPressed: _busy ? null : _camera, icon: const Icon(Icons.photo_camera), label: const Text('صوّر')),
              OutlinedButton.icon(onPressed: _busy ? null : _gallery, icon: const Icon(Icons.photo_library), label: const Text('من الصور')),
              OutlinedButton.icon(onPressed: _busy ? null : _pdf, icon: const Icon(Icons.picture_as_pdf), label: const Text('ملف PDF')),
            ]),
            if (_files.isNotEmpty) ...[
              const SizedBox(height: 12),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final f in _files)
                  Stack(clipBehavior: Clip.none, children: [
                    ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: _isPdf(f)
                          ? Container(
                              width: 70,
                              height: 70,
                              color: AppColors.neutralSoft,
                              alignment: Alignment.center,
                              child: const Icon(Icons.picture_as_pdf, color: AppColors.danger),
                            )
                          : Image.file(f, width: 70, height: 70, fit: BoxFit.cover),
                    ),
                    PositionedDirectional(
                      top: -8,
                      end: -8,
                      child: InkWell(
                        onTap: _busy ? null : () => setState(() => _files.remove(f)),
                        child: const CircleAvatar(radius: 11, backgroundColor: AppColors.danger, child: Icon(Icons.close, size: 14, color: Colors.white)),
                      ),
                    ),
                  ]),
              ]),
            ],
            const SizedBox(height: 12),
            TextField(controller: _comment, maxLines: 2, decoration: const InputDecoration(labelText: 'ملاحظة للمصحح (اختياري)')),
            if (_message != null)
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: Text(_message!, style: TextStyle(color: _error ? AppColors.dangerText : AppColors.muted)),
              ),
            const SizedBox(height: 14),
            FilledButton(onPressed: _busy ? null : _submit, child: Text(_busy ? 'جاري الرفع...' : '✅ إرسال الواجب')),
          ]),
        ),
      ),
    );
  }
}
