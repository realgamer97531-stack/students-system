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
}
