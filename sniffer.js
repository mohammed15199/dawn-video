'use strict';

/**
 * مستخرِج الفيديو — يفتح متصفح Chrome ويراقب طلبات الشبكة عبر
 * بروتوكول DevTools، فيلتقط روابط الفيديو التي لا تظهر في مصدر الصفحة
 * (المواقع المبنية بجافاسكربت، منصّات الدورات، البث المقطّع HLS).
 *
 * بدون أي حزمة npm — يعتمد على WebSocket المدمج في Node ١٨+.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const SUPPORT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'DawnVideo');
const PROFILE_DIR = path.join(SUPPORT_DIR, 'chrome-profile');
const COOKIE_FILE = path.join(SUPPORT_DIR, 'cookies.txt');
const CDP_PORT = Number(process.env.DAWN_CDP_PORT || 9333);

const BROWSERS = [
  // على الخوادم (Docker/Linux) يُضبط المسار بمتغيّر البيئة
  { name: 'Chromium', bin: process.env.CHROME_BIN || '' },
  { name: 'Google Chrome', bin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  { name: 'Brave', bin: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
  { name: 'Microsoft Edge', bin: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
  { name: 'Chromium', bin: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
  { name: 'Chromium', bin: '/usr/bin/chromium' },
  { name: 'Chromium', bin: '/usr/bin/chromium-browser' },
  { name: 'Google Chrome', bin: '/usr/bin/google-chrome' },
];

function findBrowser() {
  for (const b of BROWSERS) {
    if (!b.bin) continue;
    try {
      fs.accessSync(b.bin, fs.constants.X_OK);
      return b;
    } catch {
      /* التالي */
    }
  }
  return null;
}

// ------------------------------------------------------------ تصنيف الروابط ---

