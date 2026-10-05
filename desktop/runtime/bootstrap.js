// نقطة تشغيل السيستم جوه برنامج الديسكتوب (بيشغلها Electron كـ process منفصل).
// 1) تجهيز قاعدة البيانات المحلية + طابور الرفع
// 2) أول مرة: تنزيل نسخة كاملة من السيرفر (لازم إنترنت أول مرة بس)
// 3) تشغيل server.js العادي على الجهاز (DESKTOP_MODE=1)
// 4) تشغيل المزامنة: تنزيل كل 5 دقايق + رفع فوري لما يبقى فيه نت
process.env.DESKTOP_MODE = '1';
process.env.NODE_ENV = 'production';
process.env.LISTEN_HOST = process.env.LISTEN_HOST || '127.0.0.1';
process.env.TZ = process.env.TZ || 'Africa/Cairo';

const http = require('http');

const parentPort = process.parentPort || null;
function report(message) {
  if (parentPort) parentPort.postMessage(message);
  else console.log('[desktop]', JSON.stringify(message));
}

// المهام المجدولة (النسخ الاحتياطي اليومي + فتح الحصص تلقائيًا بالجدول) بتشتغل على السيرفر الأونلاين بس،
// والنتيجة بتنزل للجهاز مع المزامنة. لو اشتغلت على كل جهاز كمان هتتكرر.
const cron = require('node-cron');
cron.schedule = () => ({ start() {}, stop() {}, destroy() {} });

const engine = require('./engine');

function waitForServer(port) {
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/login', timeout: 2000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => setTimeout(attempt, 300));
      req.on('timeout', () => { req.destroy(); setTimeout(attempt, 300); });
    };
    attempt();
  });
}

async function main() {
  report({ type: 'progress', message: 'بيجهز قاعدة البيانات على الجهاز...' });
  await engine.init();
  engine.onChange(() => {
    engine.status().then(status => report({ type: 'status', status })).catch(() => {});
  });

  if (!engine.state.initialDataReady) {
    // أول تشغيل: لازم ننزل البيانات كلها قبل ما السيستم يفتح
    for (;;) {
      report({ type: 'progress', message: 'أول تشغيل: بينزل كل البيانات من السيرفر... (محتاج إنترنت المرة دي بس)' });
      try {
        await engine.ping();
        await engine.pull({ full: true });
        break;
      } catch (error) {
        report({ type: 'progress', error: true, message: `مش قادر ينزل البيانات: ${error.message} — هيحاول تاني بعد 10 ثواني` });
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
  }

  report({ type: 'progress', message: 'بيشغل السيستم...' });
  require('../../server.js');
  await waitForServer(Number(process.env.PORT));
  engine.start();
  report({ type: 'ready', port: Number(process.env.PORT) });
}

main().catch((error) => {
  console.error(error);
  report({ type: 'fatal', message: error.message });
  setTimeout(() => process.exit(1), 500);
});
