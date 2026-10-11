import 'package:flutter/material.dart';

import '../../services/net.dart';
import '../../services/session_store.dart';
import '../../services/staff_api.dart';
import '../../services/staff_store.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import 'create_forms.dart';

/// إدارة الفيديوهات من الموبايل (محتاجة نت). القراءة من /api/staff/videos،
/// وكل تعديل بيروح لنفس صفحات الموقع (نفس الصلاحيات ونفس السجلات).
/// رفع أجزاء الفيديو وعمل فيديو جديد بيفتحوا صفحة الموقع جوه تاب السيستم.
class VideosTab extends StatefulWidget {
  const VideosTab({super.key, required this.user, required this.openWeb});
  final StaffUser user;
  final void Function(String path) openWeb;

  @override
  State<VideosTab> createState() => _VideosTabState();
}

Future<Map<String, dynamic>?> _load(BuildContext context, String path, StaffUser user, void Function(String) onError) async {
  try {
    final data = await StaffApi.getJson(path, userId: user.id);
    Connection.report(true);
    return data;
  } on DeviceNotAuthorized catch (e) {
    StaffStore.deviceRevoked.value = true;
    onError('$e');
  } on ApiException catch (e) {
    if (e.offline) Connection.report(false);
    onError(e.offline ? 'إدارة الفيديوهات محتاجة نت — اتأكد من النت وجرب تاني' : e.message);
  }
  return null;
}

class _VideosTabState extends State<VideosTab> {
  List<Map<String, dynamic>>? _videos;
  String? _error;
  String _q = '';

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() => _error = null);
    final data = await _load(context, '/api/staff/videos', widget.user, (e) => setState(() => _error = e));
    if (data != null && mounted) {
      setState(() => _videos = ((data['videos'] as List?) ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList());
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_videos == null) {
      return _error != null ? ErrorView(message: _error!, onRetry: _refresh) : const Center(child: CircularProgressIndicator());
    }
    final q = _q.trim().toLowerCase();
    final list = _videos!.where((v) => q.isEmpty || '${v['title']} ${v['session']}'.toLowerCase().contains(q)).toList();
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
        child: Row(children: [
          Expanded(
            child: TextField(
              decoration: const InputDecoration(hintText: 'دور باسم الفيديو أو الحصة', prefixIcon: Icon(Icons.search), isDense: true),
              onChanged: (v) => setState(() => _q = v),
            ),
          ),
          IconButton(
            tooltip: 'فيديو جديد / رفع أجزاء (صفحة الموقع)',
            onPressed: () => widget.openWeb('/admin/videos'),
            icon: const Icon(Icons.video_call_outlined, color: AppColors.primary),
          ),
        ]),
      ),
      if (_error != null)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Text(_error!, style: const TextStyle(color: AppColors.dangerText, fontSize: 12.5)),
        ),
      Expanded(
        child: RefreshIndicator(
          onRefresh: _refresh,
          child: list.isEmpty
              ? const EmptyView('مفيش فيديوهات', icon: Icons.ondemand_video_outlined)
              : ListView.builder(
                  padding: const EdgeInsets.fromLTRB(16, 6, 16, 24),
                  itemCount: list.length,
                  itemBuilder: (context, i) {
                    final v = list[i];
                    return Card(
                      margin: const EdgeInsets.only(bottom: 8),
                      child: ListTile(
                        onTap: () async {
                          await Navigator.of(context).push(MaterialPageRoute(
                            builder: (_) => VideoManageScreen(videoId: (v['id'] as num).toInt(), title: '${v['title']}', user: widget.user, openWeb: widget.openWeb),
                          ));
                          _refresh();
                        },
                        leading: CircleAvatar(
                          backgroundColor: AppColors.primary.withValues(alpha: 0.1),
                          child: Text('${v['lessonNumber'] ?? '-'}', style: const TextStyle(color: AppColors.primary, fontWeight: FontWeight.w800)),
                        ),
                        title: Text('${v['title']}', maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)),
                        subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text('${v['session']}', maxLines: 1, overflow: TextOverflow.ellipsis),
                          const SizedBox(height: 4),
                          Wrap(spacing: 6, runSpacing: 4, children: [
                            Pill('${v['parts']} جزء', AppColors.neutralSoft, AppColors.text, fontSize: 11),
                            Pill('${v['linkedSessions']} حصة', AppColors.neutralSoft, AppColors.text, fontSize: 11),
                            if (v['free'] == true) const Pill('مجاني للكل', AppColors.successSoft, AppColors.successText, fontSize: 11),
                            if (v['customPrice'] == true) const Pill('💰 سعر خاص', AppColors.warningSoft, AppColors.warningText, fontSize: 11),
                          ]),
                        ]),
                        trailing: const Icon(Icons.chevron_left),
                      ),
                    );
                  },
                ),
        ),
      ),
    ]);
  }
}

