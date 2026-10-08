import 'package:package_info_plus/package_info_plus.dart';

// عناوين السيستم. لو أي عنوان اتغير، غيّره هنا بس.
class AppConfig {
  // السيرفر (الـ API بتاع بوابة الطالب وولي الأمر + سيستم الموظفين)
  static const apiBase = String.fromEnvironment('API_BASE', defaultValue: 'https://students-system-production-6b89.up.railway.app');

  // موقع الطلاب (الصفحات اللي بتتفتح جوه البرنامج: الفيديوهات، الواجب، البوكليتس...)
  static const portalWebBase = String.fromEnvironment('PORTAL_WEB', defaultValue: 'https://shadyelsharkawy.com');

  // سيستم الموظفين (الأسيستانت والأدمن)
  static const staffWebBase = apiBase;

  // مكان نشر تحديثات البرنامج (ملفات APK)
  static const releasesOwner = 'realgamer97531-stack';
  static const releasesRepo = 'studyisfunny-mobile-releases';

  static const supportWhatsapp = '201000733148';

  /// بيعرّف السيرفر إن الطلب جاي من التطبيق ونسخته (عداد مستخدمي التطبيق عند الأدمن الرئيسي)
  static String? _clientId;
  static Future<String> clientId() async {
    if (_clientId != null) return _clientId!;
    try {
      _clientId = 'shadyelsharkawy-android/${(await PackageInfo.fromPlatform()).version}';
    } catch (_) {
      _clientId = 'shadyelsharkawy-android';
    }
    return _clientId!;
  }
}
