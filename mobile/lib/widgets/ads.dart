import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../services/api.dart';
import '../services/session_store.dart';
import 'lesson_video.dart';
import 'video_source.dart';

Color _hex(dynamic v, Color fallback) {
  var s = '${v ?? ''}'.trim();
  if (!s.startsWith('#')) return fallback;
  s = s.substring(1);
  if (s.length == 3) s = s.split('').map((c) => '$c$c').join();
  if (s.length == 6) s = 'FF$s';
  final n = int.tryParse(s, radix: 16);
  return n == null ? fallback : Color(n);
}

/// فيديو الإعلان (درايف غالبًا) — لينكات درايف التانية بتتحول لشكل file/d عشان المشغل يعرفها
VideoSource _adVideoSource(String raw) {
  final m = RegExp(r'drive\.google\.com/(?:open\?id=|uc\?(?:export=\w+&)?id=)([a-zA-Z0-9_-]+)', caseSensitive: false).firstMatch(raw);
  return detectVideoSource(m != null ? 'https://drive.google.com/file/d/${m.group(1)}/view' : raw);
}

double _adAspect(dynamic v) => switch ('$v') { '9:16' => 9 / 16, '1:1' => 1.0, '4:3' => 4 / 3, _ => 16 / 9 };

/// الإعلانات اللي الأدمن عاملها للطالب/ولي الأمر — بتظهر مرة واحدة في كل صفحة كل ما البرنامج يتفتح
class Ads {
  static final Set<String> _shown = {};

  static Future<void> showFor(BuildContext context, AccountType type, String page) async {
    if (_shown.contains(page)) return;
    _shown.add(page);
    List<Map<String, dynamic>> ads;
    try {
      ads = await PortalApi.ads(type, page);
    } catch (_) {
      return; // الإعلانات عمرها ما توقف البرنامج
    }
    for (final ad in ads) {
      if (!context.mounted) return;
      await showDialog<void>(context: context, useRootNavigator: true, builder: (_) => _AdDialog(ad: ad));
    }
  }

  static void reset() => _shown.clear();
}

class _AdDialog extends StatelessWidget {
  const _AdDialog({required this.ad});
  final Map<String, dynamic> ad;

  String? get _link {
    final d = (ad['design'] as Map?) ?? {};
    final url = '${ad['link_url'] ?? d['buttonUrl'] ?? ''}';
    return url.isEmpty ? null : url;
  }

