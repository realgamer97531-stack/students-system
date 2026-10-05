// الصفحات بتجيب Bootstrap والخطوط والأيقونات من النت (CDN). عشان تفضل شكلها مظبوط أوفلاين:
//   1) الملفات دي متخزنة جوه البرنامج نفسه (resources/cdn)
//   2) أي ملف CDN تاني بيتحمل وإحنا أونلاين بيتحفظ على الجهاز ويستخدم لما النت يقطع
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { net, protocol } = require('electron');

const CDN_HOSTS = new Set([
  'cdn.jsdelivr.net', 'unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com',
  'code.jquery.com', 'cdnjs.cloudflare.com', 'stackpath.bootstrapcdn.com',
]);

function cacheName(url) {
  return crypto.createHash('sha1').update(url).digest('hex');
}

function install({ bundledDir, runtimeDir }) {
  let bundledIndex = {};
  try {
    bundledIndex = JSON.parse(fs.readFileSync(path.join(bundledDir, 'index.json'), 'utf8'));
  } catch (e) { /* no bundled cache */ }
  fs.mkdirSync(runtimeDir, { recursive: true });

  const fromDisk = (file, type) => new Response(fs.readFileSync(file), {
    status: 200,
    headers: { 'content-type': type || 'application/octet-stream', 'access-control-allow-origin': '*', 'cache-control': 'max-age=31536000' },
  });

  protocol.handle('https', async (request) => {
    const url = new URL(request.url);
    if (request.method !== 'GET' || !CDN_HOSTS.has(url.hostname)) {
      return net.fetch(request, { bypassCustomProtocolHandlers: true });
    }
    url.hash = '';
    const key = url.toString();

    const bundled = bundledIndex[key];
    if (bundled && fs.existsSync(path.join(bundledDir, bundled.file))) return fromDisk(path.join(bundledDir, bundled.file), bundled.type);

    const name = cacheName(key);
    const cachedFile = path.join(runtimeDir, name);
    const metaFile = `${cachedFile}.type`;
    try {
      const response = await net.fetch(request, { bypassCustomProtocolHandlers: true });
      if (response.ok) {
        const body = Buffer.from(await response.arrayBuffer());
        const type = response.headers.get('content-type') || 'application/octet-stream';
        fs.writeFileSync(cachedFile, body);
        fs.writeFileSync(metaFile, type);
        return new Response(body, { status: 200, headers: { 'content-type': type, 'access-control-allow-origin': '*' } });
      }
      if (fs.existsSync(cachedFile)) return fromDisk(cachedFile, fs.readFileSync(metaFile, 'utf8'));
      return response;
    } catch (error) {
      if (fs.existsSync(cachedFile)) return fromDisk(cachedFile, fs.existsSync(metaFile) ? fs.readFileSync(metaFile, 'utf8') : undefined);
      return new Response('offline', { status: 504 });
    }
  });
}

module.exports = { install };
