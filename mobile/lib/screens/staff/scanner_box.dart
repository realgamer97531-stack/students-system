import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../theme.dart';

/// كاميرا مسح كود الطالب + خانة لكتابة الكود بإيدك.
/// الكاميرا بتقفل لوحدها لما التاب مش ظاهر (توفير بطارية).
class ScannerBox extends StatefulWidget {
  const ScannerBox({super.key, required this.onCode, required this.enabled});
  final void Function(String code) onCode;

  /// وقت ما فيه طالب بيتراجع، المسح بيقف عشان ميقراش نفس الكود تاني
  final bool enabled;

  /// في الاختبارات مفيش كاميرا
  static bool useCamera = true;

  @override
  State<ScannerBox> createState() => _ScannerBoxState();
}

class _ScannerBoxState extends State<ScannerBox> {
  late final MobileScannerController? _controller =
      ScannerBox.useCamera ? MobileScannerController(formats: const [BarcodeFormat.qrCode], detectionSpeed: DetectionSpeed.normal) : null;
  final _manual = TextEditingController();
  String? _lastCode;
  DateTime _lastAt = DateTime.fromMillisecondsSinceEpoch(0);
  bool _visible = true;
  bool _camera = ScannerBox.useCamera;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final visible = TickerMode.valuesOf(context).enabled;
    if (visible != _visible) {
      _visible = visible;
      if (visible && _camera) {
        _controller?.start().catchError((_) {});
      } else {
        _controller?.stop().catchError((_) {});
      }
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    _manual.dispose();
    super.dispose();
  }

  void _detected(BarcodeCapture capture) {
    if (!widget.enabled) return;
    final code = capture.barcodes.map((b) => b.rawValue).whereType<String>().where((c) => c.trim().isNotEmpty).firstOrNull;
    if (code == null) return;
    // نفس الكود في خلال 3 ثواني = نفس المسحة
    if (code == _lastCode && DateTime.now().difference(_lastAt).inSeconds < 3) return;
    _lastCode = code;
    _lastAt = DateTime.now();
    widget.onCode(code.trim());
  }

  void _submitManual() {
    final code = _manual.text.trim();
    if (code.isEmpty || !widget.enabled) return;
    _manual.clear();
    FocusScope.of(context).unfocus();
    widget.onCode(code);
  }

  /// بعد ما الطالب يخلص نسمح بنفس الكود تاني على طول
  void reset() => _lastCode = null;

  @override
  void didUpdateWidget(covariant ScannerBox old) {
    super.didUpdateWidget(old);
    if (!old.enabled && widget.enabled) {
      _lastAt = DateTime.now(); // مهلة صغيرة قبل ما نقرا نفس الكود تاني
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (_camera && _controller != null)
        ClipRRect(
          borderRadius: BorderRadius.circular(16),
          child: SizedBox(
            height: 230,
            child: Stack(fit: StackFit.expand, children: [
              MobileScanner(
                controller: _controller,
                onDetect: _detected,
                errorBuilder: (context, error) => Container(
                  color: Colors.black,
                  alignment: Alignment.center,
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    error.errorCode == MobileScannerErrorCode.permissionDenied
                        ? 'لازم تسمح للبرنامج يستخدم الكاميرا (من إعدادات الموبايل)'
                        : 'الكاميرا مش شغالة — اكتب الكود بإيدك',
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: Colors.white70),
                  ),
                ),
              ),
              Center(
                child: Container(
                  width: 170,
                  height: 170,
                  decoration: BoxDecoration(border: Border.all(color: widget.enabled ? AppColors.accent : Colors.white38, width: 3), borderRadius: BorderRadius.circular(18)),
                ),
              ),
              if (!widget.enabled) Container(color: Colors.black54),
              PositionedDirectional(
                top: 6,
                end: 6,
                child: IconButton.filledTonal(
                  icon: const Icon(Icons.flashlight_on_outlined),
                  onPressed: () => _controller.toggleTorch().catchError((_) {}),
                ),
              ),
            ]),
          ),
        ),
      const SizedBox(height: 10),
      Row(children: [
        Expanded(
          child: TextField(
            controller: _manual,
            textDirection: TextDirection.ltr,
            textCapitalization: TextCapitalization.characters,
            decoration: const InputDecoration(hintText: 'أو اكتب كود الطالب', isDense: true, prefixIcon: Icon(Icons.keyboard)),
            onSubmitted: (_) => _submitManual(),
          ),
        ),
        const SizedBox(width: 8),
        FilledButton(style: FilledButton.styleFrom(minimumSize: const Size(70, 48)), onPressed: _submitManual, child: const Text('بحث')),
        if (_controller != null)
        IconButton(
          tooltip: _camera ? 'قفل الكاميرا' : 'فتح الكاميرا',
          icon: Icon(_camera ? Icons.videocam_off_outlined : Icons.videocam_outlined),
          onPressed: () {
            setState(() => _camera = !_camera);
            if (_camera) {
              _controller.start().catchError((_) {});
            } else {
              _controller.stop().catchError((_) {});
            }
          },
        ),
      ]),
    ]);
  }
}
