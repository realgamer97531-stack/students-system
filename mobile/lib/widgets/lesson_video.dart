import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:video_player/video_player.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import '../config.dart';
import '../theme.dart';
import 'video_source.dart';

/// تحكم في المشغل من برة (عشان السؤال المنبثق يوقف الفيديو ويكمله)
class LessonVideoController {
  _LessonVideoState? _state;
  void pause() => _state?._pause();
  void play() => _state?._play();
  Future<void> exitFullscreen() async => _state?._exitFullscreen();
}

/// مشغل الفيديو جوه شاشات البرنامج.
/// - فيديو مرفوع/لينك مباشر: مشغل أندرويد نفسه.
/// - يوتيوب/فيميو/باني/درايف: المشغل الرسمي بتاعهم بس (مش صفحة الموقع)، وبيبلغ البرنامج بالوقت.
class LessonVideo extends StatefulWidget {
  const LessonVideo({
    super.key,
    required this.source,
    this.controller,
    this.startAt = 0,
    this.endAt = 0,
    this.autoplay = false,
    this.onTime,
    this.onEnded,
    this.onPlayState,
  });

  final VideoSource source;
  final LessonVideoController? controller;
  final int startAt;

  /// لفيديو حل السؤال: يقف هنا (0 = لحد الآخر)
  final int endAt;
  final bool autoplay;

  /// الوقت الحقيقي للفيديو (من المشغلات اللي بتبلغ بيه)
  final void Function(double seconds, double? duration, bool playing)? onTime;
  final VoidCallback? onEnded;
  final void Function(bool playing, double seconds)? onPlayState;

  @override
  State<LessonVideo> createState() => _LessonVideoState();
}

class _LessonVideoState extends State<LessonVideo> with WidgetsBindingObserver {
  VideoPlayerController? _native;
  WebViewController? _web;
  String? _error;
  bool _endedSent = false;
  bool _wasPlaying = false;
  VoidCallback? _hideCustomView;
  bool _visible = true;

  VideoSource get _src => widget.source;

  @override
  void initState() {
    super.initState();
    widget.controller?._state = this;
    WidgetsBinding.instance.addObserver(this);
    if (_src.kind == VideoKind.direct) {
      _initNative();
    } else if (_src.kind != VideoKind.unknown) {
      _initWeb();
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // التاب اتقفل (المستخدم راح صفحة تانية من تحت): الفيديو يقف
    final visible = TickerMode.valuesOf(context).enabled;
    if (_visible && !visible) _pause();
    _visible = visible;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused || state == AppLifecycleState.hidden) _pause();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    if (widget.controller?._state == this) widget.controller!._state = null;
    _native?.removeListener(_onNativeTick);
    _native?.dispose();
    _web?.loadRequest(Uri.parse('about:blank')).catchError((_) {});
    super.dispose();
  }

  // ===== المشغل المباشر =====

  Future<void> _initNative() async {
    final c = VideoPlayerController.networkUrl(Uri.parse(_src.url!));
    _native = c;
    try {
      await c.initialize();
      if (widget.startAt > 0) await c.seekTo(Duration(seconds: widget.startAt));
      c.addListener(_onNativeTick);
      if (widget.autoplay) await c.play();
      if (mounted) setState(() {});
    } catch (_) {
      if (mounted) setState(() => _error = 'مش قادر يشغل الفيديو — اتأكد من النت');
    }
  }

  void _onNativeTick() {
    final c = _native!;
    final v = c.value;
    final secs = v.position.inMilliseconds / 1000;
    final dur = v.duration.inMilliseconds / 1000;
    if (v.isPlaying != _wasPlaying) {
      _wasPlaying = v.isPlaying;
      widget.onPlayState?.call(v.isPlaying, secs);
    }
    widget.onTime?.call(secs, dur > 0 ? dur : null, v.isPlaying);
    if (widget.endAt > 0 && secs >= widget.endAt && v.isPlaying) {
      c.pause();
      _sendEnded();
    }
    if (dur > 0 && secs >= dur - 0.3 && !v.isPlaying) _sendEnded();
    if (mounted) setState(() {});
  }

  void _sendEnded() {
    if (_endedSent) return;
    _endedSent = true;
    widget.onEnded?.call();
  }

  // ===== المشغلات الخارجية =====

