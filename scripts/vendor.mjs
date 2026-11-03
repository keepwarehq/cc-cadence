// 把 webview 要用的第三方脚本拷进 media/vendor，打包时就不用带 node_modules
import { copyFileSync, mkdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const out = new URL('media/vendor/', root);
mkdirSync(out, { recursive: true });
const files = {
  'marked.min.js': 'node_modules/marked/marked.min.js',
  'purify.min.js': 'node_modules/dompurify/dist/purify.min.js',
};
for (const [name, from] of Object.entries(files)) copyFileSync(new URL(from, root), new URL(name, out));
