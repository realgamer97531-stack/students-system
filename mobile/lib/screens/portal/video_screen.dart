import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../theme.dart';
import '../../widgets/lesson_video.dart';
import '../../widgets/video_source.dart';

/// فتح لينك: لو فيديو بيشتغل جوه البرنامج، ولو حاجة تانية (زي فورم الاختبار) بيفتح في المتصفح
Future<void> openVideoOrLink(BuildContext context, String url, String title) async {
  var clean = url.trim();
  if (clean.isEmpty) return;
  if (!clean.startsWith('http://') && !clean.startsWith('https://')) clean = 'https://$clean';
  final source = detectVideoSource(clean);
  if (source.kind == VideoKind.iframe || source.kind == VideoKind.unknown) {
    await launchUrl(Uri.parse(clean), mode: LaunchMode.externalApplication);
    return;
  }
  await Navigator.of(context).push(MaterialPageRoute(builder: (_) => VideoScreen(title: title, parts: [{'videoUrl': clean}])));
}

/// شاشة فيديو بسيطة (فيديو الواجب، إجابة الاختبار، الأسئلة، الفيديوهات الإضافية) — من غير تسجيل مشاهدة
class VideoScreen extends StatefulWidget {
  const VideoScreen({super.key, required this.title, required this.parts});
  final String title;
  final List<Map<String, dynamic>> parts;
  @override
  State<VideoScreen> createState() => _VideoScreenState();
}

class _VideoScreenState extends State<VideoScreen> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final part = widget.parts[_index];
    final many = widget.parts.length > 1;
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        LessonVideo(key: ValueKey(_index), source: sourceForPart(part), autoplay: true),
        if (many) ...[
          const SizedBox(height: 14),
          Row(children: [
            OutlinedButton(onPressed: _index > 0 ? () => setState(() => _index--) : null, child: const Text('السابق')),
            Expanded(child: Text('${_index + 1} / ${widget.parts.length}', textAlign: TextAlign.center, style: const TextStyle(color: AppColors.muted))),
            OutlinedButton(onPressed: _index < widget.parts.length - 1 ? () => setState(() => _index++) : null, child: const Text('التالي')),
          ]),
        ],
      ]),
    );
  }
}
