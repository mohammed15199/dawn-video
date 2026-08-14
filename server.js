#!/usr/bin/env node
'use strict';

/**
 * دَون فيديو — أداة تحميل الفيديوهات من أي موقع
 * خادم محلي بدون أي اعتماديات خارجية (Node.js فقط) يقود yt-dlp.
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { randomUUID, timingSafeEqual } = require('crypto');
const { Sniffer, findBrowser } = require('./sniffer');

const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const CONFIG_PATH = path.join(APP_DIR, 'config.json');
// على خادم بعيد نستمع على كل الواجهات؛ محليًا نبقى على 127.0.0.1 فقط
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 5178);
const IS_REMOTE = HOST !== '127.0.0.1' && HOST !== 'localhost';

// ---------------------------------------------------------------- إعدادات ---

const DEFAULT_CONFIG = {
  downloadDir: process.env.DAWN_DIR || path.join(os.homedir(), 'Downloads', 'DawnVideo'),
  concurrency: 2,
  fragments: 4,
  embedMetadata: true,
  restrictFilenames: false,
};

let config = { ...DEFAULT_CONFIG };

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    config = { ...DEFAULT_CONFIG, ...raw };
  } catch {
    /* أول تشغيل — نستخدم الافتراضي */
  }
  // متغيّر البيئة الصريح يتقدّم على الملف المحفوظ — مهم داخل الحاويات
  if (process.env.DAWN_DIR) config.downloadDir = process.env.DAWN_DIR;
  config.concurrency = clamp(Number(config.concurrency) || 2, 1, 6);
  config.fragments = clamp(Number(config.fragments) || 4, 1, 16);
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// ------------------------------------------------------- تحديد أماكن الأدوات ---

const EXTRA_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/opt/local/bin',
  path.join(os.homedir(), '.local', 'bin'),
  '/Library/Frameworks/Python.framework/Versions/3.13/bin',
  '/Library/Frameworks/Python.framework/Versions/3.12/bin',
];

// نوسّع PATH حتى لو شُغّل الخادم من بيئة رسومية بـ PATH فقير
process.env.PATH = [...new Set([...(process.env.PATH || '').split(':'), ...EXTRA_PATHS])]
  .filter(Boolean)
  .join(':');

function resolveBin(name) {
  for (const dir of process.env.PATH.split(':')) {
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* التالي */
    }
  }
  return null;
}

const tools = { ytdlp: null, ffmpeg: null, ytdlpVersion: null };

function refreshTools() {
  tools.ytdlp = resolveBin('yt-dlp');
  tools.ffmpeg = resolveBin('ffmpeg');
  if (tools.ytdlp) {
    execFile(tools.ytdlp, ['--version'], { timeout: 10000 }, (err, stdout) => {
      if (!err) tools.ytdlpVersion = String(stdout).trim();
    });
  }
}

// ---------------------------------------------------------- مخزن المهام ---

/** @type {Map<string, any>} */
const jobs = new Map();
/** @type {string[]} */
const queue = [];
/** @type {Map<string, import('child_process').ChildProcess>} */
const procs = new Map();
/** @type {Set<http.ServerResponse>} */
const clients = new Set();

/** متصفح مستقلّ لكل مستخدم — منفذ تنقيح وملف تعريف خاصّان */
const sniffers = new Map();

function snifferFor(uid) {
  let s = sniffers.get(uid);
  if (!s) {
    s = new Sniffer({
      id: uid,
      port: 9333 + sniffers.size + 1,
      profileDir: path.join(STATE_DIR, 'browsers', uid),
      cookieFile: path.join(STATE_DIR, 'browsers', uid, 'cookies.txt'),
    });
    sniffers.set(uid, s);
  }
  return s;
}

const activeBrowsers = () => [...sniffers.values()].filter((s) => s.active).length;

function broadcast(event, data, uid) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    // لا يتسرّب حدث مستخدم إلى شاشة غيره
    if (uid && c.uid !== uid) continue;
    try {
      c.res.write(payload);
    } catch {
      clients.delete(c);
    }
  }
}

function publicJob(job) {
  const { proc, ...rest } = job;
  return rest;
}

function updateJob(job, patch) {
  Object.assign(job, patch);
  const now = Date.now();
  // نخفّف البث أثناء التقدّم فقط، أما تغيّر الحالة فيُبثّ فورًا
  if (patch.status === undefined && now - (job._lastEmit || 0) < 220) return;
  job._lastEmit = now;
  broadcast('job', publicJob(job), job.userId);
}

// --------------------------------------------------------- بناء أوامر yt-dlp ---

const QUALITY_MAP = {
  best: 'bv*+ba/b',
  '2160': 'bv*[height<=2160]+ba/b[height<=2160]/bv*+ba/b',
  '1440': 'bv*[height<=1440]+ba/b[height<=1440]/bv*+ba/b',
  '1080': 'bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b',
  '720': 'bv*[height<=720]+ba/b[height<=720]/bv*+ba/b',
  '480': 'bv*[height<=480]+ba/b[height<=480]/bv*+ba/b',
  '360': 'bv*[height<=360]+ba/b[height<=360]/bv*+ba/b',
  smallest: 'wv*+wa/w',
};

const SEP = ''; // فاصل لا يظهر في العناوين