/// صفحة فيديو واحد: الإعدادات + السعر + الحصص المرتبطة + الطلاب ووقت الإتاحة
class VideoManageScreen extends StatefulWidget {
  const VideoManageScreen({super.key, required this.videoId, required this.title, required this.user, required this.openWeb});
  final int videoId;
  final String title;
  final StaffUser user;
  final void Function(String path) openWeb;

  @override
  State<VideoManageScreen> createState() => _VideoManageScreenState();
}

class _VideoManageScreenState extends State<VideoManageScreen> {
  Map<String, dynamic>? _data;
  String? _error;
  bool _busy = false;
  String _studentQuery = '';
  String _studentFilter = 'all';
  final _ops = <String, OnlineOp>{};

  int get _id => widget.videoId;
  String get _base => '/admin/videos/$_id';

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() => _error = null);
    final data = await _load(context, '/api/staff/videos/$_id', widget.user, (e) => setState(() => _error = e));
    if (data != null && mounted) setState(() => _data = data);
  }

  /// بيبعت التعديل لصفحة الموقع. key: نوع العملية + هدفها (رقم عملية ثابت لحد ما السيرفر يرد)
  Future<bool> _send(String key, String path, Map<String, dynamic> body, {String? done}) async {
    setState(() => _busy = true);
    final res = await _ops.putIfAbsent(key, OnlineOp.new).send(context, path, body, user: widget.user);
    if (!mounted) return false;
    setState(() => _busy = false);
    if (res == null) return false;
    if (!res.ok) {
      toast(context, res.message, error: true);
      return false;
    }
    if (done != null) toast(context, done);
    await _refresh();
    return true;
  }

  Map<String, dynamic> get _video => (_data!['video'] as Map).cast<String, dynamic>();
  Map<String, dynamic> get _settings => (_data!['settings'] as Map).cast<String, dynamic>();
  Map<String, dynamic> get _price => (_data!['price'] as Map).cast<String, dynamic>();
  List<Map<String, dynamic>> _list(String key) => ((_data![key] as List?) ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList();

  // ===== العنوان =====
  Future<void> _editTitle() async {
    final title = await _askText(context, 'اسم الفيديو', initial: '${_video['title']}');
    if (title == null || title.isEmpty) return;
    await _send('title', '$_base/update-title', {'title': title}, done: '✅ اتغير اسم الفيديو');
  }

  // ===== الإعدادات =====
  Future<void> _editSettings() async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      useRootNavigator: true,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _SettingsSheet(settings: _settings, onSave: (body) => _send('settings', '$_base/session-settings', body, done: '✅ اتحفظت الإعدادات')),
    );
    if (saved == true) return;
  }

  Future<void> _deleteLink(String field, String label) async {
    if (!await confirmDialog(context, title: 'حذف $label؟', message: 'الرابط هيتشال من كل حصص الفيديو ده.', ok: 'احذف')) return;
    await _send('link:$field', '$_base/session-link/delete', {'field': field}, done: '✅ اتحذف');
  }

  // ===== السعر =====
  String _priceText(dynamic value) {
    if (value == null) return 'سعر حصة الطالب العادي';
    final normal = (_price['normalPrice'] as num?) ?? 90;
    return '${fmtNum(value)} ج (${fmtNum((value as num) / normal * 100)}%)';
  }

  Future<void> _editPrice() async {
    final normal = (_price['normalPrice'] as num?) ?? 90;
    final input = await showModalBottomSheet<(String, String)>(
      context: context,
      useRootNavigator: true,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _PriceSheet(normalPrice: normal),
    );
    if (input == null || !mounted) return;
    final (price, scope) = input;

    setState(() => _busy = true);
    final preview = await _load(context, '$_base/price-preview?price=${Uri.encodeQueryComponent(price)}&scope=$scope', widget.user, (e) => toast(context, e, error: true));
    if (!mounted) return;
    setState(() => _busy = false);
    if (preview == null) return;

    final apply = await showDialog<bool>(context: context, builder: (_) => _PricePreviewDialog(preview: preview, price: price, scope: scope));
    if (apply == null || !mounted) return;
    await _send('price', '$_base/price', {'price': price, 'scope': scope, 'apply_existing': apply ? 'yes' : 'no'},
        done: apply ? '✅ اتحفظ السعر واتعدل حساب اللي اشتروا' : '✅ اتحفظ السعر للي هيشتري بعد كده');
  }

  // ===== الحصص =====
  Future<void> _addSession() async {
    final linked = _list('sessions').map((s) => s['id']).toSet();
    final options = _list('sessionOptions').where((s) => !linked.contains(s['id'])).toList();
    final id = await showModalBottomSheet<int>(
      context: context,
      useRootNavigator: true,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _SessionPicker(options: options),
    );
    if (id == null) return;
    await _send('add-session:$id', '$_base/add-session', {'session_id': id}, done: '✅ اتضافت الحصة');
  }

  Future<void> _removeSession(Map<String, dynamic> s) async {
    if (!await confirmDialog(context, title: 'شيل الحصة؟', message: '${s['label']}\n\nطلاب الحصة دي مش هيشوفوا الفيديو تاني.', ok: 'شيلها')) return;
    await _send('remove-session:${s['id']}', '/admin/videos/$_id/remove-session/${s['id']}', {}, done: '✅ اتشالت الحصة');
  }

  // ===== الطلاب =====
  Future<void> _addStudent() async {
    final code = await _askText(context, 'إضافة طالب بالكود', hint: 'مثلاً 125 أو STU-00125', number: false);
    if (code == null || code.isEmpty) return;
    final normalized = normalizeStudentCode(code);
    await _send('add-student:$normalized', '$_base/add-student-access', {'student_code': normalized}, done: '✅ الطالب اتضاف');
  }

  Map<String, dynamic> _grantBody(Map<String, dynamic> s) {
    final grant = s['grant'] as Map?;
    return {'session_id': grant?['sessionId'] ?? _video['mainSessionId']};
  }

  Future<void> _extend(Map<String, dynamic> s, int hours) async {
    await _send('extend:${s['id']}', '$_base/grant/${s['id']}', {..._grantBody(s), 'extend_hours': hours, 'response_format': 'json'},
        done: '✅ اتزود $hours ساعة لـ ${s['name']}');
  }

  Future<void> _setHours(Map<String, dynamic> s) async {
    final current = (s['grant'] as Map?)?['durationHours'] ?? _settings['accessDurationHours'];
    final text = await _askText(context, 'مدة الإتاحة بالساعات لـ ${s['name']}',
        initial: '$current', hint: 'محسوبة من أول ما فتح — ولو كده تبقى منتهية بتبدأ من دلوقتي', number: true);
    final hours = int.tryParse(text ?? '');
    if (hours == null || hours < 1) return;
    await _send('hours:${s['id']}', '$_base/grant/${s['id']}', {..._grantBody(s), 'access_duration_hours': hours, 'response_format': 'json'},
        done: '✅ اتحفظت المدة');
  }

  Future<void> _removeStudent(Map<String, dynamic> s) async {
    if (!await confirmDialog(context, title: 'إلغاء الوصول الفردي؟', message: '${s['name']} مش هيشوف الفيديو ده تاني (لو مش من طلاب الحصة).', ok: 'إلغاء الوصول')) return;
    await _send('remove-student:${s['id']}', '/admin/videos/$_id/remove-student-access-by-student/${s['id']}', {}, done: '✅ اتلغى الوصول');
  }

  String _status(Map<String, dynamic> s) {
    final grant = s['grant'] as Map?;
    if (grant == null) return _settings['isFreeForAll'] == true ? 'open' : 'none';
    return grant['ended'] == true ? 'ended' : 'active';
  }

  // ===== الشاشة =====
  Widget _section(String title, IconData icon, List<Widget> children, {Widget? action}) => Card(
        margin: const EdgeInsets.fromLTRB(16, 0, 16, 10),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Row(children: [
              Icon(icon, color: AppColors.primary),
              const SizedBox(width: 8),
              Expanded(child: Text(title, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16))),
              ?action,
            ]),
            const SizedBox(height: 8),
            ...children,
          ]),
        ),
      );

  Widget _kv(String k, String v) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SizedBox(width: 130, child: Text(k, style: const TextStyle(color: AppColors.muted))),
          Expanded(child: Text(v, style: const TextStyle(fontWeight: FontWeight.w600))),
        ]),
      );

  Widget _studentTile(Map<String, dynamic> s) {
    final status = _status(s);
    final grant = s['grant'] as Map?;
    final (label, bg, fg) = switch (status) {
      'active' => ('متاح لحد ${fmtDate(grant!['expiresAt'], withTime: true)}', AppColors.successSoft, AppColors.successText),
      'ended' => ('⛔ انتهت ${fmtDate(grant!['expiresAt'], withTime: true)}', AppColors.dangerSoft, AppColors.dangerText),
      'open' => ('مفتوح للكل', AppColors.successSoft, AppColors.successText),
      _ => ('لسه مفتحش', AppColors.neutralSoft, AppColors.muted),
    };
    return Card(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 6),
      child: ListTile(
        title: Text('${s['name']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)),
        subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${s['code']} • ${s['group']}${s['individual'] == true ? ' • وصول فردي' : ''}', maxLines: 1, overflow: TextOverflow.ellipsis),
          const SizedBox(height: 4),
          Pill(label, bg, fg, fontSize: 11),
        ]),
        trailing: PopupMenuButton<String>(
          enabled: !_busy,
          onSelected: (v) {
            if (v == '24') _extend(s, 24);
            if (v == '48') _extend(s, 48);
            if (v == 'hours') _setHours(s);
            if (v == 'remove') _removeStudent(s);
          },
          itemBuilder: (_) => [
            const PopupMenuItem(value: '24', child: Text('زوّد 24 ساعة')),
            const PopupMenuItem(value: '48', child: Text('زوّد 48 ساعة')),
            const PopupMenuItem(value: 'hours', child: Text('حدد مدة الإتاحة...')),
            if (s['individual'] == true) const PopupMenuItem(value: 'remove', child: Text('إلغاء الوصول الفردي', style: TextStyle(color: AppColors.danger))),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_data == null ? widget.title : '${_video['title']}', maxLines: 1, overflow: TextOverflow.ellipsis),
        actions: [
          if (_data != null) IconButton(onPressed: _busy ? null : _editTitle, icon: const Icon(Icons.edit_outlined), tooltip: 'تغيير الاسم'),
          IconButton(
            tooltip: 'أجزاء الفيديو والأسئلة (صفحة الموقع)',
            onPressed: () {
              Navigator.of(context).pop();
              widget.openWeb('/admin/videos/$_id');
            },
            icon: const Icon(Icons.open_in_new),
          ),
        ],
        bottom: _busy ? const PreferredSize(preferredSize: Size.fromHeight(3), child: LinearProgressIndicator(minHeight: 3)) : null,
      ),
      body: _data == null
          ? (_error != null ? ErrorView(message: _error!, onRetry: _refresh) : const Center(child: CircularProgressIndicator()))
          : RefreshIndicator(onRefresh: _refresh, child: _body()),
    );
  }

  Widget _body() {
    final settings = _settings;
    final sessions = _list('sessions');
    final q = _studentQuery.trim().toLowerCase();
    final allStudents = _list('students');
    final counts = <String, int>{};
    for (final s in allStudents) {
      counts[_status(s)] = (counts[_status(s)] ?? 0) + 1;
    }
    final students = allStudents.where((s) {
      if (_studentFilter != 'all' && _status(s) != _studentFilter) return false;
      return q.isEmpty || '${s['name']} ${s['code']}'.toLowerCase().contains(q);
    }).toList();

    return CustomScrollView(slivers: [
      const SliverToBoxAdapter(child: SizedBox(height: 12)),
      SliverToBoxAdapter(
        child: _section('الإعدادات العامة', Icons.tune, [
          _kv('مجاني للكل', settings['isFreeForAll'] == true ? 'أيوه' : 'لأ'),
          _kv('مشاهدات (حضر)', '${settings['viewsIfAttended']}'),
          _kv('مشاهدات (دفع)', '${settings['viewsIfPaid']}'),
          _kv('مدة الإتاحة', '${settings['accessDurationHours']} ساعة'),
          _kv('رابط الامتحان', '${settings['examUrl']}'.isEmpty ? '-' : '${settings['examUrl']}'),
          _kv('فيديو الإجابة', '${settings['examVideoUrl']}'.isEmpty ? '-' : '${settings['examVideoUrl']}'),
          Wrap(spacing: 8, children: [
            if ('${settings['examUrl']}'.isNotEmpty)
              TextButton.icon(onPressed: _busy ? null : () => _deleteLink('exam_url', 'رابط الامتحان'), icon: const Icon(Icons.link_off, size: 18), label: const Text('حذف رابط الامتحان')),
            if ('${settings['examVideoUrl']}'.isNotEmpty)
              TextButton.icon(onPressed: _busy ? null : () => _deleteLink('exam_video_url', 'فيديو الإجابة'), icon: const Icon(Icons.link_off, size: 18), label: const Text('حذف فيديو الإجابة')),
          ]),
        ], action: TextButton(onPressed: _busy ? null : _editSettings, child: const Text('تعديل'))),
      ),
      SliverToBoxAdapter(
        child: _section('سعر الحصة', Icons.payments_outlined, [
          _kv('طلاب السناتر', _priceText(_price['center'])),
          _kv('طلاب الأونلاين', _priceText(_price['online'])),
          Text('السعر للطالب اللي حصته بالسعر العادي (${fmtNum(_price['normalPrice'])} ج)، واللي حصته بسعر تاني بيدفع بنفس النسبة.',
              style: const TextStyle(color: AppColors.muted, fontSize: 12.5)),
        ], action: TextButton(onPressed: _busy ? null : _editPrice, child: const Text('تغيير'))),
      ),
      SliverToBoxAdapter(
        child: _section('الحصص اللي تشوف الفيديو', Icons.event_note_outlined, [
          for (final s in sessions)
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              title: Text('${s['label']}'),
              subtitle: s['main'] == true ? const Text('الحصة الأساسية') : null,
              trailing: s['main'] == true
                  ? null
                  : IconButton(onPressed: _busy ? null : () => _removeSession(s), icon: const Icon(Icons.close, color: AppColors.danger), tooltip: 'شيل'),
            ),
        ], action: TextButton.icon(onPressed: _busy ? null : _addSession, icon: const Icon(Icons.add), label: const Text('حصة'))),
      ),
      SliverToBoxAdapter(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 6),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Row(children: [
              Expanded(child: Text('الطلاب (${allStudents.length})', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16))),
              TextButton.icon(onPressed: _busy ? null : _addStudent, icon: const Icon(Icons.person_add_alt_1), label: const Text('بالكود')),
            ]),
            TextField(
              decoration: const InputDecoration(hintText: 'دور بالاسم أو الكود', prefixIcon: Icon(Icons.search), isDense: true),
              onChanged: (v) => setState(() => _studentQuery = v),
            ),
            const SizedBox(height: 6),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(children: [
                for (final f in const [('all', 'الكل'), ('active', 'متاح'), ('ended', 'انتهت'), ('none', 'لسه مفتحش')])
                  Padding(
                    padding: const EdgeInsetsDirectional.only(end: 6),
                    child: ChoiceChip(
                      label: Text('${f.$2} (${f.$1 == 'all' ? allStudents.length : counts[f.$1] ?? 0})'),
                      selected: _studentFilter == f.$1,
                      onSelected: (_) => setState(() => _studentFilter = f.$1),
                    ),
                  ),
              ]),
            ),
          ]),
        ),
      ),
      SliverList.builder(itemCount: students.length, itemBuilder: (context, i) => _studentTile(students[i])),
      const SliverToBoxAdapter(child: SizedBox(height: 32)),
    ]);
  }
}

