import '../config.dart';

/// نفس منطق video-embed.js في الموقع: بيعرف الفيديو جاي منين
enum VideoKind { youtube, drive, vimeo, mediadelivery, iframe, direct, unknown }

class VideoSource {
  const VideoSource(this.kind, {this.id, this.url});
  final VideoKind kind;
  final String? id;
  final String? url;

  /// المشغلات اللي بتبلغنا بالوقت الحقيقي للفيديو
  bool get hasEvents => kind == VideoKind.direct || kind == VideoKind.youtube || kind == VideoKind.vimeo || kind == VideoKind.mediadelivery;
}

String? _normalizeVimeo(String url) {
  final parsed = Uri.tryParse(url);
  if (parsed == null) return null;
  final host = parsed.host.toLowerCase();
  if (host != 'vimeo.com' && !host.endsWith('.vimeo.com')) return null;
  final match = RegExp(r'(?:^|/)(\d+)(?:$|/)').firstMatch(parsed.path);
  if (match == null) return null;
  final id = match.group(1)!;
  final parts = parsed.pathSegments.where((p) => p.isNotEmpty).toList();
  final idIndex = parts.indexOf(id);
  final pathHash = idIndex >= 0 && idIndex + 1 < parts.length ? parts[idIndex + 1] : null;
  final privateHash = parsed.queryParameters['h'] ?? pathHash;
  final query = <String, String>{
    'h': ?privateHash,
    for (final p in ['app_id', 'referrer'])
      if (parsed.queryParameters[p] != null) p: parsed.queryParameters[p]!,
    'autoplay': '0',
    'playsinline': '1',
  };
  return Uri.https('player.vimeo.com', '/video/$id', query).toString();
}

String _normalizeMediaDelivery(String url) {
  final parsed = Uri.tryParse(url);
  if (parsed == null || !parsed.host.toLowerCase().contains('mediadelivery.net')) return url;
  return parsed.replace(queryParameters: {...parsed.queryParameters, 'autoplay': 'true', 'muted': 'true', 'responsive': 'true'}).toString();
}

VideoSource detectVideoSource(String? raw) {
  if (raw == null || raw.trim().isEmpty) return const VideoSource(VideoKind.unknown);
  final url = raw.trim();
  final yt = RegExp(r'(?:youtube\.com/(?:watch\?v=|embed/|shorts/|live/)|youtu\.be/)([a-zA-Z0-9_-]{11})', caseSensitive: false).firstMatch(url);
  if (yt != null) return VideoSource(VideoKind.youtube, id: yt.group(1));
  final ytParam = Uri.tryParse(url);
  if (ytParam != null && ytParam.host.contains('youtube.com') && (ytParam.queryParameters['v'] ?? '').length == 11) {
    return VideoSource(VideoKind.youtube, id: ytParam.queryParameters['v']);
  }
  final drive = RegExp(r'drive\.google\.com/file/d/([a-zA-Z0-9_-]+)', caseSensitive: false).firstMatch(url);
  if (drive != null) return VideoSource(VideoKind.drive, id: drive.group(1));
  final vimeo = _normalizeVimeo(url);
  if (vimeo != null) return VideoSource(VideoKind.vimeo, url: vimeo);
  if (RegExp('mediadelivery\\.net', caseSensitive: false).hasMatch(url)) {
    return VideoSource(VideoKind.mediadelivery, url: _normalizeMediaDelivery(url));
  }
  if (RegExp(r'\.(mp4|m4v|mov|webm|m3u8|mkv)(\?|$)', caseSensitive: false).hasMatch(url)) {
    return VideoSource(VideoKind.direct, url: url);
  }
  if (RegExp('^https?://', caseSensitive: false).hasMatch(url)) return VideoSource(VideoKind.iframe, url: url);
  return VideoSource(VideoKind.direct, url: url.startsWith('/') ? '${AppConfig.apiBase}$url' : url);
}

/// جزء فيديو من الدرس (مرفوع على السيرفر أو لينك)
VideoSource sourceForPart(Map<String, dynamic> part) {
  if (part['sourceType'] == 'upload') {
    return VideoSource(VideoKind.direct, url: '${AppConfig.apiBase}${part['filePath']}');
  }
  return detectVideoSource('${part['videoUrl'] ?? part['filePath'] ?? ''}');
}
