import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve(process.argv[2] || 'dist');
const api = process.env.VITE_API_BASE_URL || '';
const apiOrigin = api ? new URL(api).origin : '';
if (apiOrigin && !apiOrigin.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(apiOrigin)) throw new Error('API must use HTTPS');
const hash = (text) => 'sha256-' + createHash('sha256').update(text).digest('base64');
for (const filename of await readdir(directory)) {
  if (!filename.endsWith('.html')) continue;
  let html = await readFile(path.join(directory, filename), 'utf8');
  const scriptHashes = [];
  const styleHashes = [];
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const [tag, attributes, content] of scripts) {
    const src = attributes.match(/\bsrc="([^"]+)"/)?.[1];
    if (src === 'https://telegram.org/js/telegram-web-app.js') {
      // A hashed bootstrap delegates trust to the official optional SDK without
      // allowing arbitrary scripts hosted on the same domain.
      const bootstrap = '(()=>{const s=document.createElement("script");s.src="https://telegram.org/js/telegram-web-app.js";s.async=true;s.onload=()=>window.dispatchEvent(new Event("telegram-sdk-ready"));document.head.appendChild(s)})();';
      scriptHashes.push(hash(bootstrap));
      html = html.replace(tag, `<script>${bootstrap}</script>`);
    } else if (src) {
      if (!src.startsWith('/assets/')) throw new Error(`Unexpected executable source in ${filename}`);
      const digest = hash(await readFile(path.join(directory, src.slice(1))));
      scriptHashes.push(digest);
      html = html.replace(tag, `<script${attributes} integrity="${digest}">${content}</script>`);
    } else {
      scriptHashes.push(hash(content));
    }
  }
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) styleHashes.push(hash(match[1]));
  const policy = [
    "default-src 'none'", "base-uri 'none'", "object-src 'none'",
    `script-src ${scriptHashes.length ? scriptHashes.map(x => `'${x}'`).join(' ') + " 'strict-dynamic'" : "'none'"}`,
    "script-src-attr 'none'",
    `style-src 'self' ${styleHashes.map(x => `'${x}'`).join(' ')}`.trim(),
    // Only CSS attributes used by progress meters and Telegram theme variables.
    "style-src-attr 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self'",
    `connect-src 'self' ${apiOrigin} https://storage.yandexcloud.net https://easygame7-audio-d81bb227-42b6a9.storage.yandexcloud.net`.replace(/ +/g, ' '),
    "media-src 'self' blob:", "manifest-src 'self'", "frame-src 'none'", "form-action 'self'",
  ].join('; ');
  if (!/<meta charset=/i.test(html)) html = html.replace(/<head>/i, '<head><meta charset="UTF-8" />');
  html = html.replace(/(<meta charset="[^"]+"\s*\/?>)/i, `$1\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />\n    <meta name="referrer" content="no-referrer" />`);
  if (!html.includes('http-equiv="Content-Security-Policy"')) throw new Error(`Missing CSP in ${filename}`);
  await writeFile(path.join(directory, filename), html);
  console.log(`CSP enabled: ${filename} (${scriptHashes.length} trusted scripts)`);
}
