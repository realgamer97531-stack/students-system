import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

/// صفحة من الموقع جوه البرنامج.
/// - صفحات الطالب/ولي الأمر: بنحط الـ token في localStorage قبل ما الصفحة تفتح، فبتفتح والمستخدم داخل على طول.
/// - سيستم الموظفين: بيفتح عادي والدخول بيتحفظ (cookies).
/// الكاميرا (مسح QR) ورفع الصور والفيديو بشاشة كاملة شغالين.
class WebScreen extends StatefulWidget {
  const WebScreen({
    super.key,
    required this.title,
    required this.url,
    this.portalLogin,
    this.onLoggedOut,
    this.showAppBar = true,
    this.extraActions = const [],
  });

  final String title;
  final String url;

  /// بيانات دخول البوابة اللي بتتحط في localStorage قبل الفتح (للطالب وولي الأمر)
  final Map<String, String>? portalLogin;

  /// لما المستخدم يعمل "خروج" من جوه الموقع
  final VoidCallback? onLoggedOut;
  final bool showAppBar;
  final List<Widget> extraActions;

  @override
  State<WebScreen> createState() => WebScreenState();
}

class WebScreenState extends State<WebScreen> {
  late final WebViewController _controller;
  int _progress = 0;
  String? _error;
  Widget? _fullscreen;

  @override
  void initState() {
    super.initState();
    _controller = WebViewController(onPermissionRequest: _onPermission)
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFFF4F5FC))
      ..setNavigationDelegate(NavigationDelegate(
        onProgress: (p) => mounted ? setState(() => _progress = p) : null,
        onPageStarted: (_) => mounted ? setState(() => _error = null) : null,
        onWebResourceError: (error) {
          if (error.isForMainFrame == true && mounted) {
            setState(() => _error = 'مش قادر يفتح الصفحة — اتأكد من النت');
          }
        },
        onNavigationRequest: _onNavigation,
      ));

    final platform = _controller.platform;
    if (platform is AndroidWebViewController) {
      platform.setMediaPlaybackRequiresUserGesture(false);
      platform.setOnShowFileSelector(_pickFiles);
      platform.setCustomWidgetCallbacks(
        onShowCustomWidget: (widget, onHidden) {
          SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
          setState(() => _fullscreen = widget);
        },
        onHideCustomWidget: () {
          SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
          setState(() => _fullscreen = null);
        },
      );
    }
    _load();
  }

  void _load() {
    final login = widget.portalLogin;
    if (login == null) {
      _controller.loadRequest(Uri.parse(widget.url));
      return;
    }
    // صفحة صغيرة على نفس الدومين: تحط بيانات الدخول في localStorage وتحوّل للصفحة المطلوبة
    final uri = Uri.parse(widget.url);
    final setters = login.entries.map((e) => 'localStorage.setItem(${jsonEncode(e.key)}, ${jsonEncode(e.value)});').join();
    final html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="background:#F4F5FC">'
        '<script>$setters location.replace(${jsonEncode(widget.url)});</script></body></html>';
    _controller.loadHtmlString(html, baseUrl: '${uri.scheme}://${uri.host}/');
  }

  void reload() => _controller.reload();

  Future<NavigationDecision> _onNavigation(NavigationRequest request) async {
    final uri = Uri.parse(request.url);
    // لينكات واتساب/تليفون/خرائط بتفتح في برامجها
    if (!['http', 'https', 'about', 'data'].contains(uri.scheme) || uri.host.contains('wa.me') || uri.host.contains('whatsapp')) {
      launchUrl(uri, mode: LaunchMode.externalApplication);
      return NavigationDecision.prevent;
    }
    // المستخدم عمل خروج من جوه الموقع (رجّعه لصفحة الدخول)
    if (widget.onLoggedOut != null && widget.portalLogin != null) {
      final path = uri.path;
      if (path == '/' || path.endsWith('/index.html') || path.endsWith('/login')) {
        widget.onLoggedOut!();
        return NavigationDecision.prevent;
      }
    }
    return NavigationDecision.navigate;
  }

  Future<void> _onPermission(WebViewPermissionRequest request) async {
    if (request.types.contains(WebViewPermissionResourceType.camera)) {
      final status = await Permission.camera.request();
      if (status.isGranted) {
        await request.grant();
      } else {
        await request.deny();
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('لازم تسمح للبرنامج يستخدم الكاميرا عشان يمسح الكود'),
          ));
        }
      }
      return;
    }
    await request.deny();
  }

  Future<List<String>> _pickFiles(FileSelectorParams params) async {
    final wantsImage = params.acceptTypes.any((t) => t.startsWith('image'));
    final files = await FilePicker.pickFiles(type: wantsImage ? FileType.image : FileType.any);
    return files.map((f) => f.uri.toString()).toList();
  }

  Future<bool> _handleBack() async {
    if (_fullscreen != null) return false;
    if (await _controller.canGoBack()) {
      await _controller.goBack();
      return false;
    }
    return true;
  }

  @override
  Widget build(BuildContext context) {
    if (_fullscreen != null) {
      return PopScope(
        canPop: false,
        child: Scaffold(backgroundColor: Colors.black, body: _fullscreen!),
      );
    }
    final body = Stack(children: [
      WebViewWidget(controller: _controller),
      if (_progress < 100) LinearProgressIndicator(value: _progress / 100, minHeight: 3),
      if (_error != null)
        Positioned.fill(
          child: Container(
            color: const Color(0xFFF4F5FC),
            alignment: Alignment.center,
            padding: const EdgeInsets.all(32),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              const Icon(Icons.wifi_off_rounded, size: 56, color: Color(0xFF6B7280)),
              const SizedBox(height: 16),
              Text(_error!, textAlign: TextAlign.center, style: const TextStyle(fontSize: 16)),
              const SizedBox(height: 20),
              FilledButton.icon(onPressed: () => _controller.reload(), icon: const Icon(Icons.refresh), label: const Text('حاول تاني')),
            ]),
          ),
        ),
    ]);
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        if (!await _handleBack() || !context.mounted) return;
        if (Navigator.of(context).canPop()) {
          Navigator.of(context).pop();
        } else {
          SystemNavigator.pop();
        }
      },
      child: widget.showAppBar
          ? Scaffold(
              appBar: AppBar(
                title: Text(widget.title),
                actions: [
                  ...widget.extraActions,
                  IconButton(onPressed: () => _controller.reload(), icon: const Icon(Icons.refresh), tooltip: 'إعادة تحميل'),
                ],
              ),
              body: body,
            )
          : body,
    );
  }
}