  Widget _content(BuildContext context) {
    if (ad['ad_type'] == 'image') {
      return ClipRRect(borderRadius: BorderRadius.circular(16), child: Image.network('${ad['image_url']}', fit: BoxFit.contain));
    }
    final d = (ad['design'] as Map?)?.cast<String, dynamic>() ?? {};
    final radius = ((d['borderRadius'] is num) ? d['borderRadius'] as num : num.tryParse('${d['borderRadius']}') ?? 18).toDouble();
    final align = switch ('${d['textAlign'] ?? 'center'}') {
      'right' => CrossAxisAlignment.end,
      'left' => CrossAxisAlignment.start,
      _ => CrossAxisAlignment.center,
    };
    final textAlign = switch ('${d['textAlign'] ?? 'center'}') { 'right' => TextAlign.right, 'left' => TextAlign.left, _ => TextAlign.center };
    final bgColor = _hex(d['backgroundColor'], const Color(0xFF4338CA));
    final image = '${d['imageUrl'] ?? ''}';
    final bgImage = '${d['backgroundImageUrl'] ?? ''}';
    final decoration = BoxDecoration(
      borderRadius: BorderRadius.circular(radius),
      color: bgImage.isEmpty && d['backgroundGradientTo'] == null ? bgColor : null,
      gradient: bgImage.isEmpty && d['backgroundGradientTo'] != null
          ? LinearGradient(colors: [bgColor, _hex(d['backgroundGradientTo'], bgColor)], begin: Alignment.topLeft, end: Alignment.bottomRight)
          : null,
      image: bgImage.isNotEmpty ? DecorationImage(image: NetworkImage(bgImage), fit: BoxFit.cover) : null,
    );
    final imageWidget = image.isEmpty ? null : Image.network(image, width: double.infinity, fit: BoxFit.cover);
    final videoUrl = '${d['videoUrl'] ?? ''}'.trim();
    final videoWidget = videoUrl.isEmpty
        ? null
        : LessonVideo(
            source: _adVideoSource(videoUrl),
            autoplay: d['videoAutoplay'] == true,
            muted: d['videoMuted'] == true || d['videoAutoplay'] == true,
            loop: d['videoLoop'] == true,
            aspectRatio: _adAspect(d['videoAspect']),
            borderRadius: 0,
            claimGestures: true,
          );
    final hasText = '${d['badgeText'] ?? ''}'.isNotEmpty ||
        '${d['heading'] ?? ''}'.isNotEmpty ||
        '${d['body'] ?? ''}'.isNotEmpty ||
        (d['buttonEnabled'] == true && '${d['buttonText'] ?? ''}'.isNotEmpty);
    // الكارت نفسه بياخد عرض الفيديو (الفيديو الطولي = كارت أضيق) عشان الفيديو يملا الكارت من غير فراغات
    var maxWidth = ((d['maxWidth'] as num?) ?? 420).toDouble();
    if (videoWidget != null) {
      final byHeight = MediaQuery.sizeOf(context).height * 0.58 * _adAspect(d['videoAspect']);
      if (byHeight < maxWidth) maxWidth = byHeight;
    }
    return ConstrainedBox(
      constraints: BoxConstraints(maxWidth: maxWidth),
      child: Container(
        clipBehavior: Clip.antiAlias,
        decoration: decoration,
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (videoWidget != null && d['videoPosition'] != 'bottom') videoWidget,
          if (imageWidget != null && d['imagePosition'] != 'bottom') imageWidget,
          if (videoWidget == null || hasText) Padding(
            padding: const EdgeInsets.fromLTRB(24, 24, 24, 24),
            child: Column(crossAxisAlignment: align, children: [
              if ('${d['badgeText'] ?? ''}'.isNotEmpty)
                Container(
                  margin: const EdgeInsets.only(bottom: 10),
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  decoration: BoxDecoration(color: _hex(d['badgeColor'], Colors.white24), borderRadius: BorderRadius.circular(999)),
                  child: Text('${d['badgeText']}', style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w700)),
                ),
              if ('${d['heading'] ?? ''}'.isNotEmpty)
                Text('${d['heading']}',
                    textAlign: textAlign,
                    style: TextStyle(color: _hex(d['headingColor'], Colors.white), fontSize: ((d['headingSize'] as num?) ?? 22).toDouble(), fontWeight: FontWeight.w800)),
              if ('${d['body'] ?? ''}'.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text('${d['body']}',
                      textAlign: textAlign,
                      style: TextStyle(color: _hex(d['bodyColor'], Colors.white), fontSize: ((d['bodySize'] as num?) ?? 15).toDouble(), height: 1.6)),
                ),
              if (d['buttonEnabled'] == true && '${d['buttonText'] ?? ''}'.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 16),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 10),
                    decoration: BoxDecoration(color: _hex(d['buttonColor'], const Color(0xFF14B8A6)), borderRadius: BorderRadius.circular(10)),
                    child: Text('${d['buttonText']}', style: TextStyle(color: _hex(d['buttonTextColor'], Colors.white), fontWeight: FontWeight.w700)),
                  ),
                ),
            ]),
          ),
          if (imageWidget != null && d['imagePosition'] == 'bottom') imageWidget,
          if (videoWidget != null && d['videoPosition'] == 'bottom') videoWidget,
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final link = _link;
    return Dialog(
      backgroundColor: Colors.transparent,
      elevation: 0,
      insetPadding: const EdgeInsets.all(20),
      child: Stack(clipBehavior: Clip.none, children: [
        GestureDetector(
          onTap: link == null ? null : () => launchUrl(Uri.parse(link), mode: LaunchMode.externalApplication),
          child: SingleChildScrollView(child: _content(context)),
        ),
        PositionedDirectional(
          top: -12,
          end: -12,
          child: Material(
            color: Colors.white,
            shape: const CircleBorder(),
            elevation: 4,
            child: IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.of(context).pop()),
          ),
        ),
      ]),
    );
  }
}
