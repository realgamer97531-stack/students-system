// رفع الإصدار الجديد على GitHub Releases (اللي البرامج على الأجهزة بتدور فيه على تحديثات).
// بنرفع بنفسنا بدل electron-builder عشان هو بيحاول يعمل الـ release مرتين في نفس اللحظة ويفشل.
// محتاج GH_TOKEN (أو يستخدم الحساب المتسجل في git على الجهاز).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DESKTOP = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
const { owner, repo } = pkg.build.publish[0];
const version = pkg.version;
const tag = `v${version}`;
const dist = path.join(DESKTOP, 'dist');
const setupName = `Studyisfunny-Setup-${version}.exe`;
const files = [`${setupName}.blockmap`, setupName, 'latest.yml']; // latest.yml آخر حاجة: الأجهزة متشوفش التحديث قبل ما ملفاته تكمل

function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' }).toString();
  const match = /^password=(.+)$/m.exec(out);
  if (!match) throw new Error('No GH_TOKEN and no saved GitHub login');
  return match[1].trim();
}

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

const TOKEN = token();

(async () => {
  for (const file of files) {
    if (!fs.existsSync(path.join(dist, file))) throw new Error(`Missing ${file} — run the build first`);
  }
  const latest = fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8');
  if (!latest.includes(`version: ${version}`)) throw new Error('latest.yml does not match package.json version');

  let release = await gh('GET', `/repos/${owner}/${repo}/releases/tags/${tag}`);
  if (release) {
    // إصدار ناقص من محاولة قديمة: نمسح ملفاته ونرفع من جديد
    for (const asset of release.assets) await gh('DELETE', `/repos/${owner}/${repo}/releases/assets/${asset.id}`);
  } else {
    release = await gh('POST', `/repos/${owner}/${repo}/releases`, JSON.stringify({
      tag_name: tag, name: `Studyisfunny ${version}`, body: `Studyisfunny desktop ${version}`, draft: true,
    }), { 'content-type': 'application/json' });
  }
  const uploadBase = release.upload_url.replace(/\{.*$/, '');
  for (const file of files) {
    const data = fs.readFileSync(path.join(dist, file));
    console.log(`uploading ${file} (${(data.length / 1048576).toFixed(1)} MB)...`);
    await gh('POST', `${uploadBase}?name=${encodeURIComponent(file)}`, data, { 'content-type': 'application/octet-stream' });
  }
  const published = await gh('PATCH', `/repos/${owner}/${repo}/releases/${release.id}`, JSON.stringify({ draft: false, tag_name: tag, make_latest: 'true' }), { 'content-type': 'application/json' });
  console.log(`published ${published.html_url}`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