// ===== أجزاء صغيرة =====

Future<String?> _askText(BuildContext context, String title, {String initial = '', String? hint, bool number = false}) =>
    showDialog<String>(context: context, builder: (_) => _TextDialog(title: title, initial: initial, hint: hint, number: number));

class _TextDialog extends StatefulWidget {
  const _TextDialog({required this.title, required this.initial, this.hint, required this.number});
  final String title, initial;
  final String? hint;
  final bool number;
  @override
  State<_TextDialog> createState() => _TextDialogState();
}

class _TextDialogState extends State<_TextDialog> {
  late final _c = TextEditingController(text: widget.initial);
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: Text(widget.title),
        content: TextField(
          controller: _c,
          autofocus: true,
          keyboardType: widget.number ? TextInputType.number : TextInputType.text,
          decoration: InputDecoration(helperText: widget.hint, helperMaxLines: 3),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('رجوع')),
          FilledButton(onPressed: () => Navigator.pop(context, _c.text.trim()), child: const Text('حفظ')),
        ],
      );
}

class _SettingsSheet extends StatefulWidget {
  const _SettingsSheet({required this.settings, required this.onSave});
  final Map<String, dynamic> settings;
  final Future<bool> Function(Map<String, dynamic> body) onSave;
  @override
  State<_SettingsSheet> createState() => _SettingsSheetState();
}

