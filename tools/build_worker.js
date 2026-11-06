/* Build the Cloudflare Worker for this project: one single-file HTML payload. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'));
const b64 = html.toString('base64');

const worker = `// Booklet printer Worker: serves the single-file saddle-stitch booklet app.
const B64 = "${b64}";
function decode(b64){
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
const HTML_BYTES = decode(B64);
const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "public, max-age=300",
  "x-content-type-options": "nosniff"
};
export default {
  async fetch(request){
    const url = new URL(request.url);
    if (url.pathname === "/healthz"){
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }
    return new Response(HTML_BYTES, { headers: HEADERS, status: 200 });
  }
};
`;

const file = path.join(root, 'worker-booklet.js');
fs.writeFileSync(file, worker, 'utf8');
const back = fs.readFileSync(file, 'utf8');
const m = back.match(/const B64 = "([A-Za-z0-9+/=]+)";/);
if (!m) throw new Error('B64 constant missing');
if (!Buffer.from(m[1], 'base64').equals(html)) throw new Error('payload mismatch');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
console.log('worker rebuilt ' + file);
console.log('  worker ' + Buffer.byteLength(worker) + ' B');
console.log('  html   ' + html.length + ' B sha256 ' + sha(html));
