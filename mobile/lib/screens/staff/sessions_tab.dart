import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../services/cache.dart';
import '../../services/net.dart';
import '../../services/session_store.dart';
import '../../services/staff_api.dart';
import '../../services/staff_store.dart';
import '../../theme.dart';
import '../../widgets/common.dart';

/// تقارير الحصص المختصرة (قراءة بس). من /api/staff/sessions و /api/staff/sessions/:id/brief
/// (نفس حسبة صفحة تقرير الحصة على الموقع). آخر نسخة بتتحفظ وتظهر لو مفيش نت.
class SessionsTab extends StatefulWidget {
  const SessionsTab({super.key, required this.user});
  final StaffUser user;
  @override
  State<SessionsTab> createState() => _SessionsTabState();
}

/// تحميل + حفظ آخر نسخة. بيرجع (البيانات، وقت الحفظ لو جاية من المحفوظ)
Future<(Map<String, dynamic>, DateTime?)?> _loadCached(String path, String cacheKey, StaffUser user, void Function(String) onError) async {
  try {
    final data = await StaffApi.getJson(path, userId: user.id);
    Connection.report(true);
    await Cache.write(cacheKey, data);
    return (data, null);
  } on DeviceNotAuthorized catch (e) {
    StaffStore.deviceRevoked.value = true;
    onError('$e');
  } on ApiException catch (e) {
    if (e.offline) Connection.report(false);
    final saved = await Cache.read(cacheKey);
    if (saved != null && saved.data is Map) return ((saved.data as Map).cast<String, dynamic>(), saved.savedAt);
    onError(e.offline ? 'تقارير الحصص محتاجة نت أول مرة — اتأكد من النت وجرب تاني' : e.message);
  }
  return null;
}

int _sessionColor(String kind, dynamic id) {
  final i = (id as num?)?.toInt();
  final snap = StaffStore.snapshot.value;
  final saved = kind == 'center' ? snap?.centerColors[i] : snap?.subjectColors[i];
  return saved ?? autoEntityColor(kind, i);
}

class _SessionsTabState extends State<SessionsTab> {
  List<Map<String, dynamic>>? _sessions;
  DateTime? _savedAt;
  String? _error;
  String _q = '';

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() => _error = null);
    final r = await _loadCached('/api/staff/sessions', 'staff_sessions', widget.user, (e) => setState(() => _error = e));
    if (r != null && mounted) {
      setState(() {
        _sessions = ((r.$1['sessions'] as List?) ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList();
        _savedAt = r.$2;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_sessions == null) {
      return _error != null ? ErrorView(message: _error!, onRetry: _refresh) : const Center(child: CircularProgressIndicator());
    }
    final words = _q.trim().toLowerCase().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
    final list = _sessions!.where((s) {
      final text = 'حصة ${s['lesson']} ${s['center']} ${s['subject']} ${s['serial'] ?? ''} ${s['date'] ?? ''}'.toLowerCase();
      return words.every(text.contains);
    }).toList();
    return Column(children: [
      if (_savedAt != null) OfflineBanner(savedAt: _savedAt),
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
        child: TextField(
          decoration: const InputDecoration(hintText: 'دور (رقم الحصة، السنتر، المادة، التاريخ)', prefixIcon: Icon(Icons.search), isDense: true),
          onChanged: (v) => setState(() => _q = v),
        ),
      ),
      Expanded(
        child: RefreshIndicator(
          onRefresh: _refresh,
          child: list.isEmpty
              ? const EmptyView('مفيش حصص بالبحث ده', icon: Icons.event_busy_outlined)
              : ListView.builder(
                  padding: const EdgeInsets.only(bottom: 30),
                  itemCount: list.length,
                  itemBuilder: (_, i) {
                    final s = list[i];
                    final cancelled = s['status'] == 'cancelled';
                    return ListTile(
                      leading: SessionMixBadge(
                        subjectColor: _sessionColor('subject', s['subjectId']),
                        centerColor: _sessionColor('center', s['centerId']),
                        label: '${s['lesson'] ?? ''}',
                      ),
                      title: Wrap(spacing: 6, runSpacing: 4, children: [
                        ColorChip('${s['subject']}', _sessionColor('subject', s['subjectId'])),
                        ColorChip('${s['center']}', _sessionColor('center', s['centerId'])),
                        if (cancelled) const Pill('ملغية', AppColors.dangerSoft, AppColors.danger, fontSize: 11),
                      ]),
                      subtitle: Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text('حصة ${s['lesson'] ?? ''} • سيريال ${s['serial'] ?? '-'}${'${s['date'] ?? ''}'.isNotEmpty ? ' • ${s['date']}' : ''}'),
                      ),
                      trailing: Pill('${s['present']} حاضر', AppColors.successSoft, AppColors.successText, fontSize: 11.5),
                      onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => SessionBriefPage(user: widget.user, session: s))),
                    );
                  },
                ),
        ),
      ),
    ]);
  }
}

