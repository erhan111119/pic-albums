/* 图集发布 · 手机端
   选相册图 → 直接把原图传进仓库 inbox/<id>/ → 云端 Action 生成相册 → 拿链接
   token 只存在这台手机的 localStorage 里 */
'use strict';

const API = 'https://api.github.com';
const LS = {
  token: 'imgshare.token',
  repo: 'imgshare.repo',
  owner: 'imgshare.owner',
  site: 'imgshare.site',
};
const MAX_FILE = 40 * 1024 * 1024;      // 单张上限，和云端处理保持一致
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const $ = (id) => document.getElementById(id);
const state = { token: '', repo: '', owner: '', site: '', files: [], cancel: false, busy: false };

/* ---------- 屏幕切换 ---------- */
const SCREENS = ['s-setup', 's-main', 's-progress', 's-done', 's-error'];
function show(id) {
  for (const s of SCREENS) $(s).classList.toggle('hidden', s !== id);
  window.scrollTo(0, 0);
}

/* ---------- 工具 ---------- */
function genId() {
  // 7 位 base36，和电脑版一致，够短又不容易撞
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n.toString(36).slice(-7).padStart(7, '0');
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function extOf(file) {
  const m = /\.([a-z0-9]+)$/i.exec(file.name || '');
  if (m) return '.' + m[1].toLowerCase();
  if (file.type === 'image/png') return '.png';
  if (file.type === 'image/gif') return '.gif';
  if (file.type === 'image/webp') return '.webp';
  if (file.type === 'image/avif') return '.avif';
  return '.jpg';
}

/* ---------- GitHub API（带重试） ---------- */
async function api(path, { method = 'GET', body, attempts = 4, timeout = 120000 } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    let r;
    try {
      r = await fetch(API + path, {
        method,
        headers: {
          authorization: 'Bearer ' + state.token,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      last = new Error('网络中断（' + (e.name === 'TimeoutError' ? '超时' : (e.message || e.name)) + '）');
      if (i < attempts) { await sleep(1200 * 2 ** i); continue; }
      throw last;
    }
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    if (r.ok) return json;

    const msg = (json && json.message) || text.slice(0, 160) || 'HTTP ' + r.status;
    last = new Error(msg + '（HTTP ' + r.status + '）');
    last.status = r.status;
    const transient = [401, 408, 429, 500, 502, 503, 504].includes(r.status);
    if (!transient || i === attempts) throw last;
    await sleep(1200 * 2 ** i);
  }
  throw last;
}

/* ---------- 设置 ---------- */
async function verifyAndSave(token, repo) {
  state.token = token.trim();
  state.repo = repo.trim() || 'pic-albums';
  const me = await api('/user', { timeout: 25000 });
  state.owner = me.login;
  const r = await api(`/repos/${state.owner}/${state.repo}`, { timeout: 25000 });
  if (!r.permissions || !r.permissions.push) {
    throw new Error('这枚 token 对 ' + state.repo + ' 没有写权限。检查是否勾了 Contents: Read and write。');
  }
  state.site = `https://${state.owner.toLowerCase()}.github.io/${state.repo}`;
  localStorage.setItem(LS.token, state.token);
  localStorage.setItem(LS.repo, state.repo);
  localStorage.setItem(LS.owner, state.owner);
  localStorage.setItem(LS.site, state.site);
  return me;
}

function loadSettings() {
  state.token = localStorage.getItem(LS.token) || '';
  state.repo = localStorage.getItem(LS.repo) || 'pic-albums';
  state.owner = localStorage.getItem(LS.owner) || '';
  state.site = localStorage.getItem(LS.site) || '';
  return Boolean(state.token && state.owner);
}

/* ---------- 选图 ---------- */
function renderFiles() {
  const list = $('filelist');
  list.innerHTML = '';
  let total = 0;
  for (const f of state.files) {
    total += f.size;
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = f.name;
    const s = document.createElement('span');
    s.textContent = fmtBytes(f.size);
    li.append(b, s);
    list.append(li);
  }
  const tooBig = state.files.filter((f) => f.size > MAX_FILE);
  $('sum').textContent = state.files.length
    ? `已选 ${state.files.length} 张，共 ${fmtBytes(total)}` + (tooBig.length ? `　⚠️ ${tooBig.length} 张超过 40MB 会被压缩` : '')
    : '';
  $('btn-go').disabled = state.files.length === 0 || state.busy;
}

/* ---------- 上传 ---------- */
async function normalize(file, idx) {
  // iPhone 的 HEIC 一般会被系统转成 JPEG；万一没转，这里再兜一次底
  const heic = /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
  if (!heic) return file;
  try {
    const bmp = await createImageBitmap(file);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.95));
    bmp.close && bmp.close();
    if (!blob) throw new Error('canvas 输出为空');
    return new File([blob], 'photo-' + (idx + 1) + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;      // 转不了就让云端试，失败会明确报出来
  }
}

async function uploadOne(dirPath, name, file, onProgress) {
  const buf = await file.arrayBuffer();
  const b64 = toBase64(buf);
  const res = await api(`/repos/${state.owner}/${state.repo}/git/blobs`, {
    method: 'POST',
    body: { content: b64, encoding: 'base64' },
    timeout: 90000 + Math.round((b64.length / 1048576) * 20000),
    attempts: 4,
  });
  onProgress && onProgress();
  return { path: dirPath + '/' + name, sha: res.sha, size: buf.byteLength };
}

async function commitBatch(id, entries, title, count) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ref = await api(`/repos/${state.owner}/${state.repo}/git/ref/heads/main`, { timeout: 30000 });
    const headSha = ref.object.sha;
    const headCommit = await api(`/repos/${state.owner}/${state.repo}/git/commits/${headSha}`, { timeout: 30000 });
    const tree = await api(`/repos/${state.owner}/${state.repo}/git/trees`, {
      method: 'POST',
      body: {
        base_tree: headCommit.tree.sha,
        tree: entries.map((e) => ({ path: e.path, mode: '100644', type: 'blob', sha: e.sha })),
      },
      timeout: 60000,
    });
    const commit = await api(`/repos/${state.owner}/${state.repo}/git/commits`, {
      method: 'POST',
      body: {
        message: `手机上传：${title || id}（${count} 张）`,
        tree: tree.sha,
        parents: [headSha],
      },
      timeout: 60000,
    });
    try {
      await api(`/repos/${state.owner}/${state.repo}/git/refs/heads/main`, {
        method: 'PATCH',
        body: { sha: commit.sha, force: false },
        timeout: 60000,
      });
      return commit.sha;
    } catch (e) {
      if (attempt === 3) throw e;      // 别人刚好也提交了，重来一轮
      await sleep(1500);
    }
  }
}