class _SettingsSheetState extends State<_SettingsSheet> {
  late bool _free = widget.settings['isFreeForAll'] == true;
  late final _attended = TextEditingController(text: '${widget.settings['viewsIfAttended']}');
  late final _paid = TextEditingController(text: '${widget.settings['viewsIfPaid']}');
  late final _hours = TextEditingController(text: '${widget.settings['accessDurationHours']}');
  late final _exam = TextEditingController(text: '${widget.settings['examUrl']}');
  late final _examVideo = TextEditingController(text: '${widget.settings['examVideoUrl']}');
  bool _saving = false;

  @override
  void dispose() {
    for (final c in [_attended, _paid, _hours, _exam, _examVideo]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    final hours = int.tryParse(_hours.text.trim());
    if (hours == null || hours < 1) return toast(context, 'اكتب مدة الإتاحة بالساعات', error: true);
    setState(() => _saving = true);
    final ok = await widget.onSave({
      if (_free) 'is_free_for_all': 'on',
      'views_if_attended': int.tryParse(_attended.text.trim()) ?? 2,
      'views_if_paid': int.tryParse(_paid.text.trim()) ?? 3,
      'access_duration_hours': hours,
      'exam_url': _exam.text.trim(),
      'exam_video_url': _examVideo.text.trim(),
    });
    if (!mounted) return;
    setState(() => _saving = false);
    if (ok) Navigator.pop(context, true);
  }

  Widget _num(TextEditingController c, String label) => Expanded(
        child: TextField(controller: c, keyboardType: TextInputType.number, decoration: InputDecoration(labelText: label)),
      );

  @override
  Widget build(BuildContext context) => SafeArea(
        child: Padding(
          padding: EdgeInsets.fromLTRB(16, 0, 16, 16 + MediaQuery.of(context).viewInsets.bottom),
          child: SingleChildScrollView(
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
              const Text('الإعدادات العامة (لكل الطلاب)', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
              SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('مفتوحة مجانًا للجميع'), value: _free, onChanged: (v) => setState(() => _free = v)),
              Row(children: [_num(_attended, 'مشاهدات (حضر)'), const SizedBox(width: 10), _num(_paid, 'مشاهدات (دفع)')]),
              const SizedBox(height: 10),
              TextField(controller: _hours, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'مدة الإتاحة بالساعات لكل الطلاب')),
              const Padding(
                padding: EdgeInsets.only(top: 4),
                child: Text('اللي اتزودله وقت لوحده بيفضل وقته زي ما هو.', style: TextStyle(color: AppColors.muted, fontSize: 12)),
              ),
              const SizedBox(height: 10),
              TextField(controller: _exam, keyboardType: TextInputType.url, decoration: const InputDecoration(labelText: 'رابط الامتحان')),
              const SizedBox(height: 10),
              TextField(controller: _examVideo, keyboardType: TextInputType.url, decoration: const InputDecoration(labelText: 'فيديو إجابة الامتحان')),
              const SizedBox(height: 16),
              FilledButton.icon(
                onPressed: _saving ? null : _save,
                icon: _saving ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : const Icon(Icons.save),
                label: const Text('حفظ'),
              ),
            ]),
          ),
        ),
      );
}

