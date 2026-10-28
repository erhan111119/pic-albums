/* 把一堆图片打成一个静态相册页（图片是独立文件，页面很小，秒开） */
import { ALBUM_CSS, ALBUM_JS, ALBUM_SHELL } from './album-assets.mjs';

function escHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function jsonForScript(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
const fill = (tpl, key, val) => tpl.split(key).join(val);

/**
 * items: [{ n: 文件名, f: 'img/001.jpg', th: 'th/001.webp', sz: 字节数 }]
 */
export function buildStaticAlbum({ title, created, foot, items }) {
  const payload = { title, created, foot, enc: false, items };
  let out = ALBUM_SHELL;
  out = fill(out, '__TITLE__', escHtml(title || '图集'));
  out = fill(out, '__CSS__', ALBUM_CSS);
  out = fill(out, '__JS__', ALBUM_JS);
  out = fill(out, '__PAYLOAD__', jsonForScript(payload));
  return out;
}