async function runUpload() {
  state.busy = true;
  state.cancel = false;
  const title = $('in-title').value.trim();
  const files = state.files.slice();
  const id = genId();
  const dir = 'inbox/' + id;

  show('s-progress');
  $('pg-title').textContent = '正在上传…';
  $('pg-bar').style.width = '0%';
  $('btn-cancel').classList.remove('hidden');

  const entries = [];
  let sentBytes = 0;
  const totalBytes = files.reduce((a, f) => a + f.size, 0);

  try {
    // 批次说明，云端会用它当标题
    const metaB64 = toBase64(new TextEncoder().encode(JSON.stringify({
      title, created: new Date().toISOString(), count: files.length,
    })));
    const metaRes = await api(`/repos/${state.owner}/${state.repo}/git/blobs`, {
      method: 'POST', body: { content: metaB64, encoding: 'base64' }, timeout: 30000,
    });
    entries.push({ path: dir + '/.meta.json', sha: metaRes.sha });

    for (let i = 0; i < files.length; i++) {
      if (state.cancel) throw new Error('已取消');
      const f = await normalize(files[i], i);
      $('pg-text').textContent = `上传 ${i + 1}/${files.length}　${fmtBytes(sentBytes)} / ${fmtBytes(totalBytes)}`;
      $('pg-sub').textContent = f.name;
      const name = String(i + 1).padStart(3, '0') + extOf(f);
      const e = await uploadOne(dir, name, f, () => {
        sentBytes += f.size;
        $('pg-bar').style.width = Math.min(99, (sentBytes / totalBytes) * 92) + '%';
      });
      entries.push(e);
    }

    $('pg-title').textContent = '提交中…';
    $('pg-text').textContent = '把这一批交给云端构建';
    await commitBatch(id, entries, title, files.length);

    $('pg-title').textContent = '云端生成相册…';
    $('pg-bar').style.width = '100%';
    $('btn-cancel').classList.add('hidden');

    const result = await waitForResult(id);
    $('done-url').textContent = result.url;
    $('done-url').href = result.url;
    $('done-title').textContent = '好了，链接在这里';
    $('done-sub').textContent = result.count
      ? `${result.count} 张，原图 ${fmtBytes(result.bytes || 0)}　·　点开看预览，下载和打包给原图`
      : '点开就能看，发给别人也行';
    show('s-done');
  } catch (e) {
    $('err-text').textContent = e.message || String(e);
    show('s-error');
  } finally {
    state.busy = false;
  }
}

