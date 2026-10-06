import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:image_picker/image_picker.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../services/api.dart';
import '../../theme.dart';
import '../../widgets/common.dart';
import 'portal_data.dart';

/// الرئيسية: البروفايل + الرصيد + النقط + الـ QR + الشحن + امتحانات الشامل
class HomeTab extends StatelessWidget {
  const HomeTab({super.key, required this.portal});
  final PortalData portal;

  @override
  Widget build(BuildContext context) {
    final s = portal.student;
    final isStudent = portal.isStudent;
    final sessions = portal.sessions;
    final attended = sessions.where((x) => x['attendanceStatus'] == 'attended').length;
    final absent = sessions.where((x) => x['attendanceStatus'] == 'absent').length;
    final warnings = ((s['warnings'] as List?) ?? []).cast<Map<String, dynamic>>();
    final assistant = (s['followUpAssistant'] as Map?)?.cast<String, dynamic>();
    final balance = (s['balance'] as num?) ?? 0;
    final exams = ((portal.data?['shamelExams'] as List?) ?? []).cast<Map<String, dynamic>>();

    return ListView(padding: const EdgeInsets.all(16), children: [
      _Header(portal: portal),
      const SizedBox(height: 14),
      if (s['isBlocked'] == true) _alert('⛔ الحساب ده محظور — تواصل مع الإدارة', AppColors.dangerSoft, AppColors.dangerText),
      if (warnings.isNotEmpty) _Warnings(warnings: warnings),
      Row(children: [
        _stat('الرصيد', '${fmtNum(balance)} ج', Icons.account_balance_wallet_outlined, balance < 0 ? AppColors.danger : AppColors.successText),
        const SizedBox(width: 10),
        _stat('النقط', fmtNum(s['points'] ?? 0), Icons.star_rounded, AppColors.warning),
      ]),
      const SizedBox(height: 10),
      Row(children: [
        _stat('حضور', '$attended', Icons.check_circle_outline, AppColors.accent),
        const SizedBox(width: 10),
        _stat('غياب', '$absent', Icons.cancel_outlined, AppColors.danger),
      ]),
      if (!isStudent && s['bookletStatus'] != null) ...[
        const SizedBox(height: 10),
        Card(
          child: ListTile(
            leading: const Icon(Icons.menu_book_outlined, color: AppColors.primary),
            title: const Text('حالة البوكليت'),
            trailing: s['bookletStatus'] == true
                ? const Pill('تم الاستلام', AppColors.successSoft, AppColors.successText)
                : const Pill('لم يستلم بعد', AppColors.neutralSoft, AppColors.muted),
          ),
        ),
      ],
      if (isStudent) ...[
        const SizedBox(height: 14),
        _RechargeCard(portal: portal),
      ],
      if (isStudent && portal.qrSvg != null) ...[
        const SizedBox(height: 14),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Column(children: [
              const Text('كود الحضور', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
              const Text('ورّي الكود ده للأسيستانت عشان يسجل حضورك — شغال حتى من غير نت', textAlign: TextAlign.center, style: TextStyle(color: AppColors.muted, fontSize: 13)),
              const SizedBox(height: 12),
              SvgPicture.string(portal.qrSvg!, width: 220, height: 220),
              const SizedBox(height: 8),
              Text('${s['studentCode'] ?? ''}', textDirection: TextDirection.ltr, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800, letterSpacing: 1)),
              const Text('🔒 كود خاص بيك، حافظ عليه', style: TextStyle(color: AppColors.muted, fontSize: 12.5)),
            ]),
          ),
        ),
      ],
      if (isStudent) ...[
        const SizedBox(height: 14),
        _PointsCard(portal: portal),
      ],
      if (assistant != null && '${assistant['name'] ?? ''}'.isNotEmpty) ...[
        const SizedBox(height: 14),
        _AssistantCard(assistant: assistant),
      ],
      if (exams.isNotEmpty) ...[
        const SizedBox(height: 14),
        _ShamelExams(exams: exams),
      ],
      const SizedBox(height: 90),
    ]);
  }

  static Widget _alert(String text, Color bg, Color fg) => Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(14)),
          child: Text(text, style: TextStyle(color: fg, fontWeight: FontWeight.w700)),
        ),
      );

  static Widget _stat(String label, String value, IconData icon, Color color) => Expanded(
        child: Card(
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Row(children: [
              Icon(icon, color: color, size: 30),
              const SizedBox(width: 10),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(label, style: const TextStyle(color: AppColors.muted, fontSize: 13)),
                  FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: AlignmentDirectional.centerStart,
                    child: Text(value, style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: color)),
                  ),
                ]),
              ),
            ]),
          ),
        ),
      );
}