class SessionBriefPage extends StatefulWidget {
  const SessionBriefPage({super.key, required this.user, required this.session});
  final StaffUser user;
  final Map<String, dynamic> session;
  @override
  State<SessionBriefPage> createState() => _SessionBriefPageState();
}

const _homeworkLabels = {
  'complete': ('كامل', AppColors.successSoft, AppColors.successText),
  'incomplete': ('مش كامل', AppColors.warningSoft, AppColors.warningText),
  'no_steps': ('من غير خطوات', AppColors.neutralSoft, AppColors.muted),
  'not_done': ('مش معمول', AppColors.dangerSoft, AppColors.dangerText),
};

class _SessionBriefPageState extends State<SessionBriefPage> {
  Map<String, dynamic>? _data;
  DateTime? _savedAt;
  String? _error;
  String _q = '';
  bool _absent = false;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() => _error = null);
    final id = widget.session['id'];
    final r = await _loadCached('/api/staff/sessions/$id/brief', 'staff_session_brief_$id', widget.user, (e) => setState(() => _error = e));
    if (r != null && mounted) setState(() { _data = r.$1; _savedAt = r.$2; });
  }

  List<Map<String, dynamic>> _rows(String key) => ((_data?[key] as List?) ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList();

  @override
  Widget build(BuildContext context) {
    final s = widget.session;
    return Scaffold(
      appBar: AppBar(title: Text('تقرير حصة ${s['lesson'] ?? ''}')),
      body: _data == null
          ? (_error != null ? ErrorView(message: _error!, onRetry: _refresh) : const Center(child: CircularProgressIndicator()))
          : RefreshIndicator(onRefresh: _refresh, child: _body()),
    );
  }

  Widget _body() {
    final session = (_data!['session'] as Map).cast<String, dynamic>();
    final stats = (_data!['stats'] as Map).cast<String, dynamic>();
    final hw = ((stats['homework'] as Map?) ?? {}).cast<String, dynamic>();
    final exam = (stats['exam'] as Map?)?.cast<String, dynamic>();
    final present = _rows('present');
    final absent = _rows('absent');
    final words = _q.trim().toLowerCase().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
    bool hit(Map<String, dynamic> r) {
      final text = '${r['name']} ${r['code']} ${r['phone'] ?? ''} ${r['parentPhone'] ?? ''}'.toLowerCase();
      return words.every(text.contains);
    }

    final shown = (_absent ? absent : present).where(hit).toList();

    return ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 40), children: [
      if (_savedAt != null) Padding(padding: const EdgeInsets.only(top: 8), child: OfflineBanner(savedAt: _savedAt)),
      const SizedBox(height: 12),
      Wrap(spacing: 6, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
        ColorChip('${session['subject']}', _sessionColor('subject', session['subjectId'])),
        ColorChip('${session['center']}', _sessionColor('center', session['centerId'])),
        Text('سيريال ${session['serial'] ?? '-'}${'${session['date'] ?? ''}'.isNotEmpty ? ' • ${session['date']}' : ''}', style: const TextStyle(color: AppColors.muted)),
        if (session['status'] == 'cancelled') const Pill('ملغية', AppColors.dangerSoft, AppColors.danger, fontSize: 11),
      ]),
      const SizedBox(height: 12),
      GridView.count(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        crossAxisCount: 3,
        mainAxisSpacing: 8,
        crossAxisSpacing: 8,
        childAspectRatio: 1.45,
        children: [
          _stat('حاضر', '${stats['present']}', AppColors.successSoft, AppColors.successText),
          _stat('غايب', '${stats['absent']}', AppColors.dangerSoft, AppColors.dangerText),
          _stat('من سنتر تاني', '${stats['otherCenter']}', AppColors.neutralSoft, AppColors.text),
          _stat('واجب كامل', '${hw['complete'] ?? 0}', AppColors.successSoft, AppColors.successText),
          _stat('واجب ناقص', '${(hw['incomplete'] ?? 0) + (hw['no_steps'] ?? 0) + (hw['not_done'] ?? 0)}', AppColors.warningSoft, AppColors.warningText),
          _stat('واجب متسجلش', '${hw['none'] ?? 0}', AppColors.neutralSoft, AppColors.muted),
          if (exam != null) _stat('متوسط ${exam['name']}', exam['average'] == null ? '-' : '${fmtNum(exam['average'])}/${fmtNum(exam['max'])}', const Color(0xFFE0F2FE), const Color(0xFF0369A1)),
          if (stats['cash'] != null) _stat('الكاش', '${fmtNum(stats['cash'])} ج', AppColors.successSoft, AppColors.successText),
        ],
      ),
      const SizedBox(height: 14),
      SegmentedButton<bool>(
        segments: [
          ButtonSegment(value: false, label: Text('الحاضرين (${present.length})')),
          ButtonSegment(value: true, label: Text('الغايبين (${absent.length})')),
        ],
        selected: {_absent},
        onSelectionChanged: (v) => setState(() => _absent = v.first),
      ),
      const SizedBox(height: 10),
      TextField(
        decoration: const InputDecoration(hintText: 'دور بالاسم أو الكود أو التليفون', prefixIcon: Icon(Icons.search), isDense: true),
        onChanged: (v) => setState(() => _q = v),
      ),
      const SizedBox(height: 6),
      if (shown.isEmpty)
        const Padding(padding: EdgeInsets.all(24), child: Text('مفيش طلاب', textAlign: TextAlign.center, style: TextStyle(color: AppColors.muted))),
      for (final r in shown) _student(r),
    ]);
  }

  Widget _stat(String label, String value, Color bg, Color fg) => Container(
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12)),
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
          FittedBox(child: Text(value, style: TextStyle(color: fg, fontSize: 20, fontWeight: FontWeight.w800))),
          Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: fg, fontSize: 11.5, fontWeight: FontWeight.w600)),
        ]),
      );

  Widget _student(Map<String, dynamic> r) {
    final hwStatus = r['homework'] == null ? null : (_homeworkLabels.containsKey(r['homework']) ? r['homework'] as String : 'not_done');
    final phone = '${r['phone'] ?? ''}'.isNotEmpty ? '${r['phone']}' : '${r['parentPhone'] ?? ''}';
    final pills = <Widget>[
      if (!_absent && r['where'] == 'أونلاين') const Pill('أونلاين', Color(0xFFE0F2FE), Color(0xFF0369A1), fontSize: 11),
      if (!_absent && r['otherCenter'] != null) Pill('من ${r['otherCenter']}', AppColors.neutralSoft, AppColors.text, fontSize: 11),
      if (!_absent && hwStatus != null) Pill('واجب: ${_homeworkLabels[hwStatus]!.$1}', _homeworkLabels[hwStatus]!.$2, _homeworkLabels[hwStatus]!.$3, fontSize: 11),
      if (!_absent && r['exam'] != null) Pill('امتحان: ${fmtNum(r['exam'])}', AppColors.neutralSoft, AppColors.text, fontSize: 11),
      if (!_absent && r['payment'] is num && (r['payment'] as num) > 0) Pill('دفع ${fmtNum(r['payment'])} ج', AppColors.successSoft, AppColors.successText, fontSize: 11),
      if (_absent && r['attendedElsewhere'] != null) Pill('حضر في ${r['attendedElsewhere']}', AppColors.warningSoft, AppColors.warningText, fontSize: 11),
    ];
    return Card(
      margin: const EdgeInsets.only(top: 6),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 4, 8),
        child: Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${r['name']}', style: const TextStyle(fontWeight: FontWeight.w800)),
              Text('${r['code']}${phone.isNotEmpty ? ' • $phone' : ''}', style: const TextStyle(color: AppColors.muted, fontSize: 12.5)),
              if ('${r['comment'] ?? ''}'.isNotEmpty) Text('💬 ${r['comment']}', style: const TextStyle(fontSize: 12.5)),
              if (pills.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Wrap(spacing: 6, runSpacing: 4, children: pills)),
            ]),
          ),
          if (phone.isNotEmpty) IconButton(icon: const Icon(Icons.call, color: AppColors.accent), onPressed: () => launchUrl(Uri.parse('tel:$phone'))),
        ]),
      ),
    );
  }
}
