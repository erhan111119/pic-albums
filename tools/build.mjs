/* 云端构建：inbox/<id>/ 里的图片 → a/<id>/ 相册，然后清空 inbox 并写 status/<id>.json
   由 .github/workflows/album.yml 调用，运行在 GitHub Actions 的 runner 上 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { processImage, manifestItem, IMAGE_RE } from './lib/process.mjs';
import { buildStaticAlbum } from './lib/albumstatic.mjs';

const ROOT = process.cwd();
const INBOX = path.join(ROOT, 'inbox');
const ALBUMS = path.join(ROOT, 'a');
const STATUS = path.join(ROOT, 'status');
const LINKS = path.join(ROOT, '已生成的链接.txt');

const OWNER = process.env.GH_OWNER || 'erhan111119';
const REPO = process.env.GH_REPO || 'pic-albums';
const BASE_SITE = process.env.SITE_BASE || `https://${OWNER.toLowerCase()}.github.io/${REPO}`;

const log = (...a) => console.log(...a);

async function walk(dir, acc = []) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

async function writeStatus(id, obj) {
  await fs.mkdir(STATUS, { recursive: true });
  await fs.writeFile(path.join(STATUS, id + '.json'), JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

async function buildBatch(id) {
  const dir = path.join(INBOX, id);
  const all = await walk(dir);
  const files = all.filter((f) => IMAGE_RE.test(f)).sort();
  if (!files.length) {
    log(`  批次 ${id} 里没有图片，跳过`);
    return { id, skipped: true };
  }

  let meta = {};
  const metaFile = path.join(dir, '.meta.json');
  try { meta = JSON.parse(await fs.readFile(metaFile, 'utf8')); } catch { /* 没写就用默认 */ }

  const title = (meta.title || '').toString().slice(0, 80) || '图集 ' + id;
  log(`  批次 ${id}：${files.length} 张，标题「${title}」`);

  const items = [];
  const notes = [];
  const outDir = path.join(ALBUMS, id);
  await fs.mkdir(path.join(outDir, 'orig'), { recursive: true });
  await fs.mkdir(path.join(outDir, 'th'), { recursive: true });

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const r = await processImage(f);
    const stem = String(i + 1).padStart(3, '0');
    const origName = stem + r.origExt;
    const prevName = stem + '.webp';
    const thumbName = stem + '.webp';

    await fs.writeFile(path.join(outDir, 'orig', origName), r.orig);
    await fs.writeFile(path.join(outDir, 'th', thumbName), r.thumb);
    let urls = { view: 'orig/' + origName, thumb: 'th/' + thumbName };
    if (r.preview) {
      await fs.mkdir(path.join(outDir, 'prev'), { recursive: true });
      await fs.writeFile(path.join(outDir, 'prev', prevName), r.preview);
      urls = { view: 'prev/' + prevName, thumb: 'th/' + thumbName, dl: 'orig/' + origName };
    }
    items.push(manifestItem({ ...r, name: path.basename(f) }, i + 1, urls));
    if (r.note) notes.push(path.basename(f) + '：' + r.note);
    log(`    ${i + 1}/${files.length} ${path.basename(f)} → ${origName} (${(r.bytes / 1024).toFixed(0)}KB${r.preview ? ', 预览 ' + (r.preview.length / 1024).toFixed(0) + 'KB' : ''})`);
  }

  const html = buildStaticAlbum({
    title,
    created: new Date().toISOString(),
    foot: '图片托管在 GitHub Pages · 点开看大图 · 下载和打包给的是原图',
    items,
  });
  await fs.writeFile(path.join(outDir, 'index.html'), html, 'utf8');

  const total = items.reduce((s, it) => s + it.sz, 0);
  const url = `${BASE_SITE}/a/${id}/`;

  try {
    await fs.appendFile(LINKS, `${new Date().toISOString().slice(0, 16).replace('T', ' ')}\t${title}\t${items.length} 张\t${url}\n`, 'utf8');
  } catch { /* 无所谓 */ }

  await writeStatus(id, {
    ok: true,
    url,
    count: items.length,
    bytes: total,
    title,
    notes,
    finishedAt: new Date().toISOString(),
  });

  log(`  完成：${url}（${items.length} 张，${(total / 1048576).toFixed(1)} MB）`);
  return { id, url, count: items.length, bytes: total };
}

async function main() {
  let batches = [];
  try {
    batches = (await fs.readdir(INBOX, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    log('没有 inbox 目录，什么都不做');
    return;
  }
  if (!batches.length) {
    log('inbox 是空的，什么都不做');
    return;
  }
  log('要处理 ' + batches.length + ' 个批次：' + batches.join(', '));

  const results = [];
  for (const id of batches) {
    if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(id)) {
      log(`  批次名 ${id} 不合规，跳过`);
      continue;
    }
    try {
      const r = await buildBatch(id);
      results.push(r);
      await fs.rm(path.join(INBOX, id), { recursive: true, force: true });
    } catch (e) {
      log('  批次 ' + id + ' 失败：' + e.message);
      await writeStatus(id, { ok: false, error: e.message.slice(0, 300), failedAt: new Date().toISOString() });
      await fs.rm(path.join(INBOX, id), { recursive: true, force: true });
    }
  }

  await fs.writeFile(path.join(ROOT, '.build-result.json'), JSON.stringify(results, null, 2), 'utf8');
  log('全部完成：' + JSON.stringify(results.filter((r) => r.url).map((r) => r.url)));
}

main().catch(async (e) => {
  console.error('构建失败：' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});