class _Header extends StatelessWidget {
  const _Header({required this.portal});
  final PortalData portal;

  @override
  Widget build(BuildContext context) {
    final s = portal.student;
    final photo = '${s['profilePhotoUrl'] ?? ''}';
    final hasPhoto = photo.startsWith('http');
    final avatar = CircleAvatar(
      radius: 32,
      backgroundColor: Colors.white24,
      backgroundImage: hasPhoto ? NetworkImage(photo) : null,
      onBackgroundImageError: hasPhoto ? (_, _) {} : null,
      child: hasPhoto ? null : const Icon(Icons.person, color: Colors.white, size: 34),
    );
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        gradient: const LinearGradient(colors: [AppColors.primaryDark, AppColors.primary]),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(children: [
        if (portal.isStudent)
          GestureDetector(
            onTap: () => showPhotoPicker(context, portal),
            child: Stack(children: [
              avatar,
              const PositionedDirectional(
                bottom: 0,
                end: 0,
                child: CircleAvatar(radius: 11, backgroundColor: Colors.white, child: Icon(Icons.edit, size: 13, color: AppColors.primary)),
              ),
            ]),
          )
        else
          avatar,
        const SizedBox(width: 14),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${portal.isStudent ? 'أهلاً، ' : ''}${s['name'] ?? ''}', style: const TextStyle(color: Colors.white, fontSize: 19, fontWeight: FontWeight.w800)),
            Text('${s['subjectName'] ?? ''} • ${s['centerName'] ?? ''}', style: const TextStyle(color: Colors.white70)),
            const SizedBox(height: 4),
            Text('${s['studentCode'] ?? ''}', textDirection: TextDirection.ltr, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
          ]),
        ),
      ]),
    );
  }
}

class _Warnings extends StatelessWidget {
  const _Warnings({required this.warnings});
  final List<Map<String, dynamic>> warnings;
  @override
  Widget build(BuildContext context) {
    final n = warnings.length;
    final danger = n >= 3;
    final fg = danger ? AppColors.dangerText : AppColors.warningText;
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Card(
        color: danger ? AppColors.dangerSoft : AppColors.warningSoft,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              for (var i = 1; i <= 3; i++)
                Padding(
                  padding: const EdgeInsetsDirectional.only(end: 6),
                  child: Icon(Icons.warning_rounded, size: 30, color: i <= n ? fg : Colors.black12),
                ),
              const SizedBox(width: 6),
              Expanded(child: Text('🚨 تنبيه: $n من 3 إنذارات', style: TextStyle(fontWeight: FontWeight.w800, color: fg))),
            ]),
            if (danger)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text('⛔ حسابك محظور بالكامل، يرجى مراجعة إدارة السنتر فوراً', style: TextStyle(color: fg, fontWeight: FontWeight.w700)),
              ),
            const SizedBox(height: 6),
            ...warnings.map((w) => Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text('• ${'${w['reason'] ?? ''}'.isEmpty ? 'بدون سبب محدد' : w['reason']} — ${fmtDate(w['time'])}', style: TextStyle(color: fg)),
                )),
          ]),
        ),
      ),
    );
  }
}

class _RechargeCard extends StatefulWidget {
  const _RechargeCard({required this.portal});
  final PortalData portal;
  @override
  State<_RechargeCard> createState() => _RechargeCardState();
}

