'use strict';

/* ===================== أدوات مساعدة ===================== */
const $ = (id) => document.getElementById(id);
const api = async (path, body) => {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    location.replace('/login'); // انتهت الجلسة
    throw new Error('انتهت الجلسة');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `خطأ ${res.status}`);
  return data;
};

const AR = new Intl.NumberFormat('ar-EG');
const nf = (n, d = 1) => Number(n).toFixed(d).replace(/\.0$/, '');

function fmtBytes(b) {
  if (!b && b !== 0) return '';
  const u = ['بايت', 'كيلوبايت', 'ميجابايت', 'جيجابايت'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${nf(b, i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtSpeed(s) {
  if (!s) return '';
  let v = s, i = 0;
  const u = ['ب/ث', 'ك.ب/ث', 'م.ب/ث'];
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${nf(v, 1)} ${u[i]}`;
}

function fmtTime(sec) {
  if (sec == null || !Number.isFinite(sec)) return '';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

function fmtEta(sec) {
  if (sec == null || !Number.isFinite(sec)) return '';
  if (sec < 60) return `${Math.round(sec)} ث`;
  if (sec < 3600) return `${Math.round(sec / 60)} د`;
  return `${nf(sec / 3600, 1)} س`;
}

const isRTL = (s) => /[؀-ۿ]/.test(String(s || ''));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 320);
  }, 3600);
}

/* ===================== الحالة ===================== */
let info = null;          // معلومات آخر رابط تم تحليله
let health = {};
let settings = {};
const jobs = new Map();

/* ===================== الفحص الأولي ===================== */
async function loadHealth() {
  try {
    health = await api('/api/health');
  } catch { return; }

  const chips = [];
  chips.push(health.ytdlp
    ? `<span class="chip">yt-dlp <b>${esc(health.ytdlpVersion || '✓')}</b></span>`
    : `<span class="chip bad">yt-dlp غير مثبّت</span>`);
  chips.push(health.ffmpeg
    ? `<span class="chip">ffmpeg</span>`
    : `<span class="chip bad">ffmpeg مفقود</span>`);
  $('chips').innerHTML = chips.join('');

  if (!health.ytdlp) showError('yt-dlp غير مثبّت. نفّذ في الطرفية:  pip install -U yt-dlp');
  else if (!health.ffmpeg) toast('ffmpeg غير مثبّت — الجودات العالية قد لا تُدمج. نفّذ: brew install ffmpeg', 'error');
}

/* ===================== تحليل الرابط ===================== */
function showError(msg) {
  const el = $('err');
  el.textContent = msg;
  el.hidden = !msg;
}

function urlsFromInput() {
  return $('url').value.split(/[\n\s]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
}

async function analyze() {
  const list = urlsFromInput();
  showError('');
  if (!list.length) { showError('الصق رابطًا صحيحًا يبدأ بـ http أو https'); return; }

  // أكثر من رابط ← نضيفها مباشرة للطابور بأفضل جودة
  if (list.length > 1) {
    await enqueue({ urls: list, mode: 'video', quality: 'best' });
    toast(`أُضيف ${AR.format(list.length)} رابط إلى قائمة التحميل`);
    $('url').value = '';
    autoGrow();
    return;
  }

  const btn = $('btnAnalyze');
  btn.disabled = true;
  btn.classList.add('loading');
  btn.querySelector('.spinner').hidden = false;
  $('preview').hidden = true;

  try {
    info = await api('/api/info', {
      url: list[0],
      playlist: $('optPlaylist').checked,
      cookiesBrowser: $('optCookies').checked ? $('cookiesBrowser').value : null,
      referer: $('optReferer').checked ? ($('refererUrl').value.trim() || null) : null,
    });
    renderPreview();
  } catch (e) {
    info = null;
    showError(e.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.querySelector('.spinner').hidden = true;
  }
}

function renderPreview() {
  if (!info) return;
  const pv = $('preview');
  pv.hidden = false;

  $('pvThumb').src = info.thumbnail || '';
  $('pvThumb').style.opacity = info.thumbnail ? '1' : '0';
  $('pvTitle').textContent = info.title;
  $('pvTitle').dir = isRTL(info.title) ? 'rtl' : 'ltr';
  $('pvUploader').textContent = info.uploader || '';
  $('pvSite').textContent = info.extractor || '';
  $('pvDur').textContent = info.duration ? fmtTime(info.duration) : '';
  $('pvDur').hidden = !info.duration;
  $('pvLive').hidden = !info.isLive;

  const isPl = info.kind === 'playlist';
  $('pvPlaylist').hidden = !isPl;
  if (isPl) {
    $('pvPlaylist').textContent = `قائمة تشغيل تحتوي ${AR.format(info.count || 0)} فيديو — سيتم تحميلها كاملة في مجلد باسم القائمة.`;
    $('optPlaylist').checked = true;
  }

  buildQualityOptions();
  $('formatsBox').hidden = true;
  $('formatsBox').innerHTML = '';
  pv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function buildQualityOptions() {
  const sel = $('quality');
  const heights = (info && info.heights) || [];
  const opts = [];

  opts.push('<option value="best">أفضل جودة متاحة</option>');
  const labels = { 2160: '4K', 1440: '2K', 1080: 'Full HD', 720: 'HD', 480: 'SD', 360: 'منخفضة' };
  const ladder = [2160, 1440, 1080, 720, 480, 360];

  for (const h of ladder) {
    const available = !heights.length || heights.some((x) => x >= h);
    if (!available) continue;
    const exact = heights.includes(h) ? '' : ' أو أقل';
    opts.push(`<option value="${h}">${h}p${labels[h] ? ` · ${labels[h]}` : ''}${exact}</option>`);
  }
  opts.push('<option value="smallest">أصغر حجم ممكن</option>');

  sel.innerHTML = opts.join('');
  // نختار 1080p افتراضيًا إن توفّرت، وإلا أفضل جودة
  sel.value = heights.some((h) => h >= 1080) ? '1080' : 'best';
}

/* ===================== جدول الصيغ ===================== */
function renderFormats() {
  const box = $('formatsBox');
  if (!info || info.kind !== 'video') return;
  if (!box.hidden) { box.hidden = true; return; }

  const rows = [];
  if (info.video?.length) {
    rows.push('<div class="fmt-section">فيديو</div>');
    for (const f of info.video) {
      const tags = [
        f.ext && `<span class="tag">${esc(f.ext)}</span>`,
        f.fps && f.fps > 30 && `<span class="tag">${f.fps}fps</span>`,
        f.vcodec && `<span class="tag">${esc(f.vcodec)}</span>`,
        !f.muxed && `<span class="tag warn">بدون صوت — يُدمج تلقائيًا</span>`,
        f.note && `<span class="tag">${esc(f.note)}</span>`,
      ].filter(Boolean).join('');
      rows.push(
        `<div class="fmt" data-id="${esc(f.id)}" data-onlyvideo="${!f.muxed}">
           <span class="fmt-res">${f.height ? f.height + 'p' : '—'}</span>
           <span class="fmt-tags">${tags}</span>
           <span class="fmt-size">${fmtBytes(f.size)}</span>
         </div>`
      );
    }
  }
  if (info.audio?.length) {
    rows.push('<div class="fmt-section">صوت</div>');
    for (const f of info.audio) {
      const tags = [
        f.ext && `<span class="tag">${esc(f.ext)}</span>`,
        f.acodec && `<span class="tag">${esc(f.acodec)}</span>`,
        f.note && `<span class="tag">${esc(f.note)}</span>`,
      ].filter(Boolean).join('');
      rows.push(
        `<div class="fmt" data-id="${esc(f.id)}" data-onlyvideo="false">
           <span class="fmt-res">${f.abr ? f.abr + 'k' : 'صوت'}</span>
           <span class="fmt-tags">${tags}</span>
           <span class="fmt-size">${fmtBytes(f.size)}</span>
         </div>`
      );
    }
  }

  box.innerHTML = rows.join('') || '<div class="fmt-section">لا توجد صيغ معلنة — استخدم «أفضل جودة متاحة»</div>';
  box.hidden = false;

  box.querySelectorAll('.fmt').forEach((row) => {
    row.addEventListener('click', () => {
      download({ formatId: row.dataset.id, formatOnlyVideo: row.dataset.onlyvideo === 'true' });
      box.hidden = true;
    });
  });
}

/* ===================== التحميل ===================== */
function currentMode() {
  return document.querySelector('#modeSeg .seg.on').dataset.mode;
}

function collectOptions(extra = {}) {
  const mode = currentMode();
  return {
    mode,
    quality: $('quality').value,
    audioFormat: $('audioFormat').value,
    playlist: $('optPlaylist').checked,
    subs: $('optSubs').checked,
    embedSubs: true,
    cookiesBrowser: $('optCookies').checked ? $('cookiesBrowser').value : null,
    referer: $('optReferer').checked ? ($('refererUrl').value.trim() || null) : null,
    sectionFrom: $('optTrim').checked ? ($('trimFrom').value.trim() || null) : null,
    sectionTo: $('optTrim').checked ? ($('trimTo').value.trim() || null) : null,
    ...extra,
  };
}

async function enqueue(payload) {
  const data = await api('/api/enqueue', payload);
  return data.jobs;
}

async function download(extra = {}) {
  const list = urlsFromInput();
  if (!list.length) { showError('لا يوجد رابط'); return; }
  showError('');

  try {
    await enqueue({
      urls: list,
      title: info?.title,
      thumbnail: info?.thumbnail,
      ...collectOptions(extra),
    });
    toast('بدأ التحميل');
    $('preview').hidden = true;
    $('url').value = '';
    autoGrow();
    info = null;
  } catch (e) {
    showError(e.message);
  }
}

/* ===================== مستخرِج الشبكة ===================== */
const media = new Map();

async function startSniff() {
  const list = urlsFromInput();
  showError('');
  if (!list.length) { showError('الصق رابط صفحة الدرس أولًا، ثم اضغط استخراج'); return; }

  const btn = $('btnSniff');
  btn.disabled = true;
  try {
    media.clear();
    renderMedia();
    $('sniffPanel').hidden = false;
    $('sniffStatus').textContent = 'جارٍ فتح المتصفح…';
    $('sniffPulse').classList.remove('off');
    const r = await api('/api/sniff/start', { url: list[0], embedded: true });
    $('sniffStatus').textContent = `${r.browser} يعمل داخل الأداة — سجّل دخولك وشغّل الفيديو`;
    startView();
    $('sniffPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    showError(e.message);
    $('sniffPanel').hidden = true;
  } finally {
    btn.disabled = false;
  }
}

async function stopSniff() {
  stopView();
  try { await api('/api/sniff/stop', {}); } catch { /* تجاهل */ }
  $('sniffPulse').classList.add('off');
}

function renderMedia() {
  const box = $('sniffList');
  const items = [...media.values()];
  $('sniffEmpty').hidden = items.length > 0;

  box.innerHTML = items.map((m, i) => `
    <div class="media" data-i="${i}">
      <span class="media-kind">${esc(m.kind)}</span>
      ${m.sameSite ? '<span class="media-kind same">من الموقع</span>' : ''}
      <div class="media-body">
        ${m.name ? `<div class="media-name" dir="auto">${esc(m.name)}</div>` : ''}
        <div class="media-url" title="${esc(m.url)}">${esc(m.url)}</div>
        <div class="media-sub">${esc(m.host || '')}${m.size ? ' · ' + fmtBytes(m.size) : ''}</div>
      </div>
      <button class="primary" data-dl="${i}">تحميل</button>
    </div>
  `).join('');

  box.querySelectorAll('[data-dl]').forEach((btn) => {
    btn.addEventListener('click', () => downloadMedia(items[Number(btn.dataset.dl)]));
  });
}

async function downloadMedia(m) {
  try {
    // نُصدّر كوكيز جلسة المتصفح حتى يقبل السيرفر طلب التحميل
    const { cookieFile } = await api('/api/sniff/cookies', { url: m.url });
    // الترتيب مهم: قيم المستخرِج تتغلّب على خيارات الواجهة العامة
    await enqueue({
      ...collectOptions(),
      urls: [m.url],
      title: m.name || m.pageTitle || m.url,
      outputTitle: m.name || null,
      referer: m.pageUrl || null,
      cookieFile: cookieFile || null,
    });
    toast('بدأ التحميل');
  } catch (e) { toast(e.message, 'error'); }
}

/* ---- شاشة المتصفح المدمجة ---- */
let viewLoop = null;
let viewSize = { w: 1280, h: 800 };
let frameCount = 0;
let frameMark = 0;

function startView() {
  if (viewLoop) return;
  $('viewWrap').hidden = false;
  const img = $('viewImg');
  frameMark = Date.now();

  const tick = () => {
    const next = new Image();
    next.onload = () => {
      img.src = next.src;
      $('viewIdle').hidden = true;
      viewSize = { w: next.naturalWidth, h: next.naturalHeight };
      frameCount++;
      const dt = Date.now() - frameMark;
      if (dt > 1000) {
        $('viewFps').textContent = `${Math.round((frameCount * 1000) / dt)} إطار/ث`;
        frameCount = 0;
        frameMark = Date.now();
      }
      viewLoop = setTimeout(tick, 60);
    };
    next.onerror = () => { viewLoop = setTimeout(tick, 600); };
    next.src = `/api/sniff/frame?t=${Date.now()}`;
  };
  tick();
}

function stopView() {
  clearTimeout(viewLoop);
  viewLoop = null;
  $('viewWrap').hidden = true;
  $('viewIdle').hidden = false;
  $('viewImg').removeAttribute('src');
}

/** يحوّل إحداثيات النقر في الصورة المعروضة إلى إحداثيات الصفحة الحقيقية */
function toPageCoords(e) {
  const img = $('viewImg');
  const r = img.getBoundingClientRect();
  // object-fit: contain — نحسب المساحة الفعلية للصورة داخل الإطار
  const scale = Math.min(r.width / viewSize.w, r.height / viewSize.h);
  const dw = viewSize.w * scale;
  const dh = viewSize.h * scale;
  const ox = r.left + (r.width - dw) / 2;
  const oy = r.top + (r.height - dh) / 2;
  return {
    x: Math.round((e.clientX - ox) / scale),
    y: Math.round((e.clientY - oy) / scale),
  };
}

const sendInput = (payload) => api('/api/sniff/input', payload).catch(() => {});

function bindView() {
  const img = $('viewImg');

  img.addEventListener('click', (e) => {
    const { x, y } = toPageCoords(e);
    sendInput({ kind: 'click', x, y, clickCount: e.detail || 1 });
    $('viewKeys').focus();
  });

  img.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { x, y } = toPageCoords(e);
    sendInput({ kind: 'scroll', x, y, dx: e.deltaX, dy: e.deltaY });
  }, { passive: false });

  const keys = $('viewKeys');
  keys.addEventListener('keydown', (e) => {
    const special = ['Enter', 'Backspace', 'Tab', 'Escape', 'Delete',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    if (special.includes(e.key)) {
      e.preventDefault();
      sendInput({ kind: 'key', key: e.key });
      if (e.key === 'Enter') keys.value = '';
    }
  });
  keys.addEventListener('input', (e) => {
    const text = e.target.value;
    if (!text) return;
    e.target.value = '';
    sendInput({ kind: 'text', text });
  });
}

/* ===================== عرض المهام ===================== */
function jobIcon(name) {
  const paths = {
    open: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    retry: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

function statusLabel(j) {
  if (j.status === 'queued') return 'في الانتظار';
  if (j.status === 'done') return 'اكتمل';
  if (j.status === 'error') return 'فشل';
  if (j.status === 'canceled') return 'أُلغي';
  return j.phase || 'جارٍ التحميل';
}

function renderJob(j) {
  let el = document.getElementById('job-' + j.id);
  if (!el) {
    el = document.createElement('div');
    el.id = 'job-' + j.id;
    el.className = 'job';
    $('jobs').prepend(el);
  }
  el.className = `job ${j.status}`;

  const title = j.title && j.title !== j.url ? j.title : j.url;
  const pct = Math.round(j.percent || 0);

  const bits = [statusLabel(j)];
  if (j.status === 'running') {
    if (j.percent) bits.push(`<span class="stat">${pct}%</span>`);
    if (j.speed) bits.push(`<span class="stat">${fmtSpeed(j.speed)}</span>`);
    if (j.eta) bits.push(`<span class="stat">متبقٍ ${fmtEta(j.eta)}</span>`);
    if (j.total) bits.push(`<span class="stat">${fmtBytes(j.downloaded)} / ${fmtBytes(j.total)}</span>`);
    else if (j.downloaded) bits.push(`<span class="stat">${fmtBytes(j.downloaded)}</span>`);
    // بث HLS: نعرض الزمن المُنزَّل من الفيديو بدل الحجم الكلي المجهول
    if (j.mediaTime) {
      bits.push(`<span class="stat">${fmtTime(j.mediaTime)}${j.duration ? ' / ' + fmtTime(j.duration) : ''}</span>`);
    }
  } else if (j.status === 'done' && j.files?.length) {
    bits.push(`<span class="stat">${AR.format(j.files.length)} ملف</span>`);
  }

  const actions = [];
  if (j.status === 'running' || j.status === 'queued') {
    actions.push(`<button class="stop" data-act="cancel" title="إيقاف">${jobIcon('stop')}</button>`);
  } else {
    if (j.status === 'done' && j.files?.length) {
      actions.push(`<button class="go" data-act="reveal" title="إظهار في المجلد">${jobIcon('open')}</button>`);
    }
    if (j.status !== 'done') {
      actions.push(`<button data-act="retry" title="إعادة المحاولة">${jobIcon('retry')}</button>`);
    }
  }

  el.innerHTML = `
    ${j.thumbnail ? `<img class="job-thumb" src="${esc(j.thumbnail)}" alt="" referrerpolicy="no-referrer">` : ''}
    <div class="job-body">
      <div class="job-title" dir="${isRTL(title) ? 'rtl' : 'ltr'}" title="${esc(j.url)}">${esc(title)}</div>
      <div class="job-sub">${bits.join('<span class="sep">•</span>')}</div>
      ${j.status === 'error' && j.error ? `<div class="job-err">${esc(j.error)}</div>` : ''}
      <div class="bar"><i style="width:${j.status === 'queued' ? 0 : pct}%"></i></div>
    </div>
    <div class="job-actions">${actions.join('')}</div>
  `;

  el.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      try {
        if (act === 'cancel') await api('/api/cancel', { id: j.id });
        else if (act === 'retry') await api('/api/retry', { id: j.id });
        else if (act === 'reveal') await api('/api/open', { path: j.files?.[0], reveal: true });
      } catch (e) { toast(e.message, 'error'); }
    });
  });

  updateEmpty();
}

function updateEmpty() {
  const n = jobs.size;
  $('empty').hidden = n > 0;
  const active = [...jobs.values()].filter((j) => j.status === 'running' || j.status === 'queued').length;
  $('dlCount').textContent = n ? (active ? `${AR.format(active)} نشط من ${AR.format(n)}` : `${AR.format(n)} عنصر`) : '';
}

function renderAll() {
  $('jobs').innerHTML = '';
  [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt).forEach(renderJob);
  updateEmpty();
}

/* ===================== الأحداث الحية ===================== */

function applyJobs(list) {
  jobs.clear();
  for (const j of list) jobs.set(j.id, j);
  renderAll();
}

function applySniff(s) {
  media.clear();
  for (const m of s.items) media.set(m.url, m);
  if (s.active || s.items.length) {
    $('sniffPanel').hidden = false;
    $('sniffPulse').classList.toggle('off', !s.active);
    $('sniffStatus').textContent = s.active
      ? 'المتصفح يعمل داخل الأداة — سجّل دخولك وشغّل الفيديو'
      : 'توقّف الاستخراج — هذه آخر الروابط الملتقطة';
    if (s.active && s.view) startView();
    else if (!s.active) stopView();
    renderMedia();
  }
}

/* ---- استطلاع احتياطي ----
   بعض الوسطاء (Cloudflare عبر النفق) يخزّنون بث SSE مؤقتًا فلا يصل شيء،
   فتبدو الواجهة جامدة والتحميل يعمل خلف الكواليس. هنا نستطلع بدلًا منه. */
let sseAlive = false;
let pollTimer = null;

async function pollState() {
  try {
    const s = await api('/api/state');
    applyJobs(s.jobs);
    applySniff(s.sniff);
  } catch {
    /* المحاولة القادمة */
  }
}

function startPolling(reason) {
  if (pollTimer) return;
  console.info('[dawn] تعذّر البث المباشر — التحوّل للاستطلاع:', reason);
  pollTimer = setInterval(pollState, 1500);
  pollState();
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function markSSEAlive() {
  if (sseAlive) return;
  sseAlive = true;
  stopPolling();
}

function connectEvents() {
  const es = new EventSource('/api/events');

  // إن لم يصل أي شيء خلال ٤ ثوانٍ نعتبر البث محجوبًا ونستطلع
  setTimeout(() => {
    if (!sseAlive) startPolling('لا استجابة خلال ٤ ثوانٍ');
  }, 4000);

  es.addEventListener('snapshot', (e) => {
    markSSEAlive();
    applyJobs(JSON.parse(e.data));
  });

  es.addEventListener('job', (e) => {
    markSSEAlive();
    const j = JSON.parse(e.data);
    const prev = jobs.get(j.id);
    jobs.set(j.id, j);
    renderJob(j);
    if (prev && prev.status !== 'done' && j.status === 'done') {
      toast(`اكتمل: ${j.title && j.title !== j.url ? j.title : 'التحميل'}`, 'ok');
    }
  });

  es.addEventListener('sniff-snapshot', (e) => {
    markSSEAlive();
    applySniff(JSON.parse(e.data));
  });

  es.addEventListener('sniff-reset', () => { media.clear(); renderMedia(); });

  es.addEventListener('sniff-media', (e) => {
    markSSEAlive();
    const m = JSON.parse(e.data);
    const isNew = !media.has(m.url);
    media.set(m.url, m);
    renderMedia();
    if (isNew) toast(`التُقط رابط فيديو (${m.kind})`, 'ok');
  });

  es.addEventListener('sniff-status', (e) => {
    const s = JSON.parse(e.data);
    $('sniffStatus').textContent = s.message;
    $('sniffPulse').classList.toggle('off', !s.active);
  });

  es.addEventListener('toast', (e) => {
    const t = JSON.parse(e.data);
    toast(t.message, t.type);
    loadHealth();
  });

  es.onerror = () => {
    // المتصفح يعيد المحاولة تلقائيًا، لكن قد يكون البث محجوبًا كليًا
    sseAlive = false;
    startPolling('انقطع البث');
  };
}

/* ===================== الإعدادات ===================== */
async function openSettings() {
  settings = await api('/api/settings');
  $('setDir').value = settings.downloadDir || '';
  $('setConc').value = settings.concurrency;
  $('setFrag').value = settings.fragments;
  $('setMeta').checked = !!settings.embedMetadata;
  $('setRestrict').checked = !!settings.restrictFilenames;

  $('toolsStatus').innerHTML = `
    <div class="row"><span class="${health.ytdlp ? 'ok' : 'bad'}">${health.ytdlp ? '✓' : '✕'}</span>
      <span>yt-dlp ${health.ytdlpVersion ? esc(health.ytdlpVersion) : ''}</span></div>
    <code>${esc(health.ytdlpPath || 'pip install -U yt-dlp')}</code>
    <div class="row"><span class="${health.ffmpeg ? 'ok' : 'bad'}">${health.ffmpeg ? '✓' : '✕'}</span>
      <span>ffmpeg — لازم لدمج الصوت والصورة وتحويل الصيغ</span></div>
    <code>${esc(health.ffmpegPath || 'brew install ffmpeg')}</code>`;

  $('settingsOverlay').hidden = false;
}

async function saveSettings() {
  try {
    settings = await api('/api/settings', {
      downloadDir: $('setDir').value,
      concurrency: $('setConc').value,
      fragments: $('setFrag').value,
      embedMetadata: $('setMeta').checked,
      restrictFilenames: $('setRestrict').checked,
    });
    $('settingsOverlay').hidden = true;
    toast('تم حفظ الإعدادات', 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

/* ===================== الربط ===================== */
function autoGrow() {
  const ta = $('url');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 190) + 'px';
}

function bind() {
  $('btnAnalyze').addEventListener('click', analyze);
  $('btnSniff').addEventListener('click', startSniff);
  $('btnSniffStop').addEventListener('click', stopSniff);
  $('btnDownload').addEventListener('click', () => download());
  $('btnFormats').addEventListener('click', renderFormats);
  $('btnClear').addEventListener('click', async () => {
    await api('/api/clear', {});
    jobs.clear();
    renderAll();
  });
  $('btnFolder').addEventListener('click', () => api('/api/open', {}).catch(() => {}));
  $('btnSettings').addEventListener('click', openSettings);
  $('btnCloseSettings').addEventListener('click', () => ($('settingsOverlay').hidden = true));
  $('btnSaveSettings').addEventListener('click', saveSettings);
  $('settingsOverlay').addEventListener('click', (e) => {
    if (e.target === $('settingsOverlay')) $('settingsOverlay').hidden = true;
  });
  $('btnUpdateYtdlp').addEventListener('click', async () => {
    toast('جارٍ التحديث…');
    try { await api('/api/update-ytdlp', {}); } catch (e) { toast(e.message, 'error'); }
  });

  $('btnPaste').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) { $('url').value = text.trim(); autoGrow(); analyze(); }
    } catch { toast('امنح الإذن بقراءة الحافظة، أو الصق يدويًا (⌘V)', 'error'); }
  });

  $('btnMulti').addEventListener('click', () => {
    $('url').rows = 4;
    $('url').placeholder = 'ضع كل رابط في سطر مستقل…';
    $('url').focus();
    autoGrow();
  });

  document.querySelectorAll('#modeSeg .seg').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#modeSeg .seg').forEach((b) => b.classList.toggle('on', b === btn));
      const audio = btn.dataset.mode === 'audio';
      $('qualityGroup').hidden = audio;
      $('audioGroup').hidden = !audio;
    });
  });

  $('optCookies').addEventListener('change', (e) => ($('cookiesRow').hidden = !e.target.checked));
  $('optTrim').addEventListener('change', (e) => ($('trimRow').hidden = !e.target.checked));
  $('optReferer').addEventListener('change', (e) => ($('refererRow').hidden = !e.target.checked));
  $('optPlaylist').addEventListener('change', () => { if (info) analyze(); });

  const ta = $('url');
  ta.addEventListener('input', autoGrow);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && ta.rows === 1) { e.preventDefault(); analyze(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); analyze(); }
  });
  ta.addEventListener('paste', () => setTimeout(() => {
    if (urlsFromInput().length === 1 && ta.rows === 1) analyze();
  }, 60));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('settingsOverlay').hidden = true;
    if ((e.metaKey || e.ctrlKey) && e.key === 'v' && document.activeElement !== ta) ta.focus();
  });
}

/* ===================== الإقلاع ===================== */
bind();
bindView();
loadHealth();
connectEvents();
$('url').focus();