function baseArgs(opts = {}) {
  const args = [
    '--no-warnings',
    '--ignore-config',
    '--no-color',
    '--retries',
    '10',
    '--fragment-retries',
    '10',
    '--socket-timeout',
    '20',
  ];
  if (opts.cookieFile) args.push('--cookies', opts.cookieFile);
  else if (opts.cookiesBrowser) args.push('--cookies-from-browser', opts.cookiesBrowser);
  if (opts.userAgent) args.push('--user-agent', opts.userAgent);
  if (opts.referer) args.push('--referer', opts.referer);
  if (opts.proxy) args.push('--proxy', opts.proxy);
  return args;
}

/**
 * يبني ترويسة Cookie من ملف Netscape للمضيف المطلوب.
 *
 * لماذا: عند تنزيل بث HLS يسلّم yt-dlp المهمة إلى ffmpeg، لكنه ينقل ترويسة
 * الكوكيز إلى جرّته الداخلية ولا يمرّرها إلى ffmpeg — فيرجع السيرفر 401.
 * الحل تمرير الكوكيز إلى ffmpeg صراحةً عبر ‎--downloader-args‎.
 */
function cookieHeaderFor(cookieFile, targetUrl) {
  let host;
  try {
    host = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return null;
  }

  let text;
  try {
    text = fs.readFileSync(cookieFile, 'utf8');
  } catch {
    return null;
  }

  const pairs = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 7) continue;
    const domain = f[0].replace(/^\./, '').toLowerCase();
    if (!(host === domain || host.endsWith('.' + domain))) continue;
    const name = f[5].trim();
    // نستبعد علامة الاقتباس المفردة حتى لا تكسر تحليل yt-dlp للوسيط
    const value = f[6].replace(/'/g, '').trim();
    if (name) pairs.push(`${name}=${value}`);
  }
  return pairs.length ? pairs.join('; ') : null;
}

/**
 * يحسب مدة بث HLS بجمع قيم ‎#EXTINF‎ من القائمة.
 * نحتاجها لأن ffmpeg يذكر الزمن المُنزَّل فقط دون النسبة.
 */
