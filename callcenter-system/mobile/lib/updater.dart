import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:ota_update/ota_update.dart';
import 'package:package_info_plus/package_info_plus.dart';

import 'config.dart';

class AppRelease {
  AppRelease(this.version, this.apkUrl, this.notes);
  final String version;
  final String apkUrl;
  final String notes;
}

/// تحديثات التطبيق: بندور على آخر إصدار في GitHub Releases، ولو أحدث بننزله ونثبته
class Updater {
  static Future<String> currentVersion() async => (await PackageInfo.fromPlatform()).version;

  static List<int> _parse(String v) =>
      v.replaceFirst(RegExp(r'^v'), '').split('.').map((p) => int.tryParse(p) ?? 0).toList();

  static bool _isNewer(String latest, String current) {
    final a = _parse(latest), b = _parse(current);
    for (var i = 0; i < 3; i++) {
      final x = i < a.length ? a[i] : 0, y = i < b.length ? b[i] : 0;
      if (x != y) return x > y;
    }
    return false;
  }

  /// بيرجع الإصدار الجديد لو موجود، أو null لو التطبيق محدث
  static Future<AppRelease?> check() async {
    final response = await http
        .get(Uri.parse('https://api.github.com/repos/${AppConfig.releasesOwner}/${AppConfig.releasesRepo}/releases/latest'),
            headers: {'Accept': 'application/vnd.github+json'})
        .timeout(const Duration(seconds: 20));
    if (response.statusCode == 404) return null; // لسه مفيش إصدارات منشورة
    if (response.statusCode != 200) throw Exception('GitHub ${response.statusCode}');
    final data = jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
    final tag = data['tag_name'] as String? ?? '';
    final assets = (data['assets'] as List? ?? []).cast<Map<String, dynamic>>();
    final apk = assets.where((a) => (a['name'] as String).endsWith('.apk')).firstOrNull;
    if (apk == null) return null;
    final current = await currentVersion();
    if (!_isNewer(tag, current)) return null;
    return AppRelease(tag.replaceFirst('v', ''), apk['browser_download_url'] as String, data['body'] as String? ?? '');
  }

  /// يدور على تحديث، ولو لقى يسأل المستخدم ويثبته. silent = مايقولش حاجة لو مفيش تحديث
  static Future<void> checkAndPrompt(BuildContext context, {bool silent = false}) async {
    AppRelease? release;
    try {
      release = await check();
    } catch (_) {
      if (!silent && context.mounted) _snack(context, 'مش قادر يدور على تحديثات دلوقتي — اتأكد من النت');
      return;
    }
    if (!context.mounted) return;
    if (release == null) {
      if (!silent) _snack(context, '✔ التطبيق محدث لآخر إصدار');
      return;
    }
    final found = release;
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('تحديث جديد ${found.version}'),
        content: const Text('فيه إصدار جديد من التطبيق. تنزله وتثبته دلوقتي؟'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('بعدين')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('تحديث')),
        ],
      ),
    );
    if (ok == true && context.mounted) {
      await showDialog<void>(context: context, barrierDismissible: false, builder: (_) => _DownloadDialog(found));
    }
  }

  static void _snack(BuildContext context, String text) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }
}

class _DownloadDialog extends StatefulWidget {
  const _DownloadDialog(this.release);
  final AppRelease release;
  @override
  State<_DownloadDialog> createState() => _DownloadDialogState();
}

class _DownloadDialogState extends State<_DownloadDialog> {
  double? _progress;
  String _status = 'بيبدأ التنزيل...';
  bool _done = false;

  @override
  void initState() {
    super.initState();
    try {
      OtaUpdate().execute(widget.release.apkUrl, destinationFilename: 'callcenter-${widget.release.version}.apk').listen(
        (event) {
          if (!mounted) return;
          setState(() {
            switch (event.status) {
              case OtaStatus.DOWNLOADING:
                _progress = (double.tryParse(event.value ?? '') ?? 0) / 100;
                _status = 'بينزل التحديث ${event.value ?? 0}%';
                break;
              case OtaStatus.INSTALLING:
              case OtaStatus.INSTALLATION_DONE:
                _status = 'اضغط "تثبيت" في الشاشة اللي ظهرت';
                _done = true;
                break;
              case OtaStatus.PERMISSION_NOT_GRANTED_ERROR:
                _status = 'لازم تسمح للبرنامج بتثبيت التطبيقات من الإعدادات وتجرب تاني';
                _done = true;
                break;
              default:
                _status = 'التحديث فشل — جرب تاني لما النت يبقى كويس';
                _done = true;
            }
          });
        },
        onError: (_) {
          if (mounted) setState(() { _status = 'التحديث فشل — جرب تاني'; _done = true; });
        },
      );
    } catch (_) {
      _status = 'التحديث فشل — جرب تاني';
      _done = true;
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('تحديث ${widget.release.version}'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        if (!_done) LinearProgressIndicator(value: _progress),
        const SizedBox(height: 16),
        Text(_status),
      ]),
      actions: [if (_done) TextButton(onPressed: () => Navigator.pop(context), child: const Text('تمام'))],
    );
  }
}
