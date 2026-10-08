import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import 'config.dart';
import 'updater.dart';

// تطبيق الكول سنتر (أندرويد، للموبايل بس): بيفتح سيستم الكول سنتر نفسه جوه التطبيق،
// وأرقام التليفون بتفتح الاتصال على طول، وروابط واتساب بتفتح واتساب.
// أي تعديل في السيستم بيظهر في التطبيق فورًا من غير تحديث.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
  runApp(const CallCenterApp());
}

const navy = Color(0xFF081E3E);

class CallCenterApp extends StatelessWidget {
  const CallCenterApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: AppConfig.appName,
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: navy, useMaterial3: true, fontFamily: 'sans-serif'),
      builder: (context, child) => Directionality(textDirection: TextDirection.rtl, child: child!),
      home: const CallCenterScreen(),
    );
  }
}

class CallCenterScreen extends StatefulWidget {
  const CallCenterScreen({super.key});

  @override
  State<CallCenterScreen> createState() => _CallCenterScreenState();
}

class _CallCenterScreenState extends State<CallCenterScreen> with WidgetsBindingObserver {
  late final WebViewController _controller;
  final Uri _home = Uri.parse(AppConfig.callCenterUrl);
  int _progress = 0;
  String? _error;
  DateTime _lastUpdateCheck = DateTime.fromMillisecondsSinceEpoch(0);