/// بيرجع (السعر كنص — فاضي = السعر العادي، النطاق center/online/both)
class _PriceSheet extends StatefulWidget {
  const _PriceSheet({required this.normalPrice});
  final num normalPrice;
  @override
  State<_PriceSheet> createState() => _PriceSheetState();
}

class _PriceSheetState extends State<_PriceSheet> {
  final _price = TextEditingController();
  String? _scope;

  @override
  void dispose() {
    _price.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = num.tryParse(_price.text.trim());
    final hint = _price.text.trim().isEmpty
        ? 'فاضي = يرجع لسعر حصة كل طالب العادي'
        : p == null || p < 0
            ? 'اكتب رقم صحيح'
            : '${fmtNum(p / widget.normalPrice * 100)}% من السعر العادي — اللي حصته 50 ج هيدفع ${fmtNum((50 * p / widget.normalPrice).round())} ج';
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(16, 0, 16, 16 + MediaQuery.of(context).viewInsets.bottom),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
          const Text('سعر الحصة', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
          const SizedBox(height: 10),
          TextField(
            controller: _price,
            autofocus: true,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: InputDecoration(labelText: 'السعر للطالب العادي (${fmtNum(widget.normalPrice)} ج)', helperText: hint, helperMaxLines: 2),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 14),
          const Text('السعر ده لمين؟', style: TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 6),
          SegmentedButton<String>(
            emptySelectionAllowed: true,
            showSelectedIcon: false,
            segments: const [
              ButtonSegment(value: 'center', label: Text('السناتر بس')),
              ButtonSegment(value: 'online', label: Text('الأونلاين بس')),
              ButtonSegment(value: 'both', label: Text('الاتنين')),
            ],
            selected: {?_scope},
            onSelectionChanged: (v) => setState(() => _scope = v.isEmpty ? null : v.first),
          ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _scope == null || (_price.text.trim().isNotEmpty && (p == null || p < 0)) ? null : () => Navigator.pop(context, (_price.text.trim(), _scope!)),
            child: const Text('متابعة'),
          ),
        ]),
      ),
    );
  }
}