  void _initWeb() {
    final c = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(Colors.black)
      ..addJavaScriptChannel('App', onMessageReceived: (m) => _onWebMessage(m.message))
      ..setNavigationDelegate(NavigationDelegate(onNavigationRequest: (req) {
        final uri = Uri.tryParse(req.url);
        // أي لينك برة المشغل (زي "شاهد على يوتيوب") بيفتح برة البرنامج
        if (req.isMainFrame && uri != null && uri.scheme.startsWith('http') && !req.url.startsWith(AppConfig.portalWebBase)) {
          launchUrl(uri, mode: LaunchMode.externalApplication);
          return NavigationDecision.prevent;
        }
        return NavigationDecision.navigate;
      }));
    final platform = c.platform;
    if (platform is AndroidWebViewController) {
      platform.setMediaPlaybackRequiresUserGesture(false);
      platform.setCustomWidgetCallbacks(
        onShowCustomWidget: (child, onHidden) => _showFullscreen(child, onHidden),
        onHideCustomWidget: _closeFullscreenRoute,
      );
    }
    // الصفحة الصغيرة دي "على دومين الموقع" عشان الفيديوهات المقفولة على الدومين تشتغل زي الموقع بالظبط
    c.loadHtmlString(_embedHtml(), baseUrl: '${AppConfig.portalWebBase}/');
    _web = c;
  }

  void _onWebMessage(String raw) {
    Map<String, dynamic> m;
    try {
      m = (jsonDecode(raw) as Map).cast<String, dynamic>();
    } catch (_) {
      return;
    }
    final t = (m['t'] as num?)?.toDouble() ?? 0;
    final d = (m['d'] as num?)?.toDouble();
    switch (m['e']) {
      case 'time':
        widget.onTime?.call(t, d != null && d > 0 ? d : null, m['p'] != false);
        if (widget.endAt > 0 && t >= widget.endAt) {
          _pause();
          _sendEnded();
        }
        if (d != null && d > 0 && t >= d - 0.5) _sendEnded();
      case 'play':
        widget.onPlayState?.call(true, t);
      case 'pause':
        widget.onPlayState?.call(false, t);
      case 'ended':
        widget.onPlayState?.call(false, t);
        _sendEnded();
    }
  }

  String _embedHtml() {
    final start = widget.startAt;
    final end = widget.endAt;
    const head = '<!DOCTYPE html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">'
        '<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#p,iframe{position:absolute;inset:0;width:100%;height:100%;border:0}</style>'
        '</head><body>';
    const send = 'function send(o){try{App.postMessage(JSON.stringify(o))}catch(e){}}';
    switch (_src.kind) {
      case VideoKind.youtube:
        final vars = {'playsinline': 1, 'rel': 0, 'modestbranding': 1, 'start': start, if (end > 0) 'end': end, 'autoplay': widget.autoplay ? 1 : 0};
        return '$head<div id="p"></div><script>$send'
            'var player;'
            'function onYouTubeIframeAPIReady(){player=new YT.Player("p",{width:"100%",height:"100%",videoId:${jsonEncode(_src.id)},playerVars:${jsonEncode(vars)},'
            'events:{onStateChange:function(e){var t=0;try{t=player.getCurrentTime()}catch(x){}'
            'if(e.data==1)send({e:"play",t:t});if(e.data==2)send({e:"pause",t:t});if(e.data==0)send({e:"ended",t:t});}}});'
            'setInterval(function(){try{if(player.getPlayerState()==1)send({e:"time",t:player.getCurrentTime(),d:player.getDuration(),p:true})}catch(x){}},1000);}'
            'window.cmd=function(c){try{if(c=="pause")player.pauseVideo();if(c=="play")player.playVideo();}catch(e){}};'
            '</script><script src="https://www.youtube.com/iframe_api"></script></body></html>';
      case VideoKind.vimeo:
        return '$head<iframe id="f" src="${const HtmlEscape().convert(_src.url!)}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen></iframe>'
            '<script>$send</script><script src="https://player.vimeo.com/api/player.js"></script><script>'
            'var p=new Vimeo.Player(document.getElementById("f"));'
            '${start > 0 ? 'p.setCurrentTime($start).catch(function(){});' : ''}'
            'p.on("timeupdate",function(d){send({e:"time",t:d.seconds,d:d.duration,p:true})});'
            'p.on("play",function(d){send({e:"play",t:d.seconds})});p.on("pause",function(d){send({e:"pause",t:d.seconds})});'
            'p.on("ended",function(d){send({e:"ended",t:d.seconds})});'
            'window.cmd=function(c){try{if(c=="pause")p.pause();if(c=="play")p.play();}catch(e){}};'
            '</script></body></html>';
      case VideoKind.mediadelivery:
        // باني بيتكلم بطريقة player.js (نفس اللي الموقع بيعمله)
        return '$head<iframe id="f" src="${const HtmlEscape().convert(_src.url!)}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen></iframe>'
            '<script>$send'
            'var f=document.getElementById("f"),last=0;'
            'function post(o){try{f.contentWindow.postMessage(JSON.stringify(o),"*")}catch(e){}}'
            'function sub(){["timeupdate","ended","play","pause"].forEach(function(ev){post({context:"player.js",version:"0.0.10",method:"addEventListener",value:ev})});'
            '${start > 0 ? 'post({context:"player.js",version:"0.0.10",method:"setCurrentTime",value:$start});' : ''}}'
            'window.addEventListener("message",function(e){if(e.source!==f.contentWindow)return;var d=e.data;if(typeof d=="string"){try{d=JSON.parse(d)}catch(x){return}}'
            'if(!d||typeof d!="object")return;if(d.event=="ready"){sub();return}'
            'if(d.event=="timeupdate"&&d.value&&typeof d.value.seconds=="number"){last=d.value.seconds;send({e:"time",t:d.value.seconds,d:d.value.duration,p:true})}'
            'else if(d.event=="ended"){send({e:"ended",t:last})}else if(d.event=="play"){send({e:"play",t:last})}else if(d.event=="pause"){send({e:"pause",t:last})}});'
            'f.addEventListener("load",sub);'
            'window.cmd=function(c){post({context:"player.js",version:"0.0.10",method:c=="pause"?"pause":"play"})};'
            '</script></body></html>';
      case VideoKind.drive:
        return '$head<iframe src="https://drive.google.com/file/d/${_src.id}/preview" allow="autoplay; fullscreen" allowfullscreen></iframe></body></html>';
      default:
        return '$head<iframe src="${const HtmlEscape().convert(_src.url ?? '')}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="origin"></iframe></body></html>';
    }
  }

