// نشر إصدار جديد من تطبيق الكول سنتر (التطبيق بيدور على التحديثات لوحده كل ما يتفتح):
//   node tool/release.js          يزود رقم الإصدار، يبني APK موقّع، ويرفعه على GitHub Releases
//   node tool/release.js --no-bump  نفس الحاجة من غير ما يزود الرقم (لو الرفع اتقطع)
// محتاج GH_TOKEN، أو بيستخدم حساب GitHub المتسجل في git على الجهاز.
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MOBILE = path.resolve(__dirname, '..');
const OWNER = 'realgamer97531-stack';
const REPO = 'callcenter-mobile-releases';

function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' }).toString();
  const match = /^password=(.+)$/m.exec(out);
  if (!match) throw new Error('No GH_TOKEN and no saved GitHub login');
  return match[1].trim();
}
const TOKEN = token();

async function gh(method, url, body, headers = {}) {
  const response = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json', ...headers },
    body,
  });
  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok) throw new Error(`${method} ${url} → ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

function bumpVersion() {
  const file = path.join(MOBILE, 'pubspec.yaml');
  const text = fs.readFileSync(file, 'utf8');
  const match = /^version:\s*(\d+)\.(\d+)\.(\d+)\+(\d+)/m.exec(text);
  if (!match) throw new Error('version line not found in pubspec.yaml');
  const [, major, minor, patch, build] = match.map(Number);
  const next = `${major}.${minor}.${patch + 1}+${build + 1}`;
  fs.writeFileSync(file, text.replace(match[0], `version: ${next}`));
  return next.split('+')[0];
}

function currentVersion() {
  const text = fs.readFileSync(path.join(MOBILE, 'pubspec.yaml'), 'utf8');
  return /^version:\s*(\d+\.\d+\.\d+)/m.exec(text)[1];
}

(async () => {
  const version = process.argv.includes('--no-bump') ? currentVersion() : bumpVersion();
  console.log(`building ${version}...`);
  // C: شبه مليان: لازم كاشات Gradle و pub تكون على D:\dev، وإلا Gradle بينزّل كل حاجة من الأول على C: وبيعلق
  const buildEnv = { ...process.env };
  if (!buildEnv.GRADLE_USER_HOME && fs.existsSync('D:/dev/gradle')) buildEnv.GRADLE_USER_HOME = 'D:\\dev\\gradle';
  if (!buildEnv.PUB_CACHE && fs.existsSync('D:/dev/pub-cache')) buildEnv.PUB_CACHE = 'D:\\dev\\pub-cache';
  console.log(`GRADLE_USER_HOME=${buildEnv.GRADLE_USER_HOME || '(default)'}  PUB_CACHE=${buildEnv.PUB_CACHE || '(default)'}`);
  execSync('flutter build apk --release', { cwd: MOBILE, stdio: 'inherit', env: buildEnv });
  const apk = path.join(MOBILE, 'build', 'app', 'outputs', 'flutter-apk', 'app-release.apk');
  const name = `SE-CallCenter-${version}.apk`;

  const tag = `v${version}`;
  let release = await gh('GET', `/repos/${OWNER}/${REPO}/releases/tags/${tag}`);
  if (release) {
    for (const asset of release.assets) await gh('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${asset.id}`);
  } else {
    release = await gh('POST', `/repos/${OWNER}/${REPO}/releases`, JSON.stringify({
      tag_name: tag, name: `Call Center ${version}`, body: `Shady Elsharkawy call center app ${version}`, draft: true,
    }), { 'content-type': 'application/json' });
  }
  const data = fs.readFileSync(apk);
  console.log(`uploading ${name} (${(data.length / 1048576).toFixed(1)} MB)...`);
  await gh('POST', `${release.upload_url.replace(/\{.*$/, '')}?name=${encodeURIComponent(name)}`, data, {
    'content-type': 'application/vnd.android.package-archive',
  });
  const published = await gh('PATCH', `/repos/${OWNER}/${REPO}/releases/${release.id}`, JSON.stringify({ draft: false, tag_name: tag, make_latest: 'true' }), {
    'content-type': 'application/json',
  });
  console.log(`published ${published.html_url}`);
  console.log(`APK: ${apk}`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