/// ملخص اللي اشتروا الحصة قبل كده. بيرجع true = طبّق عليهم، false = للي هيشتري بعد كده بس، null = رجوع
class _PricePreviewDialog extends StatelessWidget {
  const _PricePreviewDialog({required this.preview, required this.price, required this.scope});
  final Map<String, dynamic> preview;
  final String price, scope;

  @override
  Widget build(BuildContext context) {
    final scopeText = const {'center': 'طلاب السناتر بس', 'online': 'طلاب الأونلاين بس', 'both': 'طلاب السناتر والأونلاين'}[scope]!;
    final buyers = (preview['buyers'] as num?)?.toInt() ?? 0;
    final refund = (preview['refund'] as Map?) ?? {};
    final charge = (preview['charge'] as Map?) ?? {};
    final students = ((preview['students'] as List?) ?? []).cast<Map>();
    final priceText = price.isEmpty ? 'سعر حصة الطالب العادي' : '$price ج (${fmtNum(preview['percent'])}% من السعر العادي)';
    return AlertDialog(
      title: const Text('تأكيد سعر الحصة'),
      content: SingleChildScrollView(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Text('السعر الجديد: $priceText\nلـ $scopeText', style: const TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 10),
          if (buyers == 0)
            const Text('محدش اشترى الحصة دي من رصيده لسه — السعر هيطبق على اللي هيشتري بعد كده.')
          else ...[
            Text('فيه $buyers طالب اشتروها قبل كده. لو طبّقت عليهم السعر الجديد:'),
            if ((refund['count'] ?? 0) > 0) Text('• ${refund['count']} هيرجعلهم فرق (إجمالي ${fmtNum(refund['total'])} ج)'),
            if ((charge['count'] ?? 0) > 0) Text('• ${charge['count']} هيتخصم منهم فرق (إجمالي ${fmtNum(charge['total'])} ج)'),
            if ((preview['unchanged'] ?? 0) > 0) Text('• ${preview['unchanged']} دفعوا نفس السعر — مش هيتغير حاجة'),
            if ((preview['unknown'] ?? 0) > 0) Text('• ${preview['unknown']} مش لاقيين حركة دفعهم — حسابهم مش هيتغير'),
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              title: const Text('تفاصيل الطلاب', style: TextStyle(fontSize: 14)),
              children: [
                for (final s in students)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 3),
                    child: Text(
                      '${s['name']} (${s['code']}${s['online'] == true ? '، أونلاين' : ''}): دفع ${s['paid'] == null ? '؟' : fmtNum(s['paid'])} ← ${fmtNum(s['newPrice'])} ج'
                      '${s['paid'] == null ? '' : (s['diff'] as num) > 0 ? ' — يرجعله ${fmtNum(s['diff'])}' : (s['diff'] as num) < 0 ? ' — يتخصم ${fmtNum(-(s['diff'] as num))}' : ''}',
                      style: const TextStyle(fontSize: 12.5),
                    ),
                  ),
              ],
            ),
          ],
        ]),
      ),
      actionsOverflowDirection: VerticalDirection.down,
      actionsOverflowButtonSpacing: 6,
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('رجوع')),
        FilledButton(onPressed: () => Navigator.pop(context, false), child: const Text('للي هيشتري بعد كده بس')),
        if (buyers > 0)
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AppColors.warning),
            onPressed: () async {
              final sure = await confirmDialog(context, title: 'متأكد؟', message: 'رصيد الطلاب اللي اشتروا الحصة هيتعدل بالفرق دلوقتي.', ok: 'أيوه طبّق');
              if (sure && context.mounted) Navigator.pop(context, true);
            },
            child: const Text('طبّق على اللي اشتروا كمان'),
          ),
      ],
    );
  }
}

class _SessionPicker extends StatefulWidget {
  const _SessionPicker({required this.options});
  final List<Map<String, dynamic>> options;
  @override
  State<_SessionPicker> createState() => _SessionPickerState();
}

class _SessionPickerState extends State<_SessionPicker> {
  String _q = '';
  @override
  Widget build(BuildContext context) {
    final list = widget.options.where((s) => _q.isEmpty || '${s['label']}'.toLowerCase().contains(_q.toLowerCase())).toList();
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.8,
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: TextField(
              autofocus: true,
              decoration: const InputDecoration(hintText: 'دور (المادة، السنتر، رقم الحصة)', prefixIcon: Icon(Icons.search), isDense: true),
              onChanged: (v) => setState(() => _q = v.trim()),
            ),
          ),
          Expanded(
            child: ListView.builder(
              itemCount: list.length,
              itemBuilder: (_, i) => ListTile(
                title: Text('${list[i]['label']}'),
                subtitle: Text(fmtDate(list[i]['date'])),
                onTap: () => Navigator.pop(context, (list[i]['id'] as num).toInt()),
              ),
            ),
          ),
        ]),
      ),
    );
  }
}