// ملفات القوائم والملفات المباشرة — هذه ما نعرضه للمستخدم
const PLAYLIST_RE = /\.(m3u8|mpd)(\?|#|$)/i;
const DIRECT_RE = /\.(mp4|webm|mkv|mov|m4v|flv|avi|m4a|mp3)(\?|#|$)/i;
// مقاطع البث — نتجاهلها، فهي أجزاء من قائمة سنحمّلها كاملة
const SEGMENT_RE = /\.(ts|m4s|aac)(\?|#|$)|[?&]range=|\bseg(ment)?[-_]?\d+/i;
const MEDIA_MIME_RE = /^(video|audio)\/|mpegurl|dash\+xml/i;

// شبكات الإعلانات — فيديوهاتها تلوّث النتائج وليست ما يريده المستخدم
const AD_HOSTS_RE = new RegExp(
  [
    '2mdn\\.net', 'doubleclick\\.net', 'googlesyndication\\.com', 'googleadservices\\.com',
    'adsafeprotected\\.com', 'imasdk\\.googleapis\\.com', 'moatads\\.com', 'innovid\\.com',
    'springserve\\.com', 'teads\\.tv', 'amazon-adsystem\\.com', 'adnxs\\.com',
    'scorecardresearch\\.com', 'serving-sys\\.com', 'spotxchange\\.com', 'rubiconproject\\.com',
    'flashtalking\\.com', 'adform\\.net', 'casalemedia\\.com', 'criteo\\.com',
    'taboola\\.com', 'outbrain\\.com', 'undertone\\.com', 'tremorhub\\.com', 'yieldmo\\.com',
  ].join('|'),
  'i'
);

// أسماء ملفات لا تدلّ على شيء — نأخذ اسم المجلد الأب بدلًا منها
const GENERIC_NAME_RE = /^(index|playlist|master|manifest|stream|video|media|out|chunklist)[-_]?\d*$/i;

/**
 * يستنتج اسمًا مفيدًا من مسار الرابط.
 * مثال: ".../1710971789451_01.01 أخلاقيات مهنة المحاسبة/index.m3u8"
 *   ← "01.01 أخلاقيات مهنة المحاسبة"
 */
function suggestName(url) {
  let segs;
  try {
    segs = new URL(url).pathname.split('/').filter(Boolean).map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  } catch {
    return null;
  }
  if (!segs.length) return null;

  let name = segs.pop().replace(/\.[a-z0-9]{1,5}$/i, '');
  if (GENERIC_NAME_RE.test(name) && segs.length) name = segs.pop();

  // نزيل الطابع الزمني البادئ الذي تضيفه بعض المنصّات
  name = name.replace(/^\d{10,16}[-_]/, '').trim();
  if (!name || GENERIC_NAME_RE.test(name)) return null;
  return name.slice(0, 150);
}

/** النطاق الجذري تقريبًا — يكفي للمقارنة بين مضيف الفيديو ومضيف الصفحة */
function rootDomain(host) {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
  return parts.slice(-2).join('.');
}

function isAd(url) {
  try {
    return AD_HOSTS_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function classify(url, mimeType) {
  if (isAd(url)) return null;
  if (SEGMENT_RE.test(url) && !PLAYLIST_RE.test(url)) return null;
  if (PLAYLIST_RE.test(url)) return /\.mpd/i.test(url) ? 'DASH' : 'HLS';
  if (DIRECT_RE.test(url)) return 'ملف مباشر';
  if (mimeType && MEDIA_MIME_RE.test(mimeType)) {
    if (/mpegurl/i.test(mimeType)) return 'HLS';
    if (/dash/i.test(mimeType)) return 'DASH';
    return 'ملف مباشر';
  }
  return null;
}

// ------------------------------------------------------------- عميل CDP ---

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Set();
    this.alive = false;
    this.onClose = () => {};
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => {
        this.alive = true;
        resolve();
      });
      this.ws.addEventListener('error', () => reject(new Error('تعذّر الاتصال بالمتصفح')));
    });

    // بدون هذا يبقى الاتصال «حيًّا» في نظرنا بعد موته، فتتعلّق كل الطلبات
    // حتى تنتهي مهلتها — وهذا سبب «انتهت مهلة Target.createTarget».
    this.ws.addEventListener('close', () => {
      this.alive = false;
      for (const { reject } of this.pending.values()) {
        reject(new Error('انقطع الاتصال بالمتصفح'));
      }
      this.pending.clear();
      this.onClose();
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers) h(msg);
      }
    });
  }

  send(method, params = {}, sessionId, timeoutMs = 15000) {
    if (!this.alive) return Promise.reject(new Error('لا يوجد اتصال بالمتصفح'));
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e) {
        this.pending.delete(id);
        return reject(e);
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`انتهت مهلة ${method}`));
        }
      }, timeoutMs);
    });
  }

  on(fn) {
    this.handlers.add(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* مغلق أصلًا */
    }
  }
}

// --------------------------------------------------------- إدارة الجلسة ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** فحص سريع لمنفذ DevTools — يرجع بيانات النسخة أو null */
async function probeDevTools(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1200),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function waitForDevTools(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await probeDevTools(port);
    if (v) return v;
    await sleep(300);
  }
  throw new Error('لم يستجب المتصفح خلال المهلة');
}

class Sniffer {
  constructor() {
    this.proc = null;
    this.cdp = null;
    this.found = new Map(); // url → معلومات
    this.pageUrl = null;
    this.pageTitle = null;
    this.active = false;
    // العرض المدمج: آخر إطار من بث الشاشة، وجلسة الصفحة التي نرسل لها الإدخال
    this.frame = null;
    this.pageSession = null;
    this.viewing = false;
    this.headless = false;
    this.onMedia = () => {};
    this.onStatus = () => {};
  }

  get browserAvailable() {
    return !!findBrowser();
  }

