// Deploys the student portal (public/) to Hostinger through the Hostinger API.
//
// Compares every git-tracked file in public/ with the live copy on the site and
// uploads only the ones that are missing or different. Nothing on Hostinger is
// ever deleted, and files that are not in git are never touched.
//
//   HOSTINGER_API_TOKEN=... node scripts/deploy-portal.js            (dry run)
//   HOSTINGER_API_TOKEN=... node scripts/deploy-portal.js --upload   (really upload)
//   ... --upload --also=quiz_upload_key.php                          (also send a public/ file that is NOT in git, e.g. a secret)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DOMAIN = process.env.HOSTINGER_DOMAIN || 'shadyelsharkawy.com';
const API = 'https://developers.hostinger.com';
const ROOT = path.join(__dirname, '..');
// Live copy was never compared with the repo (PHP runs instead of downloading), so leave it alone.
const EXCLUDE = new Set(['get_avatars.php']);

const token = process.env.HOSTINGER_API_TOKEN;
const upload = process.argv.includes('--upload');
const also = (process.argv.find((a) => a.startsWith('--also=')) || '').slice('--also='.length).split(',').filter(Boolean);

// Retries network errors (timeouts, resets) a few times; HTTP errors are returned as-is.
async function request(url, options, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

async function api(method, url, body) {
  const res = await request(API + url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function liveCopy(rel) {
  const res = await request(`https://${DOMAIN}/${rel}?deploy-check=${Date.now()}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${rel} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Hostinger's CDN re-compresses images, so the served bytes never match git. For images,
// compare the file size on the server (Hostinger file API) instead of the downloaded copy.
// PHP files run instead of downloading, so they are compared by size too.
const IMAGE = /.(png|jpe?g|gif|webp|php)$/i;
const listings = new Map();

async function serverSize(site, rel) {
  const dir = path.posix.dirname(rel);
  if (!listings.has(dir)) {
    // The API returns 1000 items per page; the root folder has thousands (homework uploads), so page with ?offset=
    const items = [];
    for (;;) {
      const params = new URLSearchParams({ ...(dir === '.' ? {} : { directory: dir }), ...(items.length ? { offset: String(items.length) } : {}) });
      const query = params.toString() ? `?${params}` : '';
      const res = await api('GET', `/api/hosting/v1/accounts/${site.username}/domains/${DOMAIN}/files${query}`);
      const page = res.items || [];
      items.push(...page);
      if (!page.length || items.length >= (res.total_items || 0)) break;
    }
    listings.set(dir, new Map(items.filter((i) => i.type === 'file').map((i) => [i.name, i.size_bytes])));
  }
  return listings.get(dir).get(path.posix.basename(rel));
}

// Returns 'same', 'changed' or 'new'.
async function compare(site, rel, local) {
  if (IMAGE.test(rel)) {
    const size = await serverSize(site, rel);
    if (size === undefined) return 'new';
    return size === local.length ? 'same' : 'changed';
  }
  const live = await liveCopy(rel);
  if (!live) return 'new';
  return live.equals(local) ? 'same' : 'changed';
}

async function uploadFile(target, rel, data) {
  const url = `${target.url.replace(/\/$/, '')}/${rel.split('/').map(encodeURIComponent).join('/')}?override=true`;
  const headers = { 'X-Auth': target.auth_key, 'X-Auth-Rest': target.rest_auth_key, 'Tus-Resumable': '1.0.0' };

  const create = await request(url, {
    method: 'POST',
    headers: { ...headers, 'Upload-Length': String(data.length), 'Upload-Offset': '0' }
  });
  if (create.status !== 201) throw new Error(`create ${rel} -> HTTP ${create.status}: ${(await create.text()).slice(0, 300)}`);

  const send = await request(url, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' },
    body: data
  });
  const offset = send.headers.get('upload-offset');
  if (send.status !== 204 || offset !== String(data.length)) {
    throw new Error(`upload ${rel} -> HTTP ${send.status}, offset ${offset}/${data.length}: ${(await send.text()).slice(0, 300)}`);
  }
}

async function main() {
  if (!token) throw new Error('HOSTINGER_API_TOKEN is not set');

  const sites = await api('GET', '/api/hosting/v1/websites');
  const site = (sites.data || []).find((s) => s.domain === DOMAIN);
  if (!site) throw new Error(`${DOMAIN} not found on this Hostinger account`);

  const files = execSync('git ls-files public', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean)
    .map((f) => f.replace(/^public\//, ''))
    .filter((f) => !EXCLUDE.has(f))
    .concat(also.filter((f) => fs.existsSync(path.join(ROOT, 'public', f))));
  const missing = also.filter((f) => !fs.existsSync(path.join(ROOT, 'public', f)));
  if (missing.length) throw new Error(`--also file(s) not found in public/: ${missing.join(', ')}`);

  const changed = [];
  for (const rel of files) {
    const local = fs.readFileSync(path.join(ROOT, 'public', rel));
    const status = await compare(site, rel, local);
    if (status !== 'same') changed.push({ rel, data: local, status });
  }

  console.log(`${files.length} portal files checked, ${changed.length} to upload to ${DOMAIN}:`);
  for (const f of changed) console.log(`  ${f.status.padEnd(7)} ${f.rel}`);
  if (!changed.length) return;
  if (!upload) {
    console.log('\nDry run, nothing uploaded. Run again with --upload to send these files.');
    return;
  }

  const target = await api('POST', '/api/hosting/v1/files/upload-urls', { username: site.username, domain: DOMAIN });
  for (const f of changed) {
    await uploadFile(target, f.rel, f.data);
    console.log(`  uploaded ${f.rel}`);
  }

  // Confirm the site now serves exactly what is in git.
  listings.clear();
  const wrong = [];
  for (const f of changed) {
    if ((await compare(site, f.rel, f.data)) !== 'same') wrong.push(f.rel);
  }
  if (wrong.length) throw new Error(`uploaded but live copy still differs: ${wrong.join(', ')}`);
  console.log(`\nDone. ${changed.length} file(s) live on ${DOMAIN}.`);
}

main().catch((err) => {
  console.error(`Deploy failed: ${err.message}${err.cause ? ` (${err.cause.code || err.cause.message})` : ''}`);
  process.exit(1);
});