async function hlsDuration(url, cookieFile, referer) {
  try {
    const headers = {};
    if (cookieFile) {
      const c = cookieHeaderFor(cookieFile, url);
      if (c) headers.Cookie = c;
    }
    if (referer) headers.Referer = referer;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const text = await res.text();
    let total = 0;
    for (const m of text.matchAll(/#EXTINF:\s*([\d.]+)/g)) total += parseFloat(m[1]) || 0;
    return total > 0 ? total : null;
  } catch {
    return null;
  }
}

function buildDownloadArgs(job) {
  const o = job.options || {};

  // لاحقة تميّز الملف عند اختيار جودة/صيغة/مقطع محدّد، حتى لا يتخطّى yt-dlp
  // التحميل ظنًّا أن الملف موجود بينما المطلوب نسخة مختلفة.
  let suffix = '';
  if (o.mode !== 'audio' && o.quality && o.quality !== 'best') suffix += ' [%(height)sp]';
  if (o.formatId) suffix += ' [%(format_id)s]';
  if (o.sectionFrom || o.sectionTo) suffix += ' [clip]';

  // اسم صريح قادم من المستخرِج (اسم الدرس من مسار الرابط) يتغلّب على
  // عنوان yt-dlp، لأن المستخرِج العام يسمّي الملف "index" وما شابه.
  const explicit = o.outputTitle
    ? String(o.outputTitle).replace(/[/\\:*?"<>| -]/g, '-').trim().slice(0, 150)
    : null;

  const out = path.join(
    job.dir || config.downloadDir,
    o.playlist ? '%(playlist_title|)s' : '',
    explicit
      ? `${explicit.replace(/%/g, '%%')}${suffix}.%(ext)s`
      : `%(title).180B [%(id)s]${suffix}.%(ext)s`
  );

  const args = [
    ...baseArgs(o),
    '--newline',
    '--progress',
    '--no-simulate',
    '--print',
    `after_move:${SEP}FILE${SEP}%(filepath)s`,
    '--progress-template',
    [
      `download:${SEP}PROG${SEP}%(progress.status)s`,
      '%(progress.downloaded_bytes)s',
      '%(progress.total_bytes)s',
      '%(progress.total_bytes_estimate)s',
      '%(progress.speed)s',
      '%(progress.eta)s',
      '%(progress.fragment_index)s',
      '%(progress.fragment_count)s',
    ].join(SEP),
    '--progress-template',
    `postprocess:${SEP}PP${SEP}%(progress.postprocessor)s${SEP}%(progress.status)s`,
    '-o',
    out,
    '--concurrent-fragments',
    String(config.fragments),
    '--no-mtime',
  ];

  // البث المشفّر AES-128 يمرّ عبر ffmpeg، وهي لا ترث كوكيز yt-dlp
  if (o.cookieFile) {
    const header = cookieHeaderFor(o.cookieFile, job.url);
    if (header) args.push('--downloader-args', `ffmpeg_i:-headers 'Cookie: ${header}'`);
  }

  // ‎--print‎ يفرض الوضع الصامت فيكتم إحصاءات ffmpeg، فيبقى الشريط صفرًا
  // حتى نهاية التحميل. نُجبرها على الظهور لنقرأ التقدّم منها.
  args.push('--downloader-args', 'ffmpeg:-stats -loglevel info');

  if (config.restrictFilenames) args.push('--restrict-filenames');
  args.push(o.playlist ? '--yes-playlist' : '--no-playlist');
  if (o.playlist && o.playlistItems) args.push('--playlist-items', String(o.playlistItems));

  if (o.mode === 'audio') {
    args.push('-f', 'ba/b', '-x', '--audio-format', o.audioFormat || 'mp3', '--audio-quality', '0');
    if (config.embedMetadata && tools.ffmpeg) args.push('--embed-metadata', '--embed-thumbnail');
  } else {
    if (o.formatId) {
      // صيغة محدّدة اختارها المستخدم من الجدول
      args.push('-f', o.formatOnlyVideo ? `${o.formatId}+ba/${o.formatId}` : o.formatId);
    } else {
      args.push('-f', QUALITY_MAP[o.quality] || QUALITY_MAP.best);
    }
    if (tools.ffmpeg) {
      args.push('--merge-output-format', o.container || 'mp4');
      if (config.embedMetadata) args.push('--embed-metadata', '--embed-thumbnail');
      if (o.subs) {
        args.push('--write-subs', '--write-auto-subs', '--sub-langs', o.subLangs || 'ar.*,en.*');
        args.push('--convert-subs', 'srt');
        if (o.embedSubs) args.push('--embed-subs');
      }
    }
  }

  if (o.sectionFrom || o.sectionTo) {
    args.push('--download-sections', `*${o.sectionFrom || '0'}-${o.sectionTo || 'inf'}`);
    args.push('--force-keyframes-at-cuts');
  }

  args.push('--', job.url);
  return args;
}

// ------------------------------------------------------------ تنفيذ التحميل ---

function startJob(job) {
  if (!tools.ytdlp) {
    updateJob(job, { status: 'error', error: 'لم يتم العثور على yt-dlp في النظام.' });
    pump();
    return;
  }

  const args = buildDownloadArgs(job);
  updateJob(job, { status: 'running', phase: 'جارٍ البدء…', startedAt: Date.now() });

  const proc = spawn(tools.ytdlp, args, { cwd: job.dir || config.downloadDir });
  procs.set(job.id, proc);

  // مدة البث تُمكّننا من حساب النسبة من زمن ffmpeg
  if (/\.m3u8(\?|#|$)/i.test(job.url)) {
    const o = job.options || {};
    hlsDuration(job.url, o.cookieFile, o.referer).then((d) => {
      if (d) updateJob(job, { duration: d });
    });
  }

  let stderrTail = '';
  let stdoutBuf = '';
  let stderrBuf = '';

  const handleLine = (line) => {
    if (!line) return;

    if (line.startsWith(SEP + 'PROG' + SEP)) {
      const p = line.split(SEP);
      // [ , PROG, status, downloaded, total, totalEst, speed, eta, fragIdx, fragCount ]
      const num = (v) => {
        const n = Number(v);
        return Number.isFinite(n) && v !== 'NA' ? n : null;
      };
      const downloaded = num(p[3]);
      const total = num(p[4]) ?? num(p[5]);
      const speed = num(p[6]);
      const eta = num(p[7]);
      const fi = num(p[8]);
      const fc = num(p[9]);

      let percent = null;
      if (total && downloaded != null) percent = (downloaded / total) * 100;
      else if (fc && fi != null) percent = (fi / fc) * 100;

      updateJob(job, {
        percent: percent == null ? job.percent : clamp(percent, 0, 100),
        speed,
        eta,
        downloaded,
        total,
        phase: 'جارٍ التحميل',
      });
      return;
    }

    if (line.startsWith(SEP + 'PP' + SEP)) {
      const p = line.split(SEP);
      const name = p[2] && p[2] !== 'NA' ? p[2] : '';
      const label =
        /Merger/i.test(name) ? 'دمج الصوت والصورة…'
        : /ExtractAudio/i.test(name) ? 'استخراج الصوت…'
        : /Thumbnail|Metadata/i.test(name) ? 'إضافة البيانات…'
        : /Subtitle/i.test(name) ? 'معالجة الترجمات…'
        : 'معالجة نهائية…';
      updateJob(job, { phase: label, percent: 100, speed: null, eta: null });
      return;
    }

    if (line.startsWith(SEP + 'FILE' + SEP)) {
      const file = line.split(SEP)[2];
      if (file && file !== 'NA') {
        job.files = job.files || [];
        if (!job.files.includes(file)) job.files.push(file);
        updateJob(job, { files: job.files, file });
      }
      return;
    }

    // أسطر معلوماتية مفيدة
    const m = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (m && /Merger|ExtractAudio|Metadata|Thumbnail|EmbedSubtitle|Fixup/i.test(m[1])) {
      updateJob(job, { phase: 'معالجة نهائية…' });
    }
  };

  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split(/\r?\n/);
    stdoutBuf = lines.pop() || '';
    lines.forEach((l) => handleLine(l.trim()));
  });

  // ffmpeg يكتب تقدّمه على stderr مفصولًا بـ \r لا \n، بصيغة خاصة به
  const FF_PROGRESS = /size=\s*(\d+)\s*(KiB|kB|MiB)\s+time=(\d+):(\d+):([\d.]+)/i;
  let lastBytes = 0;
  let lastAt = 0;

  proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split(/[\r\n]+/);
    stderrBuf = lines.pop() || '';

    for (const l of lines) {
      const t = l.trim();
      if (!t) continue;

      const m = FF_PROGRESS.exec(t);
      if (m) {
        const unit = m[2].toLowerCase();
        const bytes = Number(m[1]) * (unit === 'mib' ? 1048576 : 1024);
        const mediaSec = Number(m[3]) * 3600 + Number(m[4]) * 60 + parseFloat(m[5]);

        const now = Date.now();
        let speed = job.speed;
        if (lastAt && now > lastAt) speed = ((bytes - lastBytes) * 1000) / (now - lastAt);
        lastBytes = bytes;
        lastAt = now;

        const percent = job.duration ? clamp((mediaSec / job.duration) * 100, 0, 99.5) : job.percent;
        const eta = job.duration && speed > 0 && percent > 0
          ? ((100 - percent) / percent) * ((now - (job.startedAt || now)) / 1000)
          : null;

        updateJob(job, {
          percent,
          downloaded: bytes,
          speed: speed > 0 ? speed : null,
          eta,
          mediaTime: mediaSec,
          phase: 'جارٍ التحميل',
        });
        continue;
      }

      stderrTail = (stderrTail + '\n' + t).split('\n').slice(-25).join('\n');
    }
  });

  proc.on('error', (err) => {
    updateJob(job, { status: 'error', error: err.message });
    procs.delete(job.id);
    pump();
  });

  proc.on('close', (code, signal) => {
    procs.delete(job.id);
    if (job.status === 'canceled') {
      broadcast('job', publicJob(job), job.userId);
      pump();
      return;
    }
    if (code === 0) {
      updateJob(job, {
        status: 'done',
        percent: 100,
        phase: 'اكتمل',
        speed: null,
        eta: null,
        finishedAt: Date.now(),
      });
    } else {
      updateJob(job, {
        status: 'error',
        phase: 'فشل',
        error: friendlyError(stderrTail) || `انتهى yt-dlp بالرمز ${code}${signal ? ` (${signal})` : ''}`,
        raw: stderrTail,
      });
    }
    broadcast('job', publicJob(job), job.userId);
    pump();
  });
}

function friendlyError(stderr) {
  if (!stderr) return null;
  const s = stderr.toLowerCase();
  if (s.includes('ffmpeg') && (s.includes('not installed') || s.includes('not found')))
    return 'يلزم تثبيت ffmpeg لدمج الصوت والصورة. نفّذ: brew install ffmpeg';
  if (s.includes('sign in to confirm') || s.includes('confirm your age') || s.includes('login required') || s.includes('private video'))
    return 'الفيديو يتطلّب تسجيل دخول — فعّل خيار «استخدام كوكيز المتصفح» واختر متصفحك.';
  if (s.includes('unsupported url'))
    return 'هذه الصفحة لا تحتوي على فيديو في مصدرها — غالبًا موقع يبني محتواه بجافاسكربت بعد تسجيل الدخول. '
      + 'افتح الدرس في المتصفح، ثم أدوات المطوّر (⌥⌘I) ← تبويب Network ← اكتب m3u8 أو mp4 في الفلتر، '
      + 'شغّل الفيديو، وانسخ الرابط الظاهر والصقه هنا. فعّل «كوكيز المتصفح» و«رابط الإحالة» إن رفض التحميل.';
  if (s.includes('video unavailable') || s.includes('this video is not available'))
    return 'الفيديو غير متاح (محذوف أو محجوب في منطقتك).';
  if (s.includes('http error 403')) return 'رُفض الوصول (403). جرّب كوكيز المتصفح أو رابطًا آخر.';
  if (s.includes('http error 404')) return 'الرابط غير موجود (404).';
  if (s.includes('requested format is not available'))
    return 'الجودة المطلوبة غير متوفّرة لهذا الفيديو — اختر «أفضل جودة متاحة».';
  if (s.includes('name or service not known') || s.includes('temporary failure in name resolution') || s.includes('failed to resolve'))
    return 'تعذّر الاتصال بالإنترنت.';
  if (s.includes('connection reset') || s.includes('connection aborted') || s.includes('connection refused'))
    return 'الموقع أغلق الاتصال. جرّب مرة أخرى، أو فعّل «كوكيز المتصفح» إن كان يتطلّب تسجيل دخول.';
  if (s.includes('unable to extract') || s.includes('no video formats found'))
    return 'تعذّر استخراج فيديو من هذه الصفحة. تأكد أن الرابط يفتح فيديو مباشرة، أو حدّث yt-dlp من الإعدادات.';
  const line = stderr.split('\n').reverse().find((l) => /^ERROR/i.test(l.trim()));
  return line ? line.replace(/^ERROR:\s*/i, '').trim() : stderr.split('\n').slice(-1)[0];
}

function pump() {
  const running = [...jobs.values()].filter((j) => j.status === 'running').length;
  let slots = config.concurrency - running;
  while (slots > 0 && queue.length) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (!job || job.status !== 'queued') continue;
    startJob(job);
    slots--;
  }
}