  // ===== شاشة كاملة =====

  Route<void>? _fullscreenRoute;

  void _showFullscreen(Widget child, VoidCallback onHidden) {
    _hideCustomView = onHidden;
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
    SystemChrome.setPreferredOrientations([DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight]);
    final route = PageRouteBuilder<void>(
      opaque: true,
      pageBuilder: (_, _, _) => PopScope(
        canPop: true,
        onPopInvokedWithResult: (didPop, _) {
          if (didPop) _afterFullscreen(callHide: true);
        },
        child: Scaffold(backgroundColor: Colors.black, body: child),
      ),
    );
    _fullscreenRoute = route;
    Navigator.of(context, rootNavigator: true).push(route);
  }

  void _closeFullscreenRoute() {
    final route = _fullscreenRoute;
    if (route != null && route.isActive) {
      Navigator.of(context, rootNavigator: true).removeRoute(route);
    }
    _afterFullscreen(callHide: false);
  }

  void _afterFullscreen({required bool callHide}) {
    _fullscreenRoute = null;
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    SystemChrome.setPreferredOrientations([]);
    final hide = _hideCustomView;
    _hideCustomView = null;
    if (callHide) hide?.call();
  }

  Future<void> _exitFullscreen() async {
    if (_fullscreenRoute != null) {
      final hide = _hideCustomView;
      _closeFullscreenRoute();
      hide?.call();
    }
    if (_nativeFullscreen != null) {
      Navigator.of(context, rootNavigator: true).removeRoute(_nativeFullscreen!);
      _nativeFullscreen = null;
      SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
      SystemChrome.setPreferredOrientations([]);
    }
  }

  Route<void>? _nativeFullscreen;

