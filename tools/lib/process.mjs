/* 云端图片处理：原图原样保留 + 2400 预览 + 640 缩略图 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const VIEWABLE = new Set(['jpeg', 'png', 'gif', 'webp', 'avif']);
const MAX_ORIG = 40 * 1024 * 1024;     // 云端走内网，比手机端放宽
const PREVIEW_EDGE = 2400;
const PREVIEW_BUDGET = 900 * 1024;

export const IMAGE_RE = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?)$/i;

export async function processImage(filePath) {
  const name = path.basename(filePath);
  const buf = await fs.readFile(filePath);

  let meta;
  try {
    meta = await sharp(buf, { failOn: 'none' }).metadata();
  } catch {
    throw new Error('无法识别的图片格式');
  }
  if (!meta.width || !meta.height) throw new Error('读不到图片尺寸');
  const fmt = meta.format;

  let orig = buf;
  let origExt = (path.extname(name) || '.' + fmt).toLowerCase().replace('.jpeg', '.jpg');
  let note = '';

  if (!VIEWABLE.has(fmt)) {
    orig = await sharp(buf, { failOn: 'none' }).rotate().png().toBuffer();
    origExt = '.png';
    note = '浏览器看不了 ' + fmt + '，已转 PNG';
  } else if (orig.length > MAX_ORIG) {
    orig = await sharp(buf, { failOn: 'none' }).rotate().flatten({ background: '#ffffff' })
      .jpeg({ quality: 94, mozjpeg: true }).toBuffer();
    origExt = '.jpg';
    note = '原图超过 ' + Math.round(MAX_ORIG / 1048576) + 'MB 上限，已压缩';
  }

  const thumb = await sharp(buf, { failOn: 'none' }).rotate()
    .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 74 }).toBuffer();

  let preview = null;
  const longEdge = Math.max(meta.width || 0, meta.height || 0);
  if (longEdge > PREVIEW_EDGE || orig.length > PREVIEW_BUDGET) {
    preview = await sharp(buf, { failOn: 'none' }).rotate()
      .resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 88 }).toBuffer();
  }

  return { name, orig, origExt, thumb, preview, bytes: orig.length, width: meta.width, height: meta.height, note };
}

export function manifestItem(res, seq, urls) {
  return {
    n: String(seq).padStart(3, '0') + res.origExt,
    title: res.name,
    sz: res.bytes,
    f: urls.view,
    th: urls.thumb,
    ...(urls.dl ? { dl: urls.dl } : {}),
  };
}