// ------------------------------------------------------------ جلب المعلومات ---

function ytdlpJSON(args, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    if (!tools.ytdlp) return reject(new Error('لم يتم العثور على yt-dlp'));
    execFile(
      tools.ytdlp,
      args,
      { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const text = String(stdout || '').trim();
        if (!text) return reject(new Error(friendlyError(stderr) || (err && err.message) || 'لا توجد نتيجة'));
        let parsed = null;
        try {
          parsed = JSON.parse(text.split('\n')[0]);
        } catch {
          return reject(new Error(friendlyError(stderr) || 'تعذّر قراءة معلومات الفيديو'));
        }
        // yt-dlp قد يطبع null وينهي بالرمز 0 عند فشل الاستخراج
        if (!parsed || typeof parsed !== 'object') {
          return reject(new Error(friendlyError(stderr) || 'تعذّر استخراج أي فيديو من هذا الرابط'));
        }
        resolve(parsed);
      }
    );
  });
}

function summarizeFormats(info) {
  const list = Array.isArray(info.formats) ? info.formats : [];
  const video = [];
  const audio = [];

  for (const f of list) {
    const hasV = f.vcodec && f.vcodec !== 'none';
    const hasA = f.acodec && f.acodec !== 'none';
    const size = f.filesize || f.filesize_approx || null;
    if (hasV) {
      video.push({
        id: f.format_id,
        ext: f.ext,
        height: f.height || null,
        fps: f.fps ? Math.round(f.fps) : null,
        vcodec: (f.vcodec || '').split('.')[0],
        acodec: hasA ? (f.acodec || '').split('.')[0] : null,
        muxed: !!hasA,
        size,
        note: f.format_note || '',
        tbr: f.tbr ? Math.round(f.tbr) : null,
      });
    } else if (hasA) {
      audio.push({
        id: f.format_id,
        ext: f.ext,
        abr: f.abr ? Math.round(f.abr) : null,
        acodec: (f.acodec || '').split('.')[0],
        size,
        note: f.format_note || '',
      });
    }
  }

  video.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0));
  audio.sort((a, b) => (b.abr || 0) - (a.abr || 0));

  const heights = [...new Set(video.map((v) => v.height).filter(Boolean))].sort((a, b) => b - a);
  return { video: video.slice(0, 60), audio: audio.slice(0, 20), heights };
}