class _RechargeCardState extends State<_RechargeCard> {
  final _code = TextEditingController();
  bool _busy = false;
  String? _message;
  bool _ok = false;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final code = _code.text.trim();
    if (code.isEmpty) {
      setState(() { _message = 'أدخل كود الشحن أولاً.'; _ok = false; });
      return;
    }
    setState(() { _busy = true; _message = 'جاري إضافة الرصيد...'; _ok = true; });
    try {
      final res = await PortalApi.recharge(code);
      _code.clear();
      if (res['newBalance'] != null) widget.portal.patchStudent({'balance': res['newBalance']});
      setState(() { _message = '${res['message'] ?? 'تم إضافة الرصيد بنجاح.'}'; _ok = true; });
      widget.portal.refresh();
    } on ApiException catch (e) {
      setState(() { _message = e.offline ? 'الشحن محتاج نت — اتأكد من النت وجرب تاني' : e.message; _ok = false; });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Text('💳 إضافة رصيد بكود الشحن', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
          const SizedBox(height: 10),
          Row(children: [
            Expanded(
              child: TextField(
                controller: _code,
                textDirection: TextDirection.ltr,
                textCapitalization: TextCapitalization.characters,
                decoration: const InputDecoration(hintText: 'أدخل كود الشحن', isDense: true),
                onSubmitted: (_) => _submit(),
              ),
            ),
            const SizedBox(width: 8),
            FilledButton(
              style: FilledButton.styleFrom(minimumSize: const Size(84, 48)),
              onPressed: _busy ? null : _submit,
              child: _busy ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : const Text('إضافة'),
            ),
          ]),
          if (_message != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_message!, style: TextStyle(color: _ok ? AppColors.successText : AppColors.dangerText, fontSize: 13.5)),
            ),
        ]),
      ),
    );
  }
}

class _PointsCard extends StatefulWidget {
  const _PointsCard({required this.portal});
  final PortalData portal;
  @override
  State<_PointsCard> createState() => _PointsCardState();
}

class _PointsCardState extends State<_PointsCard> {
  bool _rules = false;

  @override
  Widget build(BuildContext context) {
    final rank = widget.portal.rank;
    final points = rank?['myPoints'] ?? widget.portal.student['points'] ?? 0;
    final history = widget.portal.transactions.where((t) => '${t['reason'] ?? ''}'.startsWith('نقاط:')).take(20).toList();
    const medals = ['🥇', '🥈', '🥉'];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            const Expanded(child: Text('🏆 النقط والترتيب', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15))),
            IconButton(
              tooltip: 'إزاي النقط بتتحسب؟',
              icon: const Icon(Icons.info_outline, color: AppColors.primary),
              onPressed: () => setState(() => _rules = !_rules),
            ),
          ]),
          if (_rules)
            Container(
              margin: const EdgeInsets.only(bottom: 10),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: AppColors.neutralSoft, borderRadius: BorderRadius.circular(10)),
              child: const Text(
                'إزاي النقط بتتحسب؟\n✅ حضور حصة = +2 نقطة\n📝 واجب كامل = +3 | مش كامل = +1 | مش معمول = -2\n🎯 درجة امتحان = نفس عدد النقاط\n🎬 مشاهدة فيديو جديد = +1 نقطة',
                style: TextStyle(fontSize: 13, height: 1.7),
              ),
            ),
          Row(children: [
            Expanded(
              child: Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(gradient: const LinearGradient(colors: [AppColors.primary, AppColors.accent]), borderRadius: BorderRadius.circular(14)),
                child: Column(children: [
                  Text(fmtNum(points), style: const TextStyle(color: Colors.white, fontSize: 28, fontWeight: FontWeight.w800)),
                  const Text('نقطة', style: TextStyle(color: Color(0xFFE0F2FE), fontSize: 12.5)),
                ]),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(color: AppColors.bg, borderRadius: BorderRadius.circular(14), border: Border.all(color: const Color(0xFFE2E4F3))),
                child: Column(children: [
                  Text(rank?['myRank'] != null ? '#${rank!['myRank']}' : '-', style: const TextStyle(color: AppColors.primary, fontSize: 28, fontWeight: FontWeight.w800)),
                  Text(rank?['total'] != null ? 'من ${rank!['total']} طالب' : 'الترتيب', style: const TextStyle(color: AppColors.muted, fontSize: 12.5)),
                ]),
              ),
            ),
          ]),
          if (rank != null && (rank['top3'] as List?)?.isNotEmpty == true) ...[
            const SizedBox(height: 12),
            const Text('أفضل 3 في مادتك:', style: TextStyle(color: AppColors.muted, fontSize: 13)),
            const SizedBox(height: 6),
            for (final (i, t) in ((rank['top3'] as List).cast<Map>()).indexed)
              Container(
                margin: const EdgeInsets.only(bottom: 6),
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                decoration: BoxDecoration(
                  color: t['isMe'] == true ? AppColors.warningSoft : null,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: t['isMe'] == true ? AppColors.warning : const Color(0xFFE2E4F3)),
                ),
                child: Row(children: [
                  Text(i < 3 ? medals[i] : '${i + 1}', style: const TextStyle(fontSize: 20)),
                  const SizedBox(width: 8),
                  Expanded(child: Text('${t['name']}', style: const TextStyle(fontWeight: FontWeight.w700))),
                  Text('${t['points']} نقطة', style: const TextStyle(color: AppColors.primary, fontWeight: FontWeight.w700)),
                ]),
              ),
          ],
          const Divider(height: 24),
          const Text('سجل نقاطي:', style: TextStyle(color: AppColors.muted, fontSize: 13)),
          if (history.isEmpty)
            const Padding(padding: EdgeInsets.only(top: 6), child: Text('لا يوجد سجل متاح', style: TextStyle(color: AppColors.muted)))
          else
            for (final h in history)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Row(children: [
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('${h['reason']}'.replaceFirst('نقاط: ', ''), style: const TextStyle(fontSize: 13.5)),
                      Text(fmtDate(h['time'], withTime: true), style: const TextStyle(color: AppColors.muted, fontSize: 11.5)),
                    ]),
                  ),
                  Text(
                    '${((h['amount'] as num?) ?? 0) >= 0 ? '+' : ''}${fmtNum(h['amount'])}',
                    textDirection: TextDirection.ltr,
                    style: TextStyle(fontWeight: FontWeight.w800, color: ((h['amount'] as num?) ?? 0) >= 0 ? AppColors.successText : AppColors.dangerText),
                  ),
                ]),
              ),
        ]),
      ),
    );
  }
}