  // تصدير الإكسيل في الموقع بيعمل ملف جوه المتصفح (blob) — ده مش بيتحمل جوه التطبيق، فبنقول للمستخدم
  static const _downloadHook = '''
(function () {
  if (window.__ccAppHooked) return;
  window.__ccAppHooked = true;
  var originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && this.href && this.href.indexOf('blob:') === 0) {
      CCApp.postMessage(JSON.stringify({ type: 'download', name: this.download }));
      return;
    }
    return originalClick.apply(this, arguments);
  };
})();
''';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFFF4F5FC))
      ..addJavaScriptChannel('CCApp', onMessageReceived: _onAppMessage)
      ..setNavigationDelegate(NavigationDelegate(
        onProgress: (p) => mounted ? setState(() => _progress = p) : null,
        onPageStarted: (_) => mounted ? setState(() => _error = null) : null,
        onPageFinished: (_) => _controller.runJavaScript(_downloadHook).catchError((_) {}),
        onWebResourceError: (error) {
          if (error.isForMainFrame == true && mounted) setState(() => _error = 'مش قادر يفتح الكول سنتر — اتأكد من النت');
        },
        onNavigationRequest: _onNavigation,
      ))
      ..setOnJavaScriptAlertDialog((request) => _alert(request.message))
      ..setOnJavaScriptConfirmDialog((request) => _confirm(request.message))
      ..setOnJavaScriptTextInputDialog((request) => _prompt(request.message, request.defaultText));

    final platform = _controller.platform;
    if (platform is AndroidWebViewController) {
      platform.setOnShowFileSelector(_pickFiles);
    }
    _start();
  }

  Future<void> _start() async {
    // الموقع يقدر يعرف إنه جوه التطبيق من الـ User-Agent
    try {
      final ua = await _controller.getUserAgent();
      final version = (await PackageInfo.fromPlatform()).version;
      await _controller.setUserAgent('${ua ?? ''} SECallCenterApp/$version');
    } catch (_) {}
    await _controller.loadRequest(_home);
    WidgetsBinding.instance.addPostFrameCallback((_) => _checkForUpdate());
  }

  void _checkForUpdate() {
    if (!mounted || DateTime.now().difference(_lastUpdateCheck) < const Duration(hours: 6)) return;
    _lastUpdateCheck = DateTime.now();
    Updater.checkAndPrompt(context, silent: true);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _checkForUpdate();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  Future<NavigationDecision> _onNavigation(NavigationRequest request) async {
    final uri = Uri.tryParse(request.url);
    if (uri == null) return NavigationDecision.prevent;
    // تليفون / واتساب / أي برنامج تاني: بيفتح في برنامجه
    if (!['http', 'https', 'about', 'data', 'blob'].contains(uri.scheme) ||
        uri.host == 'wa.me' || uri.host.endsWith('whatsapp.com')) {
      _openExternal(uri);
      return NavigationDecision.prevent;
    }
    // أي موقع غير الكول سنتر بيفتح في المتصفح
    if ((uri.scheme == 'http' || uri.scheme == 'https') && uri.host != _home.host) {
      _openExternal(uri);
      return NavigationDecision.prevent;
    }
    return NavigationDecision.navigate;
  }

  Future<void> _openExternal(Uri uri) async {
    var target = uri;
    // tel: لازم يبقى أرقام بس عشان الاتصال يفتح صح
    if (uri.scheme == 'tel') target = Uri(scheme: 'tel', path: uri.path.replaceAll(RegExp(r'[^0-9+]'), ''));
    final opened = await launchUrl(target, mode: LaunchMode.externalApplication).catchError((_) => false);
    if (!opened && mounted) {
      final what = uri.scheme == 'tel' ? 'الاتصال' : (uri.host.contains('wa') ? 'واتساب' : 'اللينك');
      _snack('مش قادر يفتح $what على الموبايل ده');
    }
  }

  void _onAppMessage(JavaScriptMessage message) {
    try {
      final data = jsonDecode(message.message) as Map<String, dynamic>;
      if (data['type'] == 'download') {
        _snack('تصدير ملف الإكسيل بيشتغل من الكمبيوتر بس — افتح الكول سنتر من المتصفح على الكمبيوتر');
      }
    } catch (_) {}
  }

  Future<List<String>> _pickFiles(FileSelectorParams params) async {
    final files = await FilePicker.pickFiles(type: FileType.any);
    return files.map((f) => f.uri.toString()).toList();
  }

  Future<void> _alert(String message) async {
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        content: Text(message),
        actions: [FilledButton(onPressed: () => Navigator.pop(context), child: const Text('تمام'))],
      ),
    );
  }

  Future<bool> _confirm(String message) async {
    if (!mounted) return false;
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        content: Text(message),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('إلغاء')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('موافق')),
        ],
      ),
    );
    return ok == true;
  }

  Future<String> _prompt(String message, String? defaultText) async {
    if (!mounted) return '';
    final controller = TextEditingController(text: defaultText ?? '');
    final value = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(message),
          const SizedBox(height: 12),
          TextField(controller: controller, autofocus: true),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('إلغاء')),
          FilledButton(onPressed: () => Navigator.pop(context, controller.text), child: const Text('موافق')),
        ],
      ),
    );
    controller.dispose();
    return value ?? '';
  }

  void _snack(String text) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _reload() async {
    setState(() => _error = null);
    final current = await _controller.currentUrl();
    await _controller.loadRequest(current != null && current.startsWith('http') ? Uri.parse(current) : _home);
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        if (await _controller.canGoBack()) {
          await _controller.goBack();
        } else {
          SystemNavigator.pop();
        }
      },
      child: Scaffold(
        backgroundColor: const Color(0xFFF4F5FC),
        body: SafeArea(
          child: Stack(children: [
            WebViewWidget(controller: _controller),
            if (_progress < 100 && _error == null)
              LinearProgressIndicator(value: _progress / 100, minHeight: 3, color: navy, backgroundColor: Colors.transparent),
            if (_error != null) _ErrorView(message: _error!, onRetry: _reload),
          ]),
        ),
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: const Color(0xFFF4F5FC),
      alignment: Alignment.center,
      padding: const EdgeInsets.all(24),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        ClipRRect(borderRadius: BorderRadius.circular(20), child: Image.asset('assets/images/icon.png', width: 84, height: 84)),
        const SizedBox(height: 20),
        Text(message, textAlign: TextAlign.center, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
        const SizedBox(height: 20),
        FilledButton.icon(onPressed: onRetry, icon: const Icon(Icons.refresh), label: const Text('حاول تاني')),
      ]),
    );
  }
}