// ------------------------------------------------------------------- HTTP ---

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) {
        reject(new Error('الطلب كبير جدًا'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('JSON غير صالح'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.replace(/^\/+/, ''));
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('غير موجود');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/**
 * حماية بكلمة مرور — تُفعَّل بضبط DAWN_PASSWORD.
 *
 * تُطبَّق على كل المسارات بلا استثناء: عند التشغيل عبر نفق (Cloudflare مثلًا)
 * تصل الطلبات من 127.0.0.1، فلا يصحّ اعتبار «المحلي» موثوقًا.
 */
// ---------------------------------------------------------- المستخدمون ---

const STATE_DIR = process.env.DAWN_STATE_DIR || config.downloadDir;
const USERS_PATH = path.join(STATE_DIR, 'users.json');
const OWNER_ID = 'owner';
const MAX_BROWSERS = Number(process.env.DAWN_MAX_BROWSERS || 2);

/** @type {Map<string, {id,name,key,createdAt}>} */
const users = new Map();

function loadUsers() {
  try {
    const raw = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
    for (const u of raw.users || []) users.set(u.id, u);
  } catch {
    /* أول تشغيل */
  }
}

function saveUsers() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(USERS_PATH, JSON.stringify({ users: [...users.values()] }, null, 2), {
    mode: 0o600,
  });
}

function userByKey(key) {
  if (!key) return null;
  const given = Buffer.from(String(key), 'utf8');
  for (const u of users.values()) {
    const b = Buffer.from(u.key, 'utf8');
    if (given.length === b.length && timingSafeEqual(given, b)) return u;
  }
  return null;
}

/** مجلد تحميل خاص بكل مستخدم — لا يرى أحد ملفات غيره */
function userDir(uid) {
  return uid === OWNER_ID ? config.downloadDir : path.join(config.downloadDir, 'u', uid);
}

/** جلسات صالحة في الذاكرة: الرمز → معرّف المستخدم */
const sessions = new Map();

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function passwordOK(given) {
  const pass = process.env.DAWN_PASSWORD;
  if (!pass) return true;
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(pass, 'utf8');
  // المقارنة الثابتة الزمن تتطلّب طولًا متساويًا، والطول ليس سرًّا هنا
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** يرجع معرّف المستخدم صاحب الطلب، أو null إن لم يكن مصرّحًا له */
function whoIs(req) {
  if (!process.env.DAWN_PASSWORD) return OWNER_ID; // استخدام محلي بلا كلمة مرور

  const token = parseCookies(req).dawn_session;
  if (token && sessions.has(token)) return sessions.get(token);

  // Basic مقبولة أيضًا لتسهيل الاستخدام من الطرفية (curl)
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (m) {
    try {
      const decoded = Buffer.from(m[1], 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      const secret = i >= 0 ? decoded.slice(i + 1) : '';
      if (passwordOK(secret)) return OWNER_ID;
      const u = userByKey(secret);
      if (u) return u.id;
    } catch {
      /* غير صالح */
    }
  }
  return null;
}

const isHttpUrl = (u) => {
  try {
    const p = new URL(String(u).trim());
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  // مسارات الدخول متاحة قبل البوابة
  if (p === '/api/login' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const secret = body.password;

    let uid = null;
    if (passwordOK(secret)) uid = OWNER_ID;
    else {
      const u = userByKey(secret);
      if (u) uid = u.id;
    }
    if (!uid) return sendJSON(res, 401, { error: 'كلمة المرور أو مفتاح الدخول غير صحيح' });

    const token = randomUUID() + randomUUID();
    sessions.set(token, uid);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.writeHead(200, {
      'Set-Cookie': `dawn_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800${secure}`,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (p === '/login') {
    const key = url.searchParams.get('key');
    if (key) {
      const u = userByKey(key);
      if (u) {
        const token = randomUUID() + randomUUID();
        sessions.set(token, u.id);
        const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        res.writeHead(302, {
          Location: '/',
          'Set-Cookie': `dawn_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800${secure}`,
          'Cache-Control': 'no-store',
        });
        return res.end();
      }
    }
    if (!process.env.DAWN_PASSWORD) {
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    return serveStatic(req, res, '/login.html');
  }

  const uid = whoIs(req);
  if (!uid) {
    // التصفّح العادي يُحوَّل لصفحة الدخول؛ لا نستخدم نافذة Basic لأن
    // تضمين البيانات في الرابط يعطّل كل طلبات fetch في الصفحة.
    if (String(req.headers.accept || '').includes('text/html')) {
      res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
      return res.end();
    }
    return sendJSON(res, 401, { error: 'غير مصرّح' });
  }
  const isOwner = uid === OWNER_ID;
  const sniffer = snifferFor(uid);
  const myDir = userDir(uid);

  try {
    // ------------------------------------------------------------- SSE ---
    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      // حشوة أولية تدفع الوسطاء لتمرير البث بدل تخزينه مؤقتًا
      res.write(':' + ' '.repeat(2048) + '\n\n');
      res.write(': connected\n\n');
      const mine = () => [...jobs.values()].filter((j) => j.userId === uid).map(publicJob);
      res.write(`event: snapshot\ndata: ${JSON.stringify(mine())}\n\n`);
      res.write(
        `event: sniff-snapshot\ndata: ${JSON.stringify({
          active: sniffer.active,
          items: sniffer.list(),
        })}\n\n`
      );
      const client = { res, uid };
      clients.add(client);
      const ka = setInterval(() => {
        try {
          res.write(': ka\n\n');
        } catch {
          /* ignore */
        }
      }, 20000);
      req.on('close', () => {
        clearInterval(ka);
        clients.delete(client);
      });
      return;
    }

    // بديل عن SSE: بعض الوسطاء (Cloudflare مثلًا) يخزّنون البث المستمر
    // مؤقتًا فلا يصل شيء. الواجهة تستطلع هذا المسار عندئذٍ.
    // سحب ملف مكتمل إلى جهاز المستخدم — ضروري عند التشغيل على خادم بعيد
    if (p === '/api/file') {
      const want = url.searchParams.get('path') || '';
      const target = path.resolve(want);
      const root = path.resolve(myDir);

      // منع الخروج خارج مجلد التحميلات (path traversal)
      if (target !== root && !target.startsWith(root + path.sep)) {
        return sendJSON(res, 403, { error: 'مسار غير مسموح' });
      }

      let stat;
      try {
        stat = fs.statSync(target);
        if (!stat.isFile()) throw new Error('ليس ملفًا');
      } catch {
        return sendJSON(res, 404, { error: 'الملف غير موجود' });
      }

      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition':
          `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`,
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(target).pipe(res);
      return;
    }

    if (p === '/api/state') {
      return sendJSON(res, 200, {
        jobs: [...jobs.values()].filter((j) => j.userId === uid).map(publicJob),
        sniff: {
          active: sniffer.active,
          items: sniffer.list(),
          view: sniffer.frame ? { w: sniffer.frame.w, h: sniffer.frame.h } : null,
        },
      });
    }

    if (p === '/api/users') {
      if (!isOwner) return sendJSON(res, 403, { error: 'للمالك فقط' });

      if (req.method === 'POST') {
        const body = await readBody(req);
        const name = String(body.name || '').trim().slice(0, 40);
        if (!name) return sendJSON(res, 400, { error: 'اكتب اسمًا' });
        const u = {
          id: randomUUID().slice(0, 8),
          name,
          key: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 8),
          createdAt: Date.now(),
        };
        users.set(u.id, u);
        saveUsers();
        return sendJSON(res, 200, { user: u });
      }

      if (req.method === 'DELETE') {
        const body = await readBody(req);
        const u = users.get(String(body.id || ''));
        if (!u) return sendJSON(res, 404, { error: 'غير موجود' });
        users.delete(u.id);
        saveUsers();
        // نُنهي جلساته الحالية فورًا
        for (const [tok, owner] of [...sessions]) if (owner === u.id) sessions.delete(tok);
        const s2 = sniffers.get(u.id);
        if (s2) { Promise.resolve(s2.stop()).catch(() => {}); sniffers.delete(u.id); }
        return sendJSON(res, 200, { ok: true });
      }

      return sendJSON(res, 200, { users: [...users.values()] });
    }

    if (p === '/api/health') {
      refreshTools();
      return sendJSON(res, 200, {
        ytdlp: !!tools.ytdlp,
        ytdlpPath: tools.ytdlp,
        ytdlpVersion: tools.ytdlpVersion,
        ffmpeg: !!tools.ffmpeg,
        ffmpegPath: tools.ffmpeg,
        browser: findBrowser()?.name || null,
        downloadDir: myDir,
        platform: process.platform,
        user: { id: uid, owner: isOwner, name: users.get(uid)?.name || 'المالك' },
        remote: IS_REMOTE, // الواجهة تعرض «حفظ على جهازي» بدل «إظهار في المجلد»
      });
    }

    if (p === '/api/settings' && req.method === 'GET') {
      return sendJSON(res, 200, config);
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      if (typeof body.downloadDir === 'string' && body.downloadDir.trim()) {
        let dir = body.downloadDir.trim();
        if (dir.startsWith('~')) dir = path.join(os.homedir(), dir.slice(1));
        config.downloadDir = path.resolve(dir);
      }
      if (body.concurrency != null) config.concurrency = clamp(Number(body.concurrency) || 2, 1, 6);
      if (body.fragments != null) config.fragments = clamp(Number(body.fragments) || 4, 1, 16);
      if (body.embedMetadata != null) config.embedMetadata = !!body.embedMetadata;
      if (body.restrictFilenames != null) config.restrictFilenames = !!body.restrictFilenames;
      await fsp.mkdir(config.downloadDir, { recursive: true });
      saveConfig();
      pump();
      return sendJSON(res, 200, config);
    }

    // ------------------------------------------- استخراج الفيديو من الموقع ---
    if (p === '/api/sniff/start' && req.method === 'POST') {
      const body = await readBody(req);
      const target = String(body.url || '').trim();
      if (!isHttpUrl(target)) return sendJSON(res, 400, { error: 'رابط غير صالح' });

      if (!sniffer.active && activeBrowsers() >= MAX_BROWSERS) {
        return sendJSON(res, 429, {
          error: `الحد الأقصى ${MAX_BROWSERS} متصفح في وقت واحد. انتظر حتى ينهي مستخدم آخر استخراجه.`,
        });
      }
      sniffer.clear();
      broadcast('sniff-reset', {}, uid);
      const info = await sniffer.start(target, {
        embedded: body.embedded !== false, // العرض المدمج هو الافتراضي
        onMedia: (item) => broadcast('sniff-media', item, uid),
        onStatus: (message) => broadcast('sniff-status', { message, active: sniffer.active }, uid),
      });
      return sendJSON(res, 200, { ok: true, ...info });
    }

    if (p === '/api/sniff/frame') {
      const f = sniffer.frame;
      if (!f) return sendJSON(res, 404, { error: 'لا يوجد إطار بعد' });
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': f.buf.length,
        'Cache-Control': 'no-store',
        'X-Frame-W': String(f.w),
        'X-Frame-H': String(f.h),
      });
      return res.end(f.buf);
    }

    if (p === '/api/sniff/input' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        await sniffer.input(body);
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/sniff/stop' && req.method === 'POST') {
      await sniffer.stop();
      broadcast('sniff-status', { message: 'توقّف الاستخراج', active: false }, uid);
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/sniff/list') {
      return sendJSON(res, 200, {
        active: sniffer.active,
        items: sniffer.list(),
        browser: findBrowser()?.name || null,
      });
    }

    if (p === '/api/sniff/cookies' && req.method === 'POST') {
      const body = await readBody(req);
      const file = await sniffer.exportCookies(body.url || null);
      return sendJSON(res, 200, { cookieFile: file });
    }

    if (p === '/api/info' && req.method === 'POST') {
      const body = await readBody(req);
      const target = String(body.url || '').trim();
      if (!isHttpUrl(target)) return sendJSON(res, 400, { error: 'رابط غير صالح' });

      const args = [...baseArgs(body), '-J'];
      args.push(body.playlist ? '--flat-playlist' : '--no-playlist');
      args.push('--', target);

      const info = await ytdlpJSON(args);

      if (info._type === 'playlist') {
        return sendJSON(res, 200, {
          kind: 'playlist',
          title: info.title || 'قائمة تشغيل',
          uploader: info.uploader || info.channel || '',
          count: info.playlist_count || (info.entries || []).length,
          thumbnail: info.thumbnails?.slice(-1)[0]?.url || null,
          webpage_url: info.webpage_url || target,
          extractor: info.extractor_key || info.extractor || '',
          entries: (info.entries || []).slice(0, 200).map((e) => ({
            title: e.title || e.id,
            duration: e.duration || null,
            url: e.url || e.webpage_url || null,
          })),
        });
      }

      const fmts = summarizeFormats(info);
      return sendJSON(res, 200, {
        kind: 'video',
        id: info.id,
        title: info.title || 'بدون عنوان',
        uploader: info.uploader || info.channel || info.extractor_key || '',
        duration: info.duration || null,
        thumbnail: info.thumbnail || info.thumbnails?.slice(-1)[0]?.url || null,
        webpage_url: info.webpage_url || target,
        extractor: info.extractor_key || info.extractor || '',
        isLive: !!info.is_live,
        viewCount: info.view_count || null,
        ...fmts,
      });
    }

    if (p === '/api/enqueue' && req.method === 'POST') {
      const body = await readBody(req);
      const urls = (Array.isArray(body.urls) ? body.urls : [body.url])
        .map((u) => String(u || '').trim())
        .filter(Boolean);

      const valid = urls.filter(isHttpUrl);
      if (!valid.length) return sendJSON(res, 400, { error: 'لا يوجد رابط صالح' });

      await fsp.mkdir(myDir, { recursive: true });

      const created = [];
      for (const u of valid) {
        const job = {
          id: randomUUID(),
          userId: uid,
          dir: myDir,
          url: u,
          title: body.title && valid.length === 1 ? body.title : u,
          thumbnail: valid.length === 1 ? body.thumbnail || null : null,
          status: 'queued',
          percent: 0,
          phase: 'في الانتظار',
          speed: null,
          eta: null,
          files: [],
          error: null,
          options: {
            mode: body.mode === 'audio' ? 'audio' : 'video',
            quality: body.quality || 'best',
            formatId: body.formatId || null,
            formatOnlyVideo: !!body.formatOnlyVideo,
            audioFormat: body.audioFormat || 'mp3',
            container: body.container || 'mp4',
            playlist: !!body.playlist,
            playlistItems: body.playlistItems || null,
            subs: !!body.subs,
            embedSubs: body.embedSubs !== false,
            subLangs: body.subLangs || 'ar.*,en.*',
            cookiesBrowser: body.cookiesBrowser || null,
            cookieFile: body.cookieFile || null,
            outputTitle: body.outputTitle || null,
            referer: body.referer || null,
            sectionFrom: body.sectionFrom || null,
            sectionTo: body.sectionTo || null,
            proxy: body.proxy || null,
          },
          createdAt: Date.now(),
        };
        jobs.set(job.id, job);
        queue.push(job.id);
        created.push(publicJob(job));
        broadcast('job', publicJob(job), job.userId);
      }
      pump();
      return sendJSON(res, 200, { jobs: created });
    }

    if (p === '/api/cancel' && req.method === 'POST') {
      const { id } = await readBody(req);
      const job = jobs.get(id);
      if (!job || job.userId !== uid) return sendJSON(res, 404, { error: 'غير موجود' });
      const idx = queue.indexOf(id);
      if (idx >= 0) queue.splice(idx, 1);
      const proc = procs.get(id);
      updateJob(job, { status: 'canceled', phase: 'أُلغي', speed: null, eta: null });
      if (proc) proc.kill('SIGTERM');
      broadcast('job', publicJob(job), job.userId);
      pump();
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/retry' && req.method === 'POST') {
      const { id } = await readBody(req);
      const job = jobs.get(id);
      if (!job || job.userId !== uid) return sendJSON(res, 404, { error: 'غير موجود' });
      if (job.status === 'running') return sendJSON(res, 400, { error: 'قيد التنفيذ' });
      updateJob(job, { status: 'queued', phase: 'في الانتظار', percent: 0, error: null, files: [] });
      queue.push(job.id);
      broadcast('job', publicJob(job), job.userId);
      pump();
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/clear' && req.method === 'POST') {
      for (const [id, j] of [...jobs]) {
        if (j.userId !== uid) continue;
        if (j.status !== 'running' && j.status !== 'queued') jobs.delete(id);
      }
      broadcast('snapshot', [...jobs.values()].filter((j) => j.userId === uid).map(publicJob), uid);
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/open' && req.method === 'POST') {
      const body = await readBody(req);
      let target = body.path ? String(body.path) : myDir;
      const reveal = !!body.reveal;
      if (!fs.existsSync(target)) target = myDir;
      await fsp.mkdir(myDir, { recursive: true });
      const args = process.platform === 'darwin'
        ? (reveal ? ['-R', target] : [target])
        : [target];
      const opener = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'explorer'
        : 'xdg-open';
      execFile(opener, args, () => {});
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/update-ytdlp' && req.method === 'POST') {
      if (!tools.ytdlp) return sendJSON(res, 400, { error: 'yt-dlp غير مثبّت' });
      execFile(tools.ytdlp, ['-U'], { timeout: 180000 }, (err, stdout, stderr) => {
        refreshTools();
        broadcast('toast', {
          type: err ? 'error' : 'ok',
          message: err
            ? 'تعذّر التحديث تلقائيًا. جرّب: pip install -U yt-dlp'
            : String(stdout || stderr).trim().split('\n').slice(-1)[0] || 'تم التحديث',
        });
      });
      return sendJSON(res, 200, { ok: true, started: true });
    }

    if (p.startsWith('/api/')) return sendJSON(res, 404, { error: 'مسار غير معروف' });

    return serveStatic(req, res, p);
  } catch (err) {
    return sendJSON(res, 500, { error: err.message || 'خطأ داخلي' });
  }
});

// ------------------------------------------------------------------ إقلاع ---

loadConfig();
loadUsers();
refreshTools();
fs.mkdirSync(config.downloadDir, { recursive: true });

// الاستماع على كل الواجهات بلا كلمة مرور يعني أداة تحميل مفتوحة للإنترنت
if (IS_REMOTE && !process.env.DAWN_PASSWORD) {
  console.error('\n  \x1b[31mرُفض التشغيل:\x1b[0m الاستماع على ' + HOST + ' بلا كلمة مرور.');
  console.error('  اضبط DAWN_PASSWORD قبل التشغيل على خادم بعيد.\n');
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log('');
  console.log('  \x1b[1m\x1b[36mدَون فيديو\x1b[0m — أداة تحميل الفيديوهات');
  console.log(`  \x1b[32m▸\x1b[0m الواجهة:  \x1b[4m${url}\x1b[0m`);
  console.log(`  \x1b[32m▸\x1b[0m المجلد:   ${config.downloadDir}`);
  console.log(`  \x1b[32m▸\x1b[0m yt-dlp:   ${tools.ytdlp || '\x1b[31mغير موجود\x1b[0m'}`);
  console.log(`  \x1b[32m▸\x1b[0m ffmpeg:   ${tools.ffmpeg || '\x1b[33mغير موجود (brew install ffmpeg)\x1b[0m'}`);
  console.log('');
  if (process.env.NO_OPEN !== '1' && process.platform === 'darwin') {
    execFile('open', [url], () => {});
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  المنفذ ${PORT} مشغول. شغّل بمنفذ آخر:  PORT=5179 node server.js\n`);
    process.exit(1);
  }
  throw err;
});

function shutdown() {
  for (const proc of procs.values()) proc.kill('SIGTERM');
  for (const s of sniffers.values()) Promise.resolve(s.stop()).catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
