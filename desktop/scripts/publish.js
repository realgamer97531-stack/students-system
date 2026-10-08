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
  // النت هنا بيقطع ساعات: بنحاول كذا مرة قبل ما نستسلم
  let response;
  for (let attempt = 1; ; attempt++) {
    try {
      response = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json', ...headers },
        body,
      });
      break;
    } catch (error) {
      if (attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
    }
  }
  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok) throw new Error(`${method} ${url} → ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

const TOKEN = token();

// الرفع بـ curl: fetch بتاع Node بيقطع الملفات الكبيرة لما الرفع ياخد أكتر من 5 دقايق. ولو النت قطع بنحاول تاني،
// وبنمسح أي ملف ناقص بنفس الاسم سابته المحاولة اللي فشلت.
async function uploadWithRetry(release, url, name, file, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    try {
      execFileSync('curl', ['--fail-with-body', '--silent', '--show-error', '-X', 'POST',
        '-H', `authorization: Bearer ${TOKEN}`, '-H', 'accept: application/vnd.github+json', '-H', 'content-type: application/octet-stream',
        '--data-binary', `@${file}`, url], { stdio: ['ignore', 'ignore', 'inherit'] });
      return;
    } catch (error) {
      if (i === attempts) throw new Error(`upload of ${name} failed after ${attempts} tries`);
      console.log(`upload try ${i} failed — retrying...`);
      const assets = (await gh('GET', `/repos/${owner}/${repo}/releases/${release.id}/assets`)) || [];
      for (const asset of assets.filter((a) => a.name === name)) await gh('DELETE', `/repos/${owner}/${repo}/releases/assets/${asset.id}`);
    }
  }
}

(async () => {
  for (const file of files) {
    if (!fs.existsSync(path.join(dist, file))) throw new Error(`Missing ${file} — run the build first`);
  }
  const latest = fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8');
  if (!latest.includes(`version: ${version}`)) throw new Error('latest.yml does not match package.json version');

  let release = await gh('GET', `/repos/${owner}/${repo}/releases/tags/${tag}`);
  if (!release) {
    // الـ draft مالوش tag لسه، فبندور عليه في القايمة بدل ما نعمل واحد تاني
    const list = (await gh('GET', `/repos/${owner}/${repo}/releases?per_page=30`)) || [];
    release = list.find((r) => r.draft && r.tag_name === tag) || null;
  }
  if (release) {
    // إصدار ناقص من محاولة قديمة: نمسح ملفاته ونرفع من جديد
    for (const asset of release.assets) await gh('DELETE', `/repos/${owner}/${repo}/releases/assets/${asset.id}`);
  } else {
    release = await gh('POST', `/repos/${owner}/${repo}/releases`, JSON.stringify({
      tag_name: tag, name: `Shady Elsharkawy ${version}`, body: `Shady Elsharkawy desktop ${version}`, draft: true,
    }), { 'content-type': 'application/json' });
  }
  const uploadBase = release.upload_url.replace(/\{.*$/, '');
  for (const file of files) {
    console.log(`uploading ${file} (${(fs.statSync(path.join(dist, file)).size / 1048576).toFixed(1)} MB)...`);
    await uploadWithRetry(release, `${uploadBase}?name=${encodeURIComponent(file)}`, file, path.join(dist, file));
  }
  const published = await gh('PATCH', `/repos/${owner}/${repo}/releases/${release.id}`, JSON.stringify({ draft: false, tag_name: tag, make_latest: 'true' }), { 'content-type': 'application/json' });
  console.log(`published ${published.html_url}`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