async function waitForResult(id) {
  const albumUrl = `${state.site}/a/${id}/`;
  const t0 = Date.now();
  for (let i = 0; i < 110; i++) {
    if (state.cancel) throw new Error('已取消');
    const sec = Math.round((Date.now() - t0) / 1000);
    $('pg-text').textContent = `云端处理中 ${sec}s（一般 1~3 分钟，图多会久一点）`;

    // 云端写的状态文件：成功拿准确信息，失败拿原因
    try {
      const st = await api(`/repos/${state.owner}/${state.repo}/contents/status/${id}.json`, { timeout: 25000, attempts: 1 });
      if (st && st.content) {
        const obj = JSON.parse(new TextDecoder().decode(fromBase64(st.content)));
        if (obj.ok === false) throw new Error('云端处理失败：' + (obj.error || '未知原因'));
        if (obj.ok) return { url: obj.url || albumUrl, count: obj.count, bytes: obj.bytes };
      }
    } catch (e) {
      if (e.status && e.status !== 404) throw e;
      if (e.message && e.message.startsWith('云端处理失败')) throw e;
    }

    // 页面已经上线也算成功
    try {
      const r = await fetch(albumUrl + 'index.html?t=' + Date.now(), { cache: 'no-store', mode: 'cors' });
      if (r.ok) return { url: albumUrl };
    } catch { /* 还没好 */ }

    await sleep(4000);
  }
  throw new Error('等了 7 分钟还没好。去仓库的 Actions 页面看是不是报错了：' + `${state.site.replace(/\.github\.io.*/, '')}`.replace('https://', 'https://github.com/') + '/' + state.repo + '/actions');
}

/* ---------- 事件绑定 ---------- */
function bind() {
  $('btn-save').addEventListener('click', async () => {
    const btn = $('btn-save');
    btn.disabled = true;
    $('setup-msg').textContent = '检查中…';
    $('setup-msg').className = 'msg';
    try {
      const me = await verifyAndSave($('in-token').value, $('in-repo').value);
      $('who').textContent = `账号 ${me.login} · 仓库 ${state.repo}`;
      $('setup-msg').textContent = '';
      show('s-main');
    } catch (e) {
      $('setup-msg').textContent = e.message || String(e);
      $('setup-msg').className = 'msg err';
    } finally {
      btn.disabled = false;
    }
  });

  $('in-files').addEventListener('change', (ev) => {
    state.files = Array.from(ev.target.files || []);
    renderFiles();
  });

  $('btn-go').addEventListener('click', () => runUpload());

  $('btn-cancel').addEventListener('click', () => {
    state.cancel = true;
    $('pg-text').textContent = '正在取消…';
  });

  $('btn-copy').addEventListener('click', async () => {
    const url = $('done-url').textContent;
    try {
      await navigator.clipboard.writeText(url);
      $('btn-copy').textContent = '已复制';
      setTimeout(() => { $('btn-copy').textContent = '复制链接'; }, 1500);
    } catch {
      $('btn-copy').textContent = '长按链接手动复制';
    }
  });

  $('btn-share').addEventListener('click', async () => {
    const url = $('done-url').textContent;
    if (navigator.share) {
      try { await navigator.share({ title: '图集', url }); } catch { /* 用户取消 */ }
    } else {
      await navigator.clipboard.writeText(url).catch(() => {});
      $('btn-share').textContent = '已复制';
      setTimeout(() => { $('btn-share').textContent = '分享'; }, 1500);
    }
  });

  $('btn-again').addEventListener('click', () => {
    state.files = [];
    $('in-files').value = '';
    $('in-title').value = '';
    renderFiles();
    show('s-main');
  });

  $('btn-back').addEventListener('click', () => {
    renderFiles();
    show('s-main');
  });

  $('btn-reset').addEventListener('click', () => {
    if (!confirm('要清除这台手机里保存的 token 吗？')) return;
    for (const k of Object.values(LS)) localStorage.removeItem(k);
    state.token = '';
    show('s-setup');
  });
}

/* ---------- 启动 ---------- */
(function init() {
  bind();
  if (loadSettings()) {
    $('who').textContent = `账号 ${state.owner} · 仓库 ${state.repo}`;
    show('s-main');
  } else {
    show('s-setup');
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