class _AssistantCard extends StatelessWidget {
  const _AssistantCard({required this.assistant});
  final Map<String, dynamic> assistant;
  @override
  Widget build(BuildContext context) {
    final phone = '${assistant['phone'] ?? ''}'.trim();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(children: [
          Row(children: [
            Container(
              width: 50,
              height: 50,
              alignment: Alignment.center,
              decoration: BoxDecoration(gradient: const LinearGradient(colors: [AppColors.primary, AppColors.accent]), borderRadius: BorderRadius.circular(14)),
              child: Text('${assistant['name']}'.trim().characters.first, style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w800)),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Text('🎯 أسيستانت المتابعة الخاص بيك', style: TextStyle(color: AppColors.muted, fontSize: 12.5, fontWeight: FontWeight.w700)),
                Text('${assistant['name']}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
                if (phone.isNotEmpty) Text(phone, textDirection: TextDirection.ltr, style: const TextStyle(color: AppColors.muted, fontSize: 13)),
              ]),
            ),
            if (phone.isNotEmpty)
              IconButton(icon: const Icon(Icons.call, color: AppColors.accent), onPressed: () => launchUrl(Uri.parse('tel:$phone'))),
          ]),
          if (phone.isNotEmpty) ...[
            const SizedBox(height: 10),
            FilledButton.icon(
              style: FilledButton.styleFrom(backgroundColor: const Color(0xFF25D366), minimumSize: const Size.fromHeight(44)),
              onPressed: () => launchUrl(Uri.parse('https://wa.me/20${phone.replaceFirst(RegExp('^0'), '')}'), mode: LaunchMode.externalApplication),
              icon: const Icon(Icons.chat),
              label: const Text('تواصل عبر واتساب'),
            ),
          ],
        ]),
      ),
    );
  }
}

