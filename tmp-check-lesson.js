const http = require('http');
const url = 'http://127.0.0.1:3000/lessons.html';
http.get(url, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    console.log('status=' + res.statusCode);
    console.log('has-mediadelivery=' + data.includes('mediadelivery'));
    console.log('has-iframe-render=' + data.includes("source.type === 'mediadelivery'"));
  });
}).on('error', (err) => {
  console.error(err.message);
  process.exit(1);
});
