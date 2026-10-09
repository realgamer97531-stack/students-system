import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../../services/net.dart';
import '../../services/session_store.dart';
import '../../services/staff_api.dart';
import '../../services/staff_store.dart';
import '../../theme.dart';

/// QR الطالب بنفس تصميم السيستم (بيتجاب من السيرفر مرة وبيفضل محفوظ طول ما البرنامج مفتوح)
class StudentQr extends StatefulWidget {
  const StudentQr({super.key, required this.studentId, required this.user, this.size = 200});
  final int studentId;
  final StaffUser user;
  final double size;

  static final Map<int, String> _cache = {};

  @override
  State<StudentQr> createState() => _StudentQrState();
}

class _StudentQrState extends State<StudentQr> {
  String? _svg;
  String? _error;

  @override
  void initState() {
    super.initState();
    _svg = StudentQr._cache[widget.studentId];
    if (_svg == null) _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final svg = await StaffApi.studentQrSvg(widget.studentId, userId: widget.user.id);
      StudentQr._cache[widget.studentId] = svg;
      Connection.report(true);
      if (mounted) setState(() => _svg = svg);
    } on DeviceNotAuthorized catch (e) {
      StaffStore.deviceRevoked.value = true;
      if (mounted) setState(() => _error = '$e');
    } on ApiException catch (e) {
      if (e.offline) Connection.report(false);
      if (mounted) setState(() => _error = e.offline ? 'الـ QR محتاج نت' : e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final size = widget.size;
    if (_svg != null) return SizedBox(width: size, height: size, child: SvgPicture.string(_svg!));
    return SizedBox(
      width: size,
      height: size,
      child: Center(
        child: _error == null
            ? const CircularProgressIndicator()
            : Column(mainAxisSize: MainAxisSize.min, children: [
                Text(_error!, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.muted)),
                TextButton.icon(onPressed: _load, icon: const Icon(Icons.refresh), label: const Text('حاول تاني')),
              ]),
      ),
    );
  }
}