  async start(url, { onMedia, onStatus, embedded } = {}) {
    this.onMedia = onMedia || (() => {});
    this.onStatus = onStatus || (() => {});
    this.pageUrl = url;
    if (embedded !== undefined) this.viewing = !!embedded;

    const browser = findBrowser();
    if (!browser) throw new Error('لم يُعثر على Chrome أو Brave أو Edge على الجهاز.');

    // إعادة استخدام الجلسة القائمة — لكن بعد التأكد أنها حيّة فعلًا.
    // الاتصال قد يموت بينما نظنّه قائمًا (إعادة تشغيل الخادم مثلًا).
    if (this.cdp && this.cdp.alive) {
      try {
        await this.cdp.send('Browser.getVersion', {}, undefined, 4000);
        this.onStatus('المتصفح مفتوح — جارٍ فتح الرابط');
        await this.cdp.send('Target.createTarget', { url }, undefined, 8000);
        this.active = true;
        return { browser: browser.name, reused: true };
      } catch {
        this._teardown(); // ميت — نكمل لمسار الاتصال من جديد
      }
    }

    await fsp.mkdir(PROFILE_DIR, { recursive: true });

    // متصفح يعمل أصلًا على نفس المنفذ؟ نتصل به بدل تشغيل نسخة جديدة.
    // (تشغيل Chrome بنفس user-data-dir لا ينشئ عملية جديدة، بل يمرّر
    //  الرابط للنسخة القائمة ثم تنتهي العملية المُشغَّلة فورًا.)
    let version = await probeDevTools(CDP_PORT);

    if (version) {
      this.onStatus(`${browser.name} مفتوح — جارٍ إعادة الاتصال`);
    } else {
      this.onStatus(`جارٍ فتح ${browser.name}…`);
      const args = [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-popup-blocking',
        '--disable-features=Translate,OptimizationGuideModelDownloading',
        '--window-size=1280,800',
      ];
      // في العرض المدمج لا نفتح نافذة على الجهاز — الصفحة تُبثّ داخل الأداة
      if (this.viewing) args.push('--headless=new', '--hide-scrollbars');
      // داخل الحاويات لا تتوفّر صناديق العزل ولا ذاكرة ‎/dev/shm‎ الكافية
      if (process.env.CHROME_BIN || process.platform === 'linux') {
        args.push('--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu');
      }
      args.push(url);

      this.proc = spawn(browser.bin, args, { detached: false, stdio: 'ignore' });
      // لا نربط حالة الجلسة بعمر هذه العملية: قد تنتهي فورًا وهي تمرّر
      // الرابط لنسخة قائمة. مصدر الحقيقة هو اتصال CDP نفسه.
      this.proc.on('error', () => {});
      version = await waitForDevTools(CDP_PORT);
    }

    const cdp = new CDP(version.webSocketDebuggerUrl);
    await cdp.ready;
    cdp.onClose = () => {
      if (this.cdp === cdp) {
        this.cdp = null;
        this.active = false;
        this.onStatus('انقطع الاتصال بالمتصفح');
      }
    };
    this.cdp = cdp;
    this.active = true;

    cdp.on((msg) => this._handle(msg, cdp));

    // نلتقط كل تبويب/إطار جديد تلقائيًا ونفعّل مراقبة الشبكة عليه
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    await cdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });

    // عند إعادة الاتصال بمتصفح قائم نفتح الرابط بأنفسنا
    if (!this.proc) {
      try {
        await cdp.send('Target.createTarget', { url }, undefined, 8000);
      } catch {
        /* التبويب قد يكون مفتوحًا مسبقًا */
      }
    }

    this.onStatus('المتصفح جاهز — سجّل دخولك وشغّل الفيديو');
    return { browser: browser.name, reused: !this.proc };
  }

  /** يبدأ بثّ الصفحة كإطارات JPEG لعرضها داخل واجهة الأداة */
  async _castOn(sid) {
    try {
      await this.cdp.send(
        'Page.startScreencast',
        { format: 'jpeg', quality: 55, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 },
        sid
      );
    } catch {
      /* الهدف قد يكون أُغلق */
    }
  }

  async startView() {
    this.viewing = true;
    if (this.cdp && this.pageSession) await this._castOn(this.pageSession);
  }

  /** يمرّر نقرات المستخدم وكتابته من الواجهة إلى الصفحة الحقيقية */
  async input(ev) {
    if (!this.cdp || !this.cdp.alive || !this.pageSession) {
      throw new Error('لا توجد صفحة نشطة');
    }
    const s = this.pageSession;
    const x = Number(ev.x) || 0;
    const y = Number(ev.y) || 0;

    if (ev.kind === 'click') {
      const clickCount = Math.min(Number(ev.clickCount) || 1, 3);
      const base = { x, y, button: 'left', clickCount };
      await this.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, s);
      await this.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, s);
      return;
    }

    if (ev.kind === 'scroll') {
      await this.cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseWheel', x, y, deltaX: Number(ev.dx) || 0, deltaY: Number(ev.dy) || 0 },
        s
      );
      return;
    }

    if (ev.kind === 'text' && ev.text) {
      await this.cdp.send('Input.insertText', { text: String(ev.text) }, s);
      return;
    }

    if (ev.kind === 'key') {
      const codes = {
        Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46,
        ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
        PageUp: 33, PageDown: 34, Home: 36, End: 35,
      };
      const code = codes[ev.key];
      if (!code) return;
      const base = { windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, key: ev.key };
      await this.cdp.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' }, s);
      await this.cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, s);
    }
  }

  _teardown() {
    if (this.cdp) {
      this.cdp.onClose = () => {};
      this.cdp.close();
    }
    this.cdp = null;
    this.active = false;
  }

  async _handle(msg, cdp) {
    const { method, params, sessionId } = msg;

    if (method === 'Target.attachedToTarget') {
      const sid = params.sessionId;
      const type = params.targetInfo?.type;
      if (type !== 'page' && type !== 'iframe') return;
      try {
        await cdp.send('Network.enable', {}, sid);
        await cdp.send('Page.enable', {}, sid);
        if (type === 'page') {
          this.pageSession = sid; // آخر صفحة هي هدف الإدخال والعرض
          if (this.viewing) await this._castOn(sid);
        }
        // نلتقط الأهداف الفرعية داخل هذا التبويب أيضًا (المشغّلات المضمّنة)
        await cdp.send(
          'Target.setAutoAttach',
          { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
          sid
        );
      } catch {
        /* قد يُغلق الهدف قبل أن نجهّزه */
      }
      return;
    }

    if (method === 'Page.screencastFrame') {
      this.frame = {
        buf: Buffer.from(params.data, 'base64'),
        w: params.metadata?.deviceWidth || 1280,
        h: params.metadata?.deviceHeight || 800,
        at: Date.now(),
      };
      // بدون الإقرار يتوقّف البث بعد إطار أو إطارين
      try {
        await cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId);
      } catch {
        /* الصفحة أُغلقت */
      }
      return;
    }

    if (method === 'Network.responseReceived') {
      const r = params.response || {};
      this._record(r.url, r.mimeType, Number(r.headers?.['content-length'] || r.headers?.['Content-Length']) || null);
      return;
    }

    if (method === 'Network.requestWillBeSent') {
      this._record(params.request?.url, null, null);
      return;
    }

    if (method === 'Page.frameNavigated' && !params.frame?.parentId) {
      this.pageUrl = params.frame.url || this.pageUrl;
      try {
        const { result } = await cdp.send(
          'Runtime.evaluate',
          { expression: 'document.title', returnByValue: true },
          sessionId
        );
        if (result?.value) this.pageTitle = result.value;
      } catch {
        /* غير مهم */
      }
    }
  }

  _record(url, mimeType, size) {
    if (!url || !/^https?:/i.test(url)) return;
    const kind = classify(url, mimeType);
    if (!kind) return;

    const key = url.split('#')[0];
    const existing = this.found.get(key);
    if (existing) {
      // نُثري السجل إن وصلت معلومات أفضل لاحقًا
      if (size && !existing.size) {
        existing.size = size;
        this.onMedia(existing);
      }
      return;
    }

    let host = '';
    try {
      host = new URL(key).hostname;
    } catch {
      /* تجاهل */
    }

    let pageHost = '';
    try {
      pageHost = new URL(this.pageUrl || '').hostname;
    } catch {
      /* تجاهل */
    }

    const item = {
      url: key,
      kind,
      size,
      host,
      sameSite: !!host && !!pageHost && rootDomain(host) === rootDomain(pageHost),
      name: suggestName(key),
      pageUrl: this.pageUrl,
      pageTitle: this.pageTitle,
      at: this.found.size,
    };
    this.found.set(key, item);
    this.onMedia(item);
  }

  /** الأرجح أولًا: من نفس الموقع، ثم القوائم (HLS/DASH) قبل الملفات المفردة */
  list() {
    const rank = (m) => (m.sameSite ? 0 : 2) + (m.kind === 'ملف مباشر' ? 1 : 0);
    return [...this.found.values()].sort((a, b) => rank(a) - rank(b) || a.at - b.at);
  }

  clear() {
    this.found.clear();
  }

  /**
   * يصدّر كوكيز الجلسة بصيغة Netscape ليقرأها yt-dlp.
   * نقتصر على الكوكيز التي تخصّ الموقع ومضيف الفيديو فقط — لا داعي
   * لكتابة كوكيز شبكات التتبّع في ملف على القرص.
   */
  async exportCookies(mediaUrl) {
    if (!this.cdp) return null;
    let cookies = [];
    try {
      const res = await this.cdp.send('Storage.getCookies', {});
      cookies = res.cookies || [];
    } catch {
      return null;
    }
    if (!cookies.length) return null;

    const hosts = [];
    for (const u of [this.pageUrl, mediaUrl]) {
      try {
        if (u) hosts.push(new URL(u).hostname.toLowerCase());
      } catch {
        /* تجاهل */
      }
    }
    if (hosts.length) {
      const applies = (domain) => {
        const d = String(domain || '').replace(/^\./, '').toLowerCase();
        if (!d) return false;
        return hosts.some((h) => h === d || h.endsWith('.' + d) || rootDomain(h) === rootDomain(d));
      };
      cookies = cookies.filter((c) => applies(c.domain));
    }
    if (!cookies.length) return null;

    const lines = ['# Netscape HTTP Cookie File', '# مُصدَّر من دَون فيديو', ''];
    for (const c of cookies) {
      const domain = c.domain.startsWith('.') ? c.domain : c.domain;
      const includeSub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
      const expires = c.session || !c.expires ? 0 : Math.floor(c.expires);
      lines.push(
        [domain, includeSub, c.path || '/', c.secure ? 'TRUE' : 'FALSE', expires, c.name, c.value].join('\t')
      );
    }
    await fsp.mkdir(SUPPORT_DIR, { recursive: true });
    await fsp.writeFile(COOKIE_FILE, lines.join('\n') + '\n', { mode: 0o600 });
    return COOKIE_FILE;
  }

  async stop() {
    // نغلق المتصفح عبر CDP لا بقتل العملية: العملية التي شغّلناها قد تكون
    // انتهت فورًا بعد تمرير الرابط لنسخة قائمة، فقتلها لا يغلق شيئًا.
    if (this.cdp && this.cdp.alive) {
      try {
        await this.cdp.send('Browser.close', {}, undefined, 4000);
      } catch {
        /* سنلجأ للقتل أدناه */
      }
    }
    this._teardown();

    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        /* أُغلق */
      }
    }
    this.proc = null;
    this.onStatus('توقّف الاستخراج');
  }
}

module.exports = { Sniffer, findBrowser, COOKIE_FILE };