  void _openNativeFullscreen() {
    final c = _native;
    if (c == null) return;
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
    SystemChrome.setPreferredOrientations([DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight]);
    final route = PageRouteBuilder<void>(
      pageBuilder: (_, _, _) => PopScope(
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) return;
          _nativeFullscreen = null;
          SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
          SystemChrome.setPreferredOrientations([]);
        },
        child: Scaffold(
          backgroundColor: Colors.black,
          body: SafeArea(child: _NativePlayerView(controller: c, fullscreen: true, onFullscreen: () => Navigator.of(context, rootNavigator: true).maybePop())),
        ),
      ),
    );
    _nativeFullscreen = route;
    Navigator.of(context, rootNavigator: true).push(route);
  }

  void _pause() {
    if (_native != null && _native!.value.isPlaying) _native!.pause();
    _web?.runJavaScript('window.cmd&&window.cmd("pause")').catchError((_) {});
  }

  void _play() {
    if (_native != null) _native!.play();
    _web?.runJavaScript('window.cmd&&window.cmd("play")').catchError((_) {});
  }

  @override
  Widget build(BuildContext context) {
    Widget child;
    if (_src.kind == VideoKind.unknown) {
      child = const _PlayerMessage('صيغة اللينك مش مدعومة');
    } else if (_error != null) {
      child = _PlayerMessage(_error!);
    } else if (_web != null) {
      child = WebViewWidget(controller: _web!);
    } else if (_native != null && _native!.value.isInitialized) {
      child = _NativePlayerView(controller: _native!, onFullscreen: _openNativeFullscreen);
    } else {
      child = const Center(child: CircularProgressIndicator(color: Colors.white));
    }
    return ClipRRect(
      borderRadius: BorderRadius.circular(14),
      child: AspectRatio(aspectRatio: 16 / 9, child: ColoredBox(color: Colors.black, child: child)),
    );
  }
}

class _PlayerMessage extends StatelessWidget {
  const _PlayerMessage(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Text(text, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white70)),
        ),
      );
}

/// أزرار المشغل المباشر: تشغيل/إيقاف + شريط الوقت + شاشة كاملة
class _NativePlayerView extends StatefulWidget {
  const _NativePlayerView({required this.controller, required this.onFullscreen, this.fullscreen = false});
  final VideoPlayerController controller;
  final VoidCallback onFullscreen;
  final bool fullscreen;
  @override
  State<_NativePlayerView> createState() => _NativePlayerViewState();
}

class _NativePlayerViewState extends State<_NativePlayerView> {
  bool _controls = true;
  Timer? _hide;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_tick);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_tick);
    _hide?.cancel();
    super.dispose();
  }

  void _tick() {
    if (mounted) setState(() {});
  }

  void _showControls() {
    setState(() => _controls = true);
    _hide?.cancel();
    _hide = Timer(const Duration(seconds: 3), () {
      if (mounted && widget.controller.value.isPlaying) setState(() => _controls = false);
    });
  }

  String _t(Duration d) {
    final h = d.inHours, m = d.inMinutes % 60, s = d.inSeconds % 60;
    final mm = m.toString().padLeft(2, '0'), ss = s.toString().padLeft(2, '0');
    return h > 0 ? '$h:$mm:$ss' : '$mm:$ss';
  }

  @override
  Widget build(BuildContext context) {
    final v = widget.controller.value;
    final total = v.duration.inMilliseconds.toDouble();
    final pos = v.position.inMilliseconds.clamp(0, total > 0 ? total : 0).toDouble();
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: _showControls,
      child: Stack(alignment: Alignment.center, children: [
        Center(child: AspectRatio(aspectRatio: v.aspectRatio > 0 ? v.aspectRatio : 16 / 9, child: VideoPlayer(widget.controller))),
        if (v.isBuffering) const CircularProgressIndicator(color: Colors.white),
        AnimatedOpacity(
          opacity: _controls || !v.isPlaying ? 1 : 0,
          duration: const Duration(milliseconds: 200),
          child: Container(
            color: Colors.black26,
            child: Column(children: [
              const Spacer(),
              IconButton(
                iconSize: 56,
                color: Colors.white,
                icon: Icon(v.isPlaying ? Icons.pause_circle_filled : Icons.play_circle_fill),
                onPressed: () {
                  v.isPlaying ? widget.controller.pause() : widget.controller.play();
                  _showControls();
                },
              ),
              const Spacer(),
              Directionality(
                textDirection: TextDirection.ltr,
                child: Row(children: [
                  const SizedBox(width: 8),
                  Text(_t(v.position), style: const TextStyle(color: Colors.white, fontSize: 12)),
                  Expanded(
                    child: Slider(
                      value: pos,
                      max: total > 0 ? total : 1,
                      activeColor: AppColors.accent,
                      inactiveColor: Colors.white30,
                      onChanged: total > 0 ? (x) => widget.controller.seekTo(Duration(milliseconds: x.round())) : null,
                    ),
                  ),
                  Text(_t(v.duration), style: const TextStyle(color: Colors.white, fontSize: 12)),
                  IconButton(
                    color: Colors.white,
                    icon: Icon(widget.fullscreen ? Icons.fullscreen_exit : Icons.fullscreen),
                    onPressed: widget.onFullscreen,
                  ),
                ]),
              ),
            ]),
          ),
        ),
      ]),
    );
  }
}