class _ShamelExams extends StatelessWidget {
  const _ShamelExams({required this.exams});
  final List<Map<String, dynamic>> exams;
  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Text('📝 درجات امتحانات الشامل', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
          for (final e in exams) ...[
            const SizedBox(height: 10),
            Builder(builder: (_) {
              final score = (e['score'] is num) ? e['score'] as num : num.tryParse('${e['score']}') ?? 0;
              final max = (e['maxScore'] is num) ? e['maxScore'] as num : num.tryParse('${e['maxScore']}') ?? 0;
              final pct = max > 0 ? (score / max * 100).round() : 0;
              final color = pct >= 85 ? const Color(0xFF10B981) : pct >= 50 ? AppColors.warning : const Color(0xFFEF4444);
              final stats = (e['stats'] as Map?)?.cast<String, dynamic>();
              return Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: AppColors.bg, borderRadius: BorderRadius.circular(12), border: Border.all(color: const Color(0xFFE2E4F3))),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('${e['name']}', style: const TextStyle(fontWeight: FontWeight.w700)),
                        Text(e['examDate'] != null ? fmtDate(e['examDate']) : 'بدون تاريخ', style: const TextStyle(color: AppColors.muted, fontSize: 12.5)),
                      ]),
                    ),
                    Column(children: [
                      Text('${fmtNum(score)} / ${fmtNum(max)}', textDirection: TextDirection.ltr, style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: color)),
                      Text('$pct%', style: TextStyle(color: color, fontWeight: FontWeight.w700)),
                    ]),
                  ]),
                  if (stats != null) ...[
                    const SizedBox(height: 8),
                    Wrap(spacing: 6, runSpacing: 6, children: [
                      Pill('🔼 أعلى درجة: ${stats['max']}', const Color(0x1F10B981), const Color(0xFF047857), fontSize: 11.5),
                      Pill('🔽 أقل درجة: ${stats['min']}', const Color(0x1FEF4444), AppColors.dangerText, fontSize: 11.5),
                      Pill('📊 المتوسط: ${stats['avg']}', AppColors.primary.withValues(alpha: 0.12), AppColors.primary, fontSize: 11.5),
                    ]),
                  ],
                ]),
              );
            }),
          ],
        ]),
      ),
    );
  }
}

/// تغيير صورة البروفايل: صورة جاهزة من الموقع أو صورة من الموبايل
Future<void> showPhotoPicker(BuildContext context, PortalData portal) async {
  await showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheetContext) => _PhotoSheet(portal: portal),
  );
}

class _PhotoSheet extends StatefulWidget {
  const _PhotoSheet({required this.portal});
  final PortalData portal;
  @override
  State<_PhotoSheet> createState() => _PhotoSheetState();
}

class _PhotoSheetState extends State<_PhotoSheet> {
  List<String>? _avatars;
  String? _message;
  bool _ok = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    PortalApi.avatars().then((a) {
      if (mounted) setState(() => _avatars = a);
    }).catchError((e) {
      if (mounted) setState(() { _avatars = []; _message = 'تغيير الصورة محتاج نت'; });
    });
  }

  Future<void> _save(Future<String> Function() getUrl) async {
    setState(() { _busy = true; _message = '⏳ جاري الحفظ...'; _ok = true; });
    try {
      final url = await getUrl();
      await PortalApi.savePhotoUrl(url);
      widget.portal.patchStudent({'profilePhotoUrl': url});
      if (!mounted) return;
      setState(() { _message = '✅ تم حفظ الصورة'; _ok = true; });
      await Future<void>.delayed(const Duration(milliseconds: 800));
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (mounted) setState(() { _message = e.message; _ok = false; });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _upload(ImageSource from) async {
    final x = await ImagePicker().pickImage(source: from, maxWidth: 1200, imageQuality: 85);
    if (x == null) return;
    await _save(() => PortalApi.uploadPhoto(File(x.path)));
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.7,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            const Text('تغيير صورة البروفايل', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
            const SizedBox(height: 10),
            Row(children: [
              Expanded(child: OutlinedButton.icon(onPressed: _busy ? null : () => _upload(ImageSource.gallery), icon: const Icon(Icons.photo_library), label: const Text('من الصور'))),
              const SizedBox(width: 8),
              Expanded(child: OutlinedButton.icon(onPressed: _busy ? null : () => _upload(ImageSource.camera), icon: const Icon(Icons.photo_camera), label: const Text('بالكاميرا'))),
            ]),
            if (_message != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(_message!, style: TextStyle(color: _ok ? AppColors.successText : AppColors.dangerText)),
              ),
            const SizedBox(height: 10),
            const Text('أو اختار صورة جاهزة:', style: TextStyle(color: AppColors.muted)),
            const SizedBox(height: 8),
            Expanded(
              child: _avatars == null
                  ? const Center(child: CircularProgressIndicator())
                  : GridView.count(
                      crossAxisCount: 4,
                      mainAxisSpacing: 8,
                      crossAxisSpacing: 8,
                      children: [
                        for (final a in _avatars!)
                          InkWell(
                            borderRadius: BorderRadius.circular(40),
                            onTap: _busy ? null : () => _save(() async => a),
                            child: CircleAvatar(backgroundImage: NetworkImage(a), backgroundColor: AppColors.neutralSoft),
                          ),
                      ],
                    ),
            ),
          ]),
        ),
      ),
    );
  }
}
