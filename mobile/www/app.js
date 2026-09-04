/* 时间记录器 Time Logger
 * 用途: 地震密集台阵设备一致性检测 - 锤击地面时刻的精确记录
 * 原理: Web Audio API 监听麦克风, 检测敲击瞬态声波(快攻激/高脉冲性),
 *       定位起始样本并补偿音频链路延迟后, 记录精确北京时间。
 * 存储: IndexedDB 数据库 (hits 敲击记录表 / sessions 会话历史表), 支持索引查询;
 *       localStorage 仅存设置项, 旧版本记录首次启动自动迁移入库。
 * 导出: .dat 纯文本, 每行一条时间戳, 秒值精度最高6位小数。
 * 同步: 每次停止记录后自动将新增数据单向同步备份至服务器 /api/sync,
 *       增量上传(水位+时间戳)、SHA-256完整性校验、失败退避重试、断网续传。
 */
(() => {
  'use strict';

  // Capacitor 原生环境(APK): 标记后 CSS 增加沉浸式状态栏留白
  if (window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform())
    document.documentElement.classList.add('is-native');

  /* ================= 常量与时间工具 ================= */

  const LS_SETTINGS = 'tl_settings_v1';
  const LS_RECORDS = 'tl_records_v1'; // 旧版本数据, 仅用于迁移
  const DB_NAME = 'time-logger';
  const DB_VERSION = 1;
  const DEFAULT_SETTINGS = {
    threshold: 0.18,      // 触发阈值(峰值幅度 0~1)
    refractoryMs: 500,    // 防重复间隔
    precision: 2,         // 导出/记录秒值小数位 (2~6)
    prefix: 'timelogger', // 导出文件名前缀
    extraCompMs: 0,       // 附加时间补偿(毫秒)
    theme: 'dark',        // 界面主题: dark 深色 / light 浅色
    syncToken: '',        // 同步令牌(可选, 与服务器 SYNC_TOKEN 环境变量一致)
    syncServer: '',       // 同步服务器地址(APK离线包用, 如 https://192.168.1.100:8443; 网页版留空用当前站点)
  };

  // 北京时间 = UTC+8 (1991年后无夏令时, 可用固定偏移精确换算)
  const BJ_OFFSET = 8 * 3600 * 1000;
  const WD = ['日', '一', '二', '三', '四', '五', '六'];
  const p2 = (n) => String(n).padStart(2, '0');

  function bjParts(ms) {
    const d = new Date(ms + BJ_OFFSET);
    return {
      y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, day: d.getUTCDate(), wd: d.getUTCDay(),
      h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds(),
    };
  }
  // 秒值小数部分字符串: frac 1~6, 超3位补零(时间源分辨率为1毫秒)
  function fracStr(msPart, frac) {
    const base = String(msPart).padStart(3, '0');
    return frac <= 3 ? base.slice(0, frac) : base + '0'.repeat(frac - 3);
  }
  // HH:MM:SS.ss — 页面实时显示固定2位小数
  function fmtClock(ms) {
    const p = bjParts(ms);
    return `${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}.${p2(Math.floor(p.ms / 10))}`;
  }
  function fmtDateLine(ms) {
    const p = bjParts(ms);
    return `${p.y}年${p2(p.mo)}月${p2(p.day)}日 周${WD[p.wd]}`;
  }
  function fmtDateFull(ms) {
    const p = bjParts(ms);
    return `${p.y}-${p2(p.mo)}-${p2(p.day)}`;
  }
  function fmtHMS(ms) {
    const p = bjParts(ms);
    return `${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}`;
  }
  // 完整记录行 YYYY-MM-DD HH:MM:SS.f(2~6) — .dat 导出格式
  function fmtRecord(ms, frac) {
    const p = bjParts(ms);
    return `${fmtDateFull(ms)} ${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}.${fracStr(p.ms, frac)}`;
  }
  // 仅时间部分 HH:MM:SS.f(2~6) — 记录列表显示
  function fmtTimePart(ms, frac) {
    const p = bjParts(ms);
    return `${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}.${fracStr(p.ms, frac)}`;
  }
  // 文件名时间戳 YYYYMMDD_HHMMSS
  function fmtStamp(ms) {
    const p = bjParts(ms);
    return `${p.y}${p2(p.mo)}${p2(p.day)}_${p2(p.h)}${p2(p.mi)}${p2(p.s)}`;
  }
  function fmtGap(ms) {
    if (ms < 60000) return `+${(ms / 1000).toFixed(2)}s`;
    return `+${Math.floor(ms / 60000)}m${p2(Math.floor((ms % 60000) / 1000))}s`;
  }
  function fmtDuration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + '秒';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}分${p2(s % 60)}秒`;
    return `${Math.floor(m / 60)}时${p2(m % 60)}分`;
  }

  const $ = (id) => document.getElementById(id);
  const getFrac = () => Math.min(6, Math.max(2, state.settings.precision | 0 || 2));

  /* ================= DOM 引用 ================= */

  const clockEl = $('clock');
  const dateLine = $('dateLine');
  const syncBadge = $('syncBadge');
  const syncText = $('syncText');
  const hitCount = $('hitCount');
  const lastHit = $('lastHit');
  const micState = $('micState');
  const meterCanvas = $('meterCanvas');
  const clipHint = $('clipHint');
  const btnToggle = $('btnToggle');
  const iconPlay = $('iconPlay');
  const iconStop = $('iconStop');
  const btnLabel = $('btnLabel');
  const btnManual = $('btnManual');
  const btnUndo = $('btnUndo');
  const btnClear = $('btnClear');
  const btnExport = $('btnExport');
  const recordList = $('recordList');
  const emptyHint = $('emptyHint');
  const listCount = $('listCount');
  const historyCount = $('historyCount');
  const historyEmpty = $('historyEmpty');
  const historyList = $('historyList');
  const btnExportAll = $('btnExportAll');
  const syncStateEl = $('syncState');
  const syncBar = $('syncBar');
  const syncInfo = $('syncInfo');
  const btnSyncNow = $('btnSyncNow');
  const syncLogList = $('syncLogList');
  const btnCalib = $('btnCalib');
  const settingsBox = $('settingsBox');
  const calibModal = $('calibModal');
  const calibPhase = $('calibPhase');
  const calibPhaseText = $('calibPhaseText');
  const calibCanvas = $('calibCanvas');
  const calibTip = $('calibTip');
  const calibResult = $('calibResult');
  const calibConfirm = $('calibConfirm');
  const calibTest = $('calibTest');
  const calibCancel = $('calibCancel');
  const setToken = $('setToken');
  const setSyncServer = $('setSyncServer');
  const toastEl = $('toast');
  const flashEl = $('flash');
  const setThreshold = $('setThreshold');
  const thVal = $('thVal');
  const setRefractory = $('setRefractory');
  const rfVal = $('rfVal');
  const setPrecision = $('setPrecision');
  const setPrefix = $('setPrefix');
  const setComp = $('setComp');
  const compInfo = $('compInfo');
  const btnSync = $('btnSync');
  const syncStatus = $('syncStatus');
  const btnTheme = $('btnTheme');
  const iconSun = $('iconSun');
  const iconMoon = $('iconMoon');
  const tokenSetting = $('tokenSetting');

  /* ================= 状态 ================= */

  const state = {
    recording: false,
    records: [],       // 当前显示会话的敲击记录 (内存副本, 权威数据在 IndexedDB)
    session: null,     // 进行中的会话 { id, startT, endT, hitCount, ... }
    viewSid: null,     // 当前显示的会话 id
    offsetMs: 0,       // 网络校时偏移
    settings: { ...DEFAULT_SETTINGS },
  };

  // 音频相关
  let audioCtx = null, stream = null, sourceNode = null, processorNode = null, muteNode = null;
  let sampleRate = 48000;
  let inputLatencyMs = 15;   // 麦克风到音频图的链路延迟(毫秒)
  let noiseFloor = 1e-4;     // 自适应噪声底(RMS)
  let prevRms = 0;
  let lastTriggerTs = 0;
  let startWallMs = 0;
  let anchorWall = 0;        // 当前缓冲区末尾对应的墙钟时刻(按采样率推进)
  let lastCbWall = 0;
  let clipCount = 0;
  let busy = false;          // 启动过程防重入
  let wakeLock = null;

  const MAX_LEVELS = 220;    // 电平历史条数(约 9~10 秒窗口)
  const levels = [];         // { v: 峰值, hit: 是否触发记录 }

  /* ================= 数据库: IndexedDB (含内存回退) ================= */

  let dbHandle = null;
  // IndexedDB 不可用(旧版隐私模式等)时的内存回退, 刷新后数据丢失
  const mem = { hits: [], hitId: 1, sessions: [], sessionId: 1 };

  function dbOpen() {
    return new Promise((resolve) => {
      if (!('indexedDB' in window)) { resolve(false); return; }
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { resolve(false); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('hits')) {
          const s = db.createObjectStore('hits', { keyPath: 'id', autoIncrement: true });
          s.createIndex('sessionId', 'sessionId');  // 按会话取敲击记录
          s.createIndex('t', 't');                  // 按时间排序/范围查询
        }
        if (!db.objectStoreNames.contains('sessions')) {
          const s = db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
          s.createIndex('startT', 'startT');        // 按开始时间排序
        }
      };
      req.onsuccess = () => { dbHandle = req.result; resolve(true); };
      req.onerror = () => resolve(false);
      req.onblocked = () => resolve(false);
    });
  }

  const Store = {
    async addHit(rec) {
      if (!dbHandle) { rec.id = mem.hitId++; mem.hits.push(rec); return rec; }
      rec.id = await new Promise((resolve, reject) => {
        const r = dbHandle.transaction('hits', 'readwrite').objectStore('hits').add(rec);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      return rec;
    },
    async deleteHit(id) {
      if (!dbHandle) { mem.hits = mem.hits.filter((h) => h.id !== id); return; }
      await new Promise((resolve, reject) => {
        const tx = dbHandle.transaction('hits', 'readwrite');
        tx.objectStore('hits').delete(id);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    },
    async getHits(sid) {
      if (!dbHandle) return mem.hits.filter((h) => h.sessionId === sid).sort((a, b) => a.t - b.t);
      const arr = await new Promise((resolve, reject) => {
        const r = dbHandle.transaction('hits').objectStore('hits').index('sessionId').getAll(sid);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      return arr.sort((a, b) => a.t - b.t);
    },
    async countHits(sid) {
      if (!dbHandle) return mem.hits.filter((h) => h.sessionId === sid).length;
      return new Promise((resolve, reject) => {
        const r = dbHandle.transaction('hits').objectStore('hits').index('sessionId').count(sid);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    },
    // ---- 同步用增量查询: 按主键 id 水位取新增敲击 ----
    async getHitsAfter(id, limit) {
      if (!dbHandle) return mem.hits.filter((h) => h.id > id).sort((a, b) => a.id - b.id).slice(0, limit || 1e9);
      return new Promise((resolve, reject) => {
        const r = dbHandle.transaction('hits').objectStore('hits').getAll(IDBKeyRange.lowerBound(id, true), limit);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    },
    async countHitsAfter(id) {
      if (!dbHandle) return mem.hits.filter((h) => h.id > id).length;
      return new Promise((resolve, reject) => {
        const r = dbHandle.transaction('hits').objectStore('hits').count(IDBKeyRange.lowerBound(id, true));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    },
    async getSessionsAfter(ts) {
      const all = await this.getSessions();
      return all.filter((s) => (s.updatedAt || 0) > ts).sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    },
    async countSessionsAfter(ts) {
      const all = await this.getSessions();
      return all.filter((s) => (s.updatedAt || 0) > ts).length;
    },
    async addSession(s) {
      if (!dbHandle) { s.id = mem.sessionId++; mem.sessions.push(s); return s; }
      s.id = await new Promise((resolve, reject) => {
        const r = dbHandle.transaction('sessions', 'readwrite').objectStore('sessions').add(s);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      return s;
    },
    async putSession(s) {
      if (!dbHandle) {
        const i = mem.sessions.findIndex((x) => x.id === s.id);
        if (i >= 0) mem.sessions[i] = s; else mem.sessions.push(s);
        return s;
      }
      await new Promise((resolve, reject) => {
        const tx = dbHandle.transaction('sessions', 'readwrite');
        tx.objectStore('sessions').put(s);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      return s;
    },
    async getSession(id) {
      if (!dbHandle) return mem.sessions.find((s) => s.id === id) || null;
      return new Promise((resolve, reject) => {
        const r = dbHandle.transaction('sessions').objectStore('sessions').get(id);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => reject(r.error);
      });
    },
    async getSessions() {
      if (!dbHandle) return [...mem.sessions].sort((a, b) => b.startT - a.startT);
      const arr = await new Promise((resolve, reject) => {
        const r = dbHandle.transaction('sessions').objectStore('sessions').getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      return arr.sort((a, b) => b.startT - a.startT); // 最新在前
    },
    async deleteSession(id) {
      if (!dbHandle) {
        mem.sessions = mem.sessions.filter((s) => s.id !== id);
        mem.hits = mem.hits.filter((h) => h.sessionId !== id);
        return;
      }
      await new Promise((resolve, reject) => {
        const tx = dbHandle.transaction(['hits', 'sessions'], 'readwrite');
        const cursorReq = tx.objectStore('hits').index('sessionId').openCursor(IDBKeyRange.only(id));
        cursorReq.onsuccess = () => {
          const c = cursorReq.result;
          if (c) { c.delete(); c.continue(); }
        };
        tx.objectStore('sessions').delete(id);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    },
  };

  // 旧版本 localStorage 记录迁移入库
  async function migrateLegacy() {
    try {
      const raw = localStorage.getItem(LS_RECORDS);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) {
        const hits = arr
          .filter((r) => r && typeof r.t === 'number')
          .sort((a, b) => a.t - b.t);
        if (hits.length) {
          const s = await Store.addSession({
            startT: hits[0].t, endT: hits[hits.length - 1].t, hitCount: hits.length,
            precision: DEFAULT_SETTINGS.precision, threshold: null, refractoryMs: null,
            note: '迁移自旧版本', updatedAt: Date.now(),
          });
          for (const h of hits) {
            await Store.addHit({ t: h.t, src: h.src === 'manual' ? 'manual' : 'auto', lvl: h.lvl || 0, sessionId: s.id });
          }
        }
      }
      localStorage.removeItem(LS_RECORDS);
    } catch (e) { /* 迁移失败不影响新功能 */ }
  }

  // 同步会话的敲击计数到数据库
  async function syncSessionCount(sid) {
    if (!sid) return;
    const s = await Store.getSession(sid);
    if (!s) return;
    const c = await Store.countHits(sid);
    if (s.hitCount !== c) { s.hitCount = c; s.updatedAt = Date.now(); await Store.putSession(s); }
  }

  /* ================= 设置持久化 ================= */

  function loadPersisted() {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      if (raw) state.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch (e) { /* 使用默认设置 */ }
  }
  function saveSettings() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings)); } catch (e) { /* 忽略 */ }
  }

  /* ================= 主题切换 (深色/浅色) ================= */

  // 画布配色: 从当前主题的 CSS 变量读取, 切换主题时刷新
  let plotColors = {
    bar: 'rgba(34, 211, 238, .7)',
    warn: 'rgba(251, 191, 36, .9)',
    hit: '#f87171',
    scale: 'rgba(125, 143, 168, .8)',
  };
  function refreshPlotColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fb) => cs.getPropertyValue(name).trim() || fb;
    plotColors = {
      bar: v('--plot-bar', plotColors.bar),
      warn: v('--plot-warn', plotColors.warn),
      hit: v('--plot-hit', plotColors.hit),
      scale: v('--plot-scale', plotColors.scale),
    };
  }

  const metaTheme = document.querySelector('meta[name="theme-color"]');
  function applyTheme() {
    const light = state.settings.theme === 'light';
    if (light) document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    // 图标显示"点击后将切换到"的目标主题: 深色时显示太阳, 浅色时显示月亮
    iconSun.style.display = light ? 'none' : '';
    iconMoon.style.display = light ? '' : 'none';
    if (metaTheme) metaTheme.setAttribute('content', light ? '#eef2f8' : '#0b1220');
    refreshPlotColors();
  }

  /* ================= 底部导航: 记录 / 历史 / 设置 ================= */

  function switchTab(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));
    document.querySelectorAll('.tabbar .tab').forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  // 服务器是否启用令牌校验: 探测 /api/sync/stats, 启用时才显示"同步令牌"设置项
  async function detectTokenRequirement() {
    const need = !!(state.settings.syncToken || '').trim() || sync.meta.lastTokenRequired === true;
    tokenSetting.hidden = !need;
    try {
      const base = (state.settings.syncServer || '').trim().replace(/\/+$/, '');
      if (!base || !/^https?:$/.test(location.protocol)) return;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 6000);
      const res = await fetch(base + '/api/sync/stats', { cache: 'no-store', signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) return;
      const j = await res.json();
      sync.meta.lastTokenRequired = !!j.tokenRequired;
      saveSyncMeta();
      tokenSetting.hidden = !(j.tokenRequired || (state.settings.syncToken || '').trim());
    } catch (e) { /* 探测失败(跨域受限/离线)时保持当前显隐 */ }
  }

  /* ================= 数据同步: IndexedDB → 服务器单向备份 ================= */

  const SYNC_BATCH = 300;                        // 每批上传条数
  const SYNC_RETRY_DELAYS = [2000, 5000, 15000]; // 失败重试退避间隔
  const LS_SYNC = 'tl_sync_v1';
  const LS_SYNCLOG = 'tl_synclog_v1';

  const sync = {
    running: false,
    queued: false,
    status: 'idle',     // idle | pending | syncing | ok | failed | offline
    pendingHits: 0,
    pendingSessions: 0,
    meta: { deviceId: '', hitWatermark: 0, lastSessionAt: 0, lastOkAt: 0 },
    log: [],
  };

  function loadSyncMeta() {
    try {
      const raw = localStorage.getItem(LS_SYNC);
      if (raw) Object.assign(sync.meta, JSON.parse(raw));
    } catch (e) { /* 使用默认 */ }
    if (!sync.meta.deviceId) {
      sync.meta.deviceId = crypto.randomUUID
        ? crypto.randomUUID()
        : 'dev-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      saveSyncMeta();
    }
    try {
      const raw = localStorage.getItem(LS_SYNCLOG);
      sync.log = raw ? JSON.parse(raw) : [];
    } catch (e) { sync.log = []; }
  }
  function saveSyncMeta() {
    try { localStorage.setItem(LS_SYNC, JSON.stringify(sync.meta)); } catch (e) { /* 忽略 */ }
  }

  // 同步服务器地址默认值:
  //   网页版(非 localhost) → 当前站点;  APK(localhost 离线包) → 上次同步成功的地址
  // 已填写的用户配置始终优先, 不覆盖
  function applyDefaultSyncServer() {
    const cur = (state.settings.syncServer || '').trim();
    if (cur) { setSyncServer.value = cur; return; }
    let fallback = '';
    const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
    if (!isLocal && /^https?:/.test(location.protocol)) fallback = location.origin;
    else if (isLocal && sync.meta.lastServer) fallback = sync.meta.lastServer;
    if (fallback) {
      state.settings.syncServer = fallback;
      setSyncServer.value = fallback;
      saveSettings();
    } else {
      setSyncServer.value = '';
    }
  }

  function syncLog(trigger, msg, level) {
    sync.log.unshift({ time: Date.now() + state.offsetMs, trigger, msg, level: level || 'info' });
    if (sync.log.length > 50) sync.log.length = 50;
    try { localStorage.setItem(LS_SYNCLOG, JSON.stringify(sync.log)); } catch (e) { /* 忽略 */ }
    renderSyncLog();
  }
  function renderSyncLog() {
    syncLogList.innerHTML = '';
    for (const e of sync.log) {
      const li = document.createElement('li');
      li.className = 'log-' + (e.level || 'info');
      li.textContent = `${fmtClock(e.time)} [${e.trigger}] ${e.msg}`;
      syncLogList.appendChild(li);
    }
  }

  const SYNC_LABEL = {
    idle: '未同步', pending: '待同步', syncing: '同步中…',
    ok: '已同步', failed: '同步失败', offline: '离线 · 等待网络',
  };
  function setSyncState(st, text) {
    sync.status = st;
    syncStateEl.className = 'sync-state ' + st;
    syncStateEl.innerHTML = '<span class="dot"></span>' + (text || SYNC_LABEL[st] || st);
  }

  // 与服务器约定的确定性序列化, 用于传输完整性校验
  function hitKeyStr(h) {
    return [h.sessionId, h.id, h.t, h.src || 'auto', h.lvl == null ? 0 : h.lvl].join('|');
  }
  function sessKeyStr(s) {
    return [s.id, s.startT, s.endT == null ? '' : s.endT, s.hitCount,
      s.precision == null ? '' : s.precision, s.note || ''].join('|');
  }
  async function checksumOf(arr, keyFn) {
    const str = arr.map(keyFn).join(';');
    if (crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
      return { algo: 'sha256', value: [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('') };
    }
    let h = 5381; // djb2 兜底(无 crypto.subtle 时), 服务器按 algo 字段适配
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return { algo: 'djb2', value: String(h >>> 0) };
  }

  function deviceName() {
    const ua = navigator.userAgent;
    const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
      : /Windows/i.test(ua) ? 'Windows' : /Mac/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'Unknown';
    const m = ua.match(/(Edg|Chrome|Firefox)\/([\d.]+)/);
    return os + (m ? ' ' + m[1].replace('Edg', 'Edge') : '');
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function waitOnline() {
    return Promise.race([
      new Promise((r) => { if (navigator.onLine) r(); else addEventListener('online', r, { once: true }); }),
      sleep(60000),
    ]);
  }

  // 带退避重试(2s/5s/15s)与断网等待的POST, 失败自动重试最多4次
  async function postJSON(path, body) {
    const headers = { 'Content-Type': 'application/json', 'X-TimeLogger-Sync': '1' };
    if (state.settings.syncToken) headers['X-Sync-Token'] = state.settings.syncToken;
    // APK离线包: 资源由本地打包提供, 需拼接用户配置的同步服务器地址; 网页版留空则用当前站点
    const base = (state.settings.syncServer || '').trim().replace(/\/+$/, '');
    const url = base + path;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store' });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${txt.slice(0, 80)}`);
        }
        return await res.json();
      } catch (err) {
        if (attempt >= SYNC_RETRY_DELAYS.length) throw err;
        const delay = SYNC_RETRY_DELAYS[attempt];
        syncLog('retry', `上传失败(${err && err.message || err}), ${delay / 1000}s 后自动重试`, 'warn');
        await sleep(delay);
        await waitOnline();
      }
    }
  }

  // 刷新待同步数量并更新状态显示
  async function updateSyncPending() {
    try {
      const [ph, ps] = await Promise.all([
        Store.countHitsAfter(sync.meta.hitWatermark),
        Store.countSessionsAfter(sync.meta.lastSessionAt),
      ]);
      sync.pendingHits = ph;
      sync.pendingSessions = ps;
      syncInfo.textContent = (ph + ps === 0 && sync.meta.lastOkAt)
        ? `已全部同步 · 上次成功 ${fmtClock(sync.meta.lastOkAt)}`
        : `待同步 ${ph} 条敲击 · ${ps} 次会话`;
      if (ph + ps > 0) syncBar.style.width = '0%';
      if (!sync.running && sync.status !== 'failed') {
        if (!navigator.onLine) setSyncState('offline');
        else if (ph + ps > 0) setSyncState('pending');
        else setSyncState('ok', '已全部同步');
      }
    } catch (e) { console.error('updateSyncPending failed:', e); }
  }

  // 同步主流程: 敲击分批增量上传 → 会话upsert; 全程异步+分批让出主线程, 不阻塞UI
  async function runSync(trigger) {
    if (sync.running) { sync.queued = true; return; }
    if (!/^https?:$/.test(location.protocol)) {
      setSyncState('failed', '无法同步');
      syncLog(trigger, '当前非HTTP(S)环境, 无法访问同步接口', 'error');
      return;
    }
    if (location.protocol === 'https:' && ['localhost', '127.0.0.1'].includes(location.hostname) && !(state.settings.syncServer || '').trim()) {
      // APK离线包默认源为本地 https://localhost, 未配置服务器地址时给出明确提示
      setSyncState('failed', '未配置服务器');
      syncLog(trigger, '尚未配置同步服务器地址, 请在"设置→同步服务器地址"中填写 (如 https://192.168.1.100:8443)', 'warn');
      return;
    }
    if (!navigator.onLine) {
      setSyncState('offline');
      syncLog(trigger, '无网络连接, 待网络恢复后自动重试', 'warn');
      return;
    }
    sync.running = true;
    setSyncState('syncing');
    syncLog(trigger, '开始同步…');
    let sentHits = 0, storedHits = 0, dupHits = 0, sentSess = 0;
    const totalHits = await Store.countHitsAfter(sync.meta.hitWatermark);
    try {
      // 阶段1: 敲击记录 — 按 id 水位增量, 服务器按唯一键去重(幂等, 重试安全)
      for (;;) {
        const batch = await Store.getHitsAfter(sync.meta.hitWatermark, SYNC_BATCH);
        if (!batch.length) break;
        const ck = await checksumOf(batch, hitKeyStr);
        const resp = await postJSON('/api/sync', {
          deviceId: sync.meta.deviceId,
          deviceName: deviceName(),
          hits: batch.map((h) => ({ sessionId: h.sessionId, id: h.id, t: h.t, src: h.src, lvl: h.lvl })),
          hitChecksum: ck,
          clientTime: Date.now(),
        });
        if (!resp || !resp.ok) throw new Error('服务器拒绝: ' + ((resp && resp.error) || '未知错误'));
        if (resp.recvChecksum !== ck.value) throw new Error('回执校验不一致, 传输可能损坏');
        storedHits += resp.storedHits || 0;
        dupHits += resp.dupHits || 0;
        sentHits += batch.length;
        sync.meta.hitWatermark = batch[batch.length - 1].id; // 每批确认落盘后才推进水位
        saveSyncMeta();
        syncBar.style.width = (totalHits ? Math.round(sentHits / totalHits * 100) : 100) + '%';
        syncInfo.textContent = `同步中 ${sentHits}/${totalHits} 条敲击`;
        await sleep(30); // 让出主线程, 保证界面流畅
      }
      // 阶段2: 会话记录 — 整批upsert, 服务器按最新版本覆盖
      const sess = await Store.getSessionsAfter(sync.meta.lastSessionAt);
      if (sess.length) {
        const ck = await checksumOf(sess, sessKeyStr);
        const resp = await postJSON('/api/sync', {
          deviceId: sync.meta.deviceId,
          deviceName: deviceName(),
          sessions: sess,
          sessChecksum: ck,
          clientTime: Date.now(),
        });
        if (!resp || !resp.ok) throw new Error('服务器拒绝: ' + ((resp && resp.error) || '未知错误'));
        if (resp.recvChecksum !== ck.value) throw new Error('回执校验不一致, 传输可能损坏');
        sentSess = sess.length;
        sync.meta.lastSessionAt = Math.max(sync.meta.lastSessionAt, Math.max.apply(null, sess.map((s) => s.updatedAt || 0)));
        saveSyncMeta();
      }
      sync.meta.lastOkAt = Date.now() + state.offsetMs;
      saveSyncMeta();
      // APK 场景: 记住本次同步成功所用的服务器地址, 下次启动自动填入
      const usedBase = (state.settings.syncServer || '').trim().replace(/\/+$/, '');
      if (usedBase) { sync.meta.lastServer = usedBase; saveSyncMeta(); }
      setSyncState('ok');
      syncInfo.textContent = `本次上传: 敲击 ${sentHits} 条(服务器新增 ${storedHits}/跳过重复 ${dupHits}) · 会话 ${sentSess} 次`;
      syncBar.style.width = '100%';
      syncLog(trigger, `同步成功: 上传敲击 ${sentHits} 条, 服务器新增 ${storedHits} 条(去重 ${dupHits}), 会话 ${sentSess} 次`, 'ok');
    } catch (err) {
      setSyncState('failed');
      syncLog(trigger, `同步失败: ${err && err.message || err} — 已上传部分已在服务器保存, 剩余将在下次触发时自动续传`, 'error');
    } finally {
      sync.running = false;
      updateSyncPending();
      if (sync.queued) { sync.queued = false; runSync('queued'); }
    }
  }

  // 旧版本会话无 updatedAt 字段, 启动时一次性补齐以便纳入增量同步
  async function backfillSessionUpdatedAt() {
    const all = await Store.getSessions();
    for (const s of all) {
      if (!s.updatedAt) {
        s.updatedAt = s.endT || s.startT || Date.now();
        await Store.putSession(s);
      }
    }
  }

  /* ================= 提示与动效 ================= */

  let toastTimer = 0;
  function toast(msg, dur = 2400) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), dur);
  }
  function vibrate(pattern) { if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) { /* 忽略 */ } } }
  function detectFX() {
    flashEl.classList.remove('on');
    void flashEl.offsetWidth; // 强制重排以重启动画
    flashEl.classList.add('on');
    hitCount.classList.remove('pop');
    void hitCount.offsetWidth;
    hitCount.classList.add('pop');
    vibrate(60);
  }
  function setMicState(text, cls) {
    micState.className = 'mic-state' + (cls ? ' ' + cls : '');
    micState.innerHTML = '<span class="dot"></span>' + text;
  }

  /* ================= 数字自适应缩放 (防溢出边框) ================= */

  // 将 el 内文本缩放到恰好不超出其容器宽度
  function fitNum(el, minPx) {
    el.style.fontSize = ''; // 回到 CSS 基准字号
    const base = parseFloat(getComputedStyle(el).fontSize);
    el.style.fontSize = base + 'px';
    const avail = el.clientWidth;
    const w = el.scrollWidth;
    if (w > avail && w > 0) {
      el.style.fontSize = Math.max(minPx, Math.floor(base * (avail / w) * 98) / 100).toFixed(2) + 'px';
    }
  }
  function fitAll() {
    fitNum(clockEl, 24);
    fitNum(lastHit, 12);
  }
  window.addEventListener('resize', fitAll);
  window.addEventListener('orientationchange', () => setTimeout(fitAll, 250));

  /* ================= 记录管理 ================= */

  async function addRecord(rec) {
    if (state.session) {
      rec.sessionId = state.session.id;
    } else {
      // 无进行中会话的手动补记: 自动建一条单点会话
      const s = await Store.addSession({
        startT: rec.t, endT: rec.t, hitCount: 0,
        precision: state.settings.precision, threshold: null, refractoryMs: null,
        note: '手动补记', updatedAt: Date.now(),
      });
      rec.sessionId = s.id;
      state.viewSid = s.id;
      state.records = [];
    }
    await Store.addHit(rec);
    state.records.push(rec);
    if (state.session) state.session.hitCount = state.records.length;
    renderList();
  }

  async function manualRecord() {
    await addRecord({ t: Date.now() + state.offsetMs, src: 'manual', lvl: 0 });
    toast('已手动补记一条时间戳');
  }

  async function undoRecord() {
    if (!state.records.length) { toast('没有可撤销的记录'); return; }
    const r = state.records.pop();
    await Store.deleteHit(r.id);
    if (state.session && r.sessionId === state.session.id) state.session.hitCount = state.records.length;
    await syncSessionCount(r.sessionId);
    renderList();
    renderHistory();
    toast('已撤销: ' + fmtClock(r.t));
  }

  async function clearRecords() {
    const n = state.records.length;
    if (!n) { toast('记录已为空'); return; }
    if (!confirm(`确定清空当前显示的 ${n} 条敲击记录? (历史会话不受影响, 此操作不可恢复)`)) return;
    const sid = state.records[0].sessionId;
    for (const r of state.records) await Store.deleteHit(r.id);
    state.records = [];
    if (state.session) state.session.hitCount = 0;
    await syncSessionCount(sid);
    renderList();
    renderHistory();
    toast('已清空当前记录');
  }

  function renderList() {
    const n = state.records.length;
    hitCount.textContent = String(n);
    listCount.textContent = n + ' 条';
    emptyHint.style.display = n ? 'none' : '';
    lastHit.textContent = n ? fmtClock(state.records[n - 1].t) : '--:--:--.---';
    recordList.innerHTML = '';
    const frac = getFrac();
    let lastDay = '';
    for (let i = n - 1; i >= 0; i--) {  // 最新在前
      const r = state.records[i];
      const day = fmtDateFull(r.t);
      if (day !== lastDay) {            // 跨日分隔行, 列表内仅显示时间部分保证不溢出
        lastDay = day;
        const sep = document.createElement('li');
        sep.className = 'date-sep';
        sep.textContent = day;
        recordList.appendChild(sep);
      }
      const gap = i > 0 ? fmtGap(r.t - state.records[i - 1].t) : '';
      const li = document.createElement('li');
      li.innerHTML =
        `<span class="idx">#${i + 1}</span>` +
        `<span class="time">${fmtTimePart(r.t, frac)}</span>` +
        `<span class="dt">${gap}</span>` +
        `<span class="src ${r.src === 'manual' ? 'manual' : 'auto'}">${r.src === 'manual' ? '手动' : '自动'}</span>` +
        `<button class="del" data-i="${i}" aria-label="删除此条记录">x</button>`;
      recordList.appendChild(li);
    }
    updateSyncPending(); // 刷新待同步数量显示
  }

  recordList.addEventListener('click', (e) => {
    const btn = e.target.closest('.del');
    if (!btn) return;
    const i = parseInt(btn.dataset.i, 10);
    if (!Number.isInteger(i) || !state.records[i]) return;
    const r = state.records[i];
    if (!confirm(`删除第 ${i + 1} 条 (${fmtClock(r.t)})?`)) return;
    (async () => {
      await Store.deleteHit(r.id);
      state.records.splice(i, 1);
      if (state.session && r.sessionId === state.session.id) state.session.hitCount = state.records.length;
      await syncSessionCount(r.sessionId);
      renderList();
      renderHistory();
    })();
  });

  /* ================= 会话 (历史记录) ================= */

  async function beginSession() {
    const s = await Store.addSession({
      startT: Date.now() + state.offsetMs,
      endT: null,
      hitCount: 0,
      precision: state.settings.precision,
      threshold: state.settings.threshold,
      refractoryMs: state.settings.refractoryMs,
      note: '', updatedAt: Date.now() + state.offsetMs,
    });
    state.session = s;
    state.viewSid = s.id;
    state.records = [];
    renderList();
    renderHistory();
  }

  async function finalizeSession() {
    const s = state.session;
    if (!s) return;
    s.endT = Date.now() + state.offsetMs;
    s.hitCount = await Store.countHits(s.id);
    s.updatedAt = Date.now() + state.offsetMs;
    await Store.putSession(s);
    state.session = null;
    renderHistory();
  }

  async function renderHistory() {
    const sessions = await Store.getSessions();
    historyCount.textContent = sessions.length + ' 次';
    historyEmpty.style.display = sessions.length ? 'none' : '';
    historyList.innerHTML = '';
    for (const s of sessions) {
      const li = document.createElement('li');
      li.className = 'hist-item';
      const st = fmtHMS(s.startT);
      const en = s.endT ? fmtHMS(s.endT) : '未正常结束';
      const dur = s.endT ? fmtDuration(s.endT - s.startT) : '进行中';
      li.innerHTML =
        `<div class="hist-main">` +
          `<div class="hist-title">#${s.id} · ${fmtDateFull(s.startT)}</div>` +
          `<div class="hist-sub">${st} ~ ${en} · ${dur} · ${s.hitCount} 次敲击${s.note ? ' · ' + s.note : ''}</div>` +
        `</div>` +
        `<div class="hist-btns">` +
          `<button class="btn-mini" data-act="exp" data-id="${s.id}">导出</button>` +
          `<button class="btn-mini mini-danger" data-act="del" data-id="${s.id}">删除</button>` +
        `</div>`;
      historyList.appendChild(li);
    }
  }

  historyList.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-mini');
    if (!btn) return;
    const id = parseInt(btn.dataset.id, 10);
    if (!Number.isInteger(id)) return;
    if (btn.dataset.act === 'exp') {
      exportSession(id);
    } else if (btn.dataset.act === 'del') {
      (async () => {
        if (!confirm(`删除历史会话 #${id} 及其全部敲击记录? 不可恢复`)) return;
        await Store.deleteSession(id);
        if (state.viewSid === id) {
          state.viewSid = null;
          state.records = [];
          renderList();
        }
        renderHistory();
        toast(`已删除会话 #${id}`);
      })();
    }
  });

  /* ================= 导出 .dat ================= */

  function downloadDat(hits, labelPart = '') {
    const frac = getFrac();
    const lines = hits.map((r) => fmtRecord(r.t, frac));
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'application/octet-stream' });
    const prefix = (state.settings.prefix || 'timelogger').trim().replace(/[\\/:*?"<>|\s]+/g, '-');
    const name = `${prefix || 'timelogger'}_${labelPart}${fmtStamp(Date.now() + state.offsetMs)}.dat`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
    return name;
  }

  async function exportSession(id) {
    const hits = await Store.getHits(id);
    if (!hits.length) { toast(`会话 #${id} 没有敲击记录`); return; }
    const name = downloadDat(hits, `s${id}_`);
    toast(`已导出会话 #${id}: ${hits.length} 条时间戳 → ${name}`, 3400);
  }

  async function exportCurrent() {
    const hits = state.records.length
      ? state.records
      : (state.viewSid ? await Store.getHits(state.viewSid) : []);
    if (!hits.length) { toast('暂无记录可导出, 可在"历史记录"中导出历史会话'); return; }
    const name = downloadDat(hits);
    toast(`已导出 ${hits.length} 条时间戳: ${name}`, 3400);
  }

  async function exportAllSessions() {
    const sessions = (await Store.getSessions()).slice().sort((a, b) => a.startT - b.startT);
    if (!sessions.length) { toast('暂无历史记录'); return; }
    const frac = getFrac();
    const out = [];
    let total = 0;
    for (const s of sessions) {
      const hits = await Store.getHits(s.id);
      if (!hits.length) continue;
      out.push(`# ===== 会话 #${s.id} | ${fmtDateFull(s.startT)} ${fmtHMS(s.startT)} ~ ${s.endT ? fmtHMS(s.endT) : '未正常结束'} | ${hits.length} 次敲击${s.note ? ' | ' + s.note : ''} =====`);
      for (const h of hits) out.push(fmtRecord(h.t, frac));
      total += hits.length;
    }
    if (!total) { toast('所有会话均无敲击记录'); return; }
    const blob = new Blob([out.join('\n') + '\n'], { type: 'application/octet-stream' });
    const prefix = (state.settings.prefix || 'timelogger').trim().replace(/[\\/:*?"<>|\s]+/g, '-');
    const name = `${prefix || 'timelogger'}_all_${fmtStamp(Date.now() + state.offsetMs)}.dat`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
    toast(`已导出 ${sessions.length} 次会话共 ${total} 条 (含#注释行): ${name}`, 3800);
  }

  /* ================= 声音检测核心 ================= */

  function onAudioProcess(event) {
    const input = event.inputBuffer.getChannelData(0);
    const n = input.length;
    const now = Date.now();
    const bufferMs = (n / sampleRate) * 1000;

    // 锚点: 当前缓冲区"末样本"对应的墙钟时刻。
    // 按采样率推进(而非直接取 Date.now()), 可抗主线程卡顿导致的回调延迟;
    // 回调间隔超过500ms视为音频挂起(如切后台), 重新锚定。
    if (!lastCbWall || now - lastCbWall > 500) anchorWall = now;
    else anchorWall += bufferMs;
    lastCbWall = now;

    // 统计峰值/RMS
    let peak = 0, sumSq = 0, peakIdx = 0;
    for (let i = 0; i < n; i++) {
      const v = input[i];
      const a = v < 0 ? -v : v;
      sumSq += v * v;
      if (a > peak) { peak = a; peakIdx = i; }
    }
    const rms = Math.sqrt(sumSq / n);

    // 自适应噪声底(升慢降快)
    const k = rms > noiseFloor ? 0.01 : 0.06;
    noiseFloor = Math.max(1e-5, noiseFloor + (rms - noiseFloor) * k);

    // 削波提示
    if (peak > 0.985) clipCount = Math.min(clipCount + 1, 30);
    else if (clipCount > 0) clipCount--;
    clipHint.hidden = clipCount < 8;

    // 敲击判定: 幅度超阈值 + 骤升 + 脉冲性(峰值远高于均方根)
    const th = state.settings.threshold;
    const warmup = now - startWallMs < 1200; // 启动预热, 避开开机爆音
    let hit = false;

    if (!warmup &&
        now - lastTriggerTs >= state.settings.refractoryMs &&
        peak >= th &&
        rms > noiseFloor * 4 &&
        rms > prevRms * 2.2 &&
        peak > rms * 2.5) {

      // 从峰值回退定位敲击起始样本(幅度降至峰值15%或阈值30%处)
      const onsetLevel = Math.max(th * 0.3, peak * 0.15);
      let onsetIdx = peakIdx;
      while (onsetIdx > 0 && Math.abs(input[onsetIdx]) > onsetLevel) onsetIdx--;

      // 起始到峰值应足够快(锤击为瞬态冲击)
      const attackMs = ((peakIdx - onsetIdx) / sampleRate) * 1000;
      if (attackMs <= 60) {
        // 敲击时刻 = 缓冲区末锚点 - 输入链路延迟 - 起始样本到末尾的时长 - 附加补偿
        const strikeMs = anchorWall
          - inputLatencyMs
          - state.settings.extraCompMs
          - ((n - onsetIdx) / sampleRate) * 1000;
        addRecord({ t: Math.round(strikeMs) + state.offsetMs, src: 'auto', lvl: Math.round(peak * 1000) / 1000 })
          .catch((e) => console.warn('记录写入失败:', e));
        lastTriggerTs = now;
        hit = true;
        detectFX();
      }
    }

    levels.push({ v: peak, hit });
    if (levels.length > MAX_LEVELS) levels.shift();
    prevRms = rms;
  }

  /* ================= 音频开启/关闭 ================= */

  async function startRecording() {
    if (busy) return;
    busy = true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      busy = false;
      toast('当前环境无法访问麦克风, 请通过 HTTPS 访问本页面', 3600);
      return;
    }
    // iOS 要求在用户手势内创建并恢复 AudioContext
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { busy = false; toast('当前浏览器不支持 Web Audio'); return; }
    audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});

    try {
      // 关闭浏览器内置回声消除/降噪/自动增益, 获取原始瞬态信号
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (err) {
      try { audioCtx.close(); } catch (e) { /* 忽略 */ }
      audioCtx = null;
      busy = false;
      const msg = err && err.name === 'NotAllowedError'
        ? '麦克风权限被拒绝, 请在浏览器设置中允许后重试'
        : '无法获取麦克风: ' + ((err && err.message) || err);
      toast(msg, 3600);
      setMicState('权限被拒绝', 'bad');
      return;
    }

    try {
      sampleRate = audioCtx.sampleRate;
      inputLatencyMs = (typeof audioCtx.inputLatency === 'number' && audioCtx.inputLatency > 0
        ? audioCtx.inputLatency : 0.015) * 1000;
      compInfo.textContent = `正值延后、负值提前; 系统已自动补偿音频链路延迟约 ${Math.round(inputLatencyMs)}ms`;

      sourceNode = audioCtx.createMediaStreamSource(stream);
      processorNode = audioCtx.createScriptProcessor(2048, 1, 1);
      processorNode.onaudioprocess = onAudioProcess;
      sourceNode.connect(processorNode);
      // 经零增益节点接至输出: 保证回调持续触发且不产生声音(兼容 Safari)
      muteNode = audioCtx.createGain();
      muteNode.gain.value = 0;
      processorNode.connect(muteNode);
      muteNode.connect(audioCtx.destination);

      // 重置检测状态
      noiseFloor = 1e-4; prevRms = 0;
      anchorWall = 0; lastCbWall = 0;
      startWallMs = Date.now();
      lastTriggerTs = startWallMs;
      levels.length = 0;
      clipCount = 0;
      clipHint.hidden = true;

      await beginSession(); // 本次开始~结束存为一条历史会话

      state.recording = true;
      updateRecordingUI();
      setMicState('监听中', 'ok');
      requestWakeLock();
      audioCtx.onstatechange = () => {
        if (!audioCtx || !state.recording) return;
        if (audioCtx.state === 'suspended') setMicState('音频已挂起', 'bad');
        else if (audioCtx.state === 'running') setMicState('监听中', 'ok');
      };
      toast('已开始监听 (约1秒预热)');
    } catch (err) {
      stopRecording();
      toast('音频初始化失败: ' + ((err && err.message) || err), 3200);
    }
    busy = false;
  }

  function stopRecording() {
    state.recording = false;
    try { if (processorNode) processorNode.onaudioprocess = null; } catch (e) { /* 忽略 */ }
    try { if (sourceNode) sourceNode.disconnect(); } catch (e) { /* 忽略 */ }
    try { if (processorNode) processorNode.disconnect(); } catch (e) { /* 忽略 */ }
    try { if (muteNode) muteNode.disconnect(); } catch (e) { /* 忽略 */ }
    try { if (audioCtx) audioCtx.close(); } catch (e) { /* 忽略 */ }
    if (stream) stream.getTracks().forEach((t) => t.stop());
    audioCtx = null; stream = null; sourceNode = null; processorNode = null; muteNode = null;
    setMicState('已停止', '');
    updateRecordingUI();
    releaseWakeLock();
    // 结束记录 → 收尾会话 → 自动触发一次同步备份
    finalizeSession()
      .then(() => updateSyncPending())
      .then(() => runSync('stop'))
      .catch((e) => console.warn('会话收尾失败:', e));
  }

  function updateRecordingUI() {
    const on = state.recording;
    btnToggle.classList.toggle('recording', on);
    btnLabel.textContent = on ? '停止记录' : '开始记录';
    iconPlay.style.display = on ? 'none' : '';
    iconStop.style.display = on ? '' : 'none';
  }

  /* ================= 屏幕常亮 ================= */

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { /* 请求失败不影响主功能 */ }
  }
  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (state.recording && audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      if (state.recording && !wakeLock) requestWakeLock();
    }
  });

  /* ================= 电平表绘制 ================= */

  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const r = meterCanvas.getBoundingClientRect();
    meterCanvas.width = Math.max(1, Math.round(r.width * dpr));
    meterCanvas.height = Math.max(1, Math.round(r.height * dpr));
  }
  window.addEventListener('resize', sizeCanvas);

  function drawMeter() {
    const ctx = meterCanvas.getContext('2d');
    const w = meterCanvas.width, h = meterCanvas.height;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);

    const th = state.settings.threshold;
    const topPad = 6 * (window.devicePixelRatio || 1);
    const usable = h - topPad - 4 * (window.devicePixelRatio || 1);
    const ty = topPad + usable * (1 - th);

    // 阈值线(红色虚线)
    ctx.strokeStyle = 'rgba(248,113,113,.85)';
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, ty);
    ctx.lineTo(w, ty);
    ctx.stroke();
    ctx.setLineDash([]);

    const n = levels.length;
    if (!n) {
      ctx.fillStyle = plotColors.scale;
      ctx.font = `${12 * (window.devicePixelRatio || 1)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('开始记录后显示实时电平 (红虚线为触发阈值)', w / 2, h / 2 + 4);
      return;
    }
    const bw = w / MAX_LEVELS;
    const x0 = w - n * bw; // 最新靠右
    for (let i = 0; i < n; i++) {
      const L = levels[i];
      const bh = Math.max(2, L.v * usable);
      ctx.fillStyle = L.hit ? plotColors.hit : (L.v >= th ? plotColors.warn : plotColors.bar);
      ctx.fillRect(x0 + i * bw, topPad + usable - bh, Math.max(1.5, bw - 1.5), bh);
    }
  }

  /* ================= 网络校时 ================= */

  function parseIsoCut(s, appendBj) {
    if (!s) return NaN;
    let t = String(s).trim().replace(/(\.\d{3})\d+/, '$1'); // 截断亚毫秒
    if (appendBj && !/[zZ+]/.test(t.slice(-6))) t += '+08:00';
    const v = Date.parse(t);
    return isNaN(v) ? NaN : v;
  }

  function applySyncResult(offset, rtt) {
    btnSync.disabled = false;
    if (Math.abs(offset) > 100) {
      state.offsetMs = offset;
      syncBadge.classList.add('synced');
      syncText.textContent = '已网络校时';
      syncStatus.textContent = `已应用网络校时: 修正 ${offset > 0 ? '+' : ''}${offset}ms (网络往返 ${rtt}ms, 本会话有效)`;
      toast(`已按网络时间校准 ${offset > 0 ? '+' : ''}${offset}ms`);
    } else {
      state.offsetMs = 0;
      syncBadge.classList.add('synced');
      syncText.textContent = '设备时间准确';
      syncStatus.textContent = `设备时间与北京时间偏差 ${offset > 0 ? '+' : ''}${offset}ms (100ms内无需修正, 网络往返 ${rtt}ms)`;
      toast('设备时间准确, 偏差在100ms内');
    }
  }

  async function syncNetworkTime() {
    btnSync.disabled = true;
    syncStatus.textContent = '正在网络校时…';
    const probes = [
      { url: 'https://worldtimeapi.org/api/timezone/Asia/Shanghai', parse: (j) => parseIsoCut(j.datetime) },
      { url: 'https://timeapi.io/api/Time/current/zone?timeZone=Asia/Shanghai', parse: (j) => parseIsoCut(j.dateTime, true) },
    ];
    for (const p of probes) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 6000);
        const t0 = Date.now();
        const res = await fetch(p.url, { cache: 'no-store', signal: ctl.signal });
        clearTimeout(timer);
        if (!res.ok) continue;
        const j = await res.json();
        const t1 = Date.now();
        const serverMs = p.parse(j);
        if (!isFinite(serverMs)) continue;
        const rtt = t1 - t0;
        // 假设网络对称: 服务器时间对应本地时刻 t0 + rtt/2
        applySyncResult(Math.round(serverMs - (t0 + rtt / 2)), rtt);
        return;
      } catch (e) { /* 尝试下一个源 */ }
    }
    btnSync.disabled = false;
    syncStatus.textContent = '校时失败 (无网络或校时服务不可用), 继续使用设备时间';
    toast('网络校时失败, 使用设备时间');
  }

  /* ================= 声音阈值校正 ================= */

  // 校正流程: 独立音频流(不干扰正在进行的记录), 两步走:
  //  ① 基线测量(3秒安静环境) → ② 用户敲击一次后点确认, 分析最近2.5秒环形缓冲,
  //  按噪音基线安全裕量与敲击峰值折扣计算新阈值并持久化; 可选"测试"模式即时验证。
  const CALIB_BASE_MS = 3000;      // 基线测量时长
  const CALIB_RING_S = 2.5;        // 环形缓冲秒数(覆盖"敲击后点确认"的延迟)
  const CALIB_TEST_MS = 20000;     // 测试模式超时
  const CALIB_NOISY_PK = 0.08;     // 基线峰值超过此值判定环境噪音过高
  const CALIB_MIN_STRIKE = 0.04;   // 敲击峰值低于此值判定声音强度不足
  const calib = {
    active: false,
    phase: 'idle', // idle | baseline | strike | done | testing
    ctx: null, stream: null, source: null, processor: null, mute: null,
    rate: 48000,
    ring: [], ringSamples: 0,   // 原始样本环形缓冲(Float32Array块)
    levels: [],                 // 实时电平历史(可视化)
    basePeaks: [], baseRms: [], baseStart: 0,
    noisePk: 0, noiseRms: 0,
    result: null,
    testStart: 0, lastTestTrig: 0,
  };

  function setCalibPhase(cls, text) {
    calibPhase.className = 'calib-phase ' + cls;
    calibPhaseText.textContent = text;
  }
  function setCalibTip(html) { calibTip.innerHTML = html; }

  function sizeCalibCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const r = calibCanvas.getBoundingClientRect();
    calibCanvas.width = Math.max(1, Math.round(r.width * dpr));
    calibCanvas.height = Math.max(1, Math.round(r.height * dpr));
  }
  window.addEventListener('resize', () => { if (calib.active) sizeCalibCanvas(); });

  // 校正弹窗实时电平图: 与主页电平表同风格, 红虚线为当前(或新)阈值
  function drawCalib() {
    if (calibCanvas.hidden) return;
    const ctx = calibCanvas.getContext('2d');
    const w = calibCanvas.width, h = calibCanvas.height;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    const th = calib.result ? calib.result.th : state.settings.threshold;
    const dpr = window.devicePixelRatio || 1;
    const topPad = 6 * dpr, usable = h - topPad - 4 * dpr;
    const ty = topPad + usable * (1 - th);
    ctx.strokeStyle = 'rgba(248,113,113,.85)';
    ctx.setLineDash([6, 5]); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(w, ty); ctx.stroke();
    ctx.setLineDash([]);
    const n = calib.levels.length;
    if (!n) {
      ctx.fillStyle = plotColors.scale;
      ctx.font = (12 * dpr) + 'px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('正在启动麦克风…', w / 2, h / 2 + 4);
      return;
    }
    const bw = w / MAX_LEVELS;
    const x0 = w - n * bw;
    for (let i = 0; i < n; i++) {
      const v = calib.levels[i];
      const bh = Math.max(2, v * usable);
      ctx.fillStyle = v >= th ? plotColors.warn : plotColors.bar;
      ctx.fillRect(x0 + i * bw, topPad + usable - bh, Math.max(1.5, bw - 1.5), bh);
    }
  }

  // 迭代基-2 FFT(原位), 用于敲击样本的频谱特征
  function fftInPlace(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const ur = re[i + k], ui = im[i + k];
          const xr = re[i + k + half], xi = im[i + k + half];
          const vr = xr * cr - xi * ci, vi = xr * ci + xi * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  // 对样本窗做汉宁加窗FFT, 返回频谱质心/主导频率/分频段能量占比
  function spectralFeatures(win, rate) {
    const n = win.length;
    const re = new Float32Array(n), im = new Float32Array(n);
    let en = 0;
    for (let i = 0; i < n; i++) {
      const hann = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
      re[i] = win[i] * hann;
      en += re[i] * re[i];
    }
    fftInPlace(re, im);
    const mags = [];
    let sumM = 0, sumFM = 0, maxM = 0, maxK = 0;
    for (let k = 1; k < n / 2; k++) {
      const m = Math.hypot(re[k], im[k]);
      const f = k * rate / n;
      if (f < 30 || f > 16000) continue; // 忽略次声与超声段
      mags.push({ f: f, m: m });
      sumM += m; sumFM += f * m;
      if (m > maxM) { maxM = m; maxK = mags.length - 1; }
    }
    let low = 0, mid = 0, high = 0;
    for (let gi = 0; gi < mags.length; gi++) {
      const g = mags[gi];
      const p = g.m / (sumM || 1);
      if (g.f < 250) low += p; else if (g.f < 2000) mid += p; else high += p;
    }
    return {
      centroidHz: sumM ? Math.round(sumFM / sumM) : 0,
      domHz: Math.round(mags.length ? mags[maxK].f : 0),
      lowPct: Math.round(low * 100), midPct: Math.round(mid * 100), highPct: Math.round(high * 100),
      windowEnergy: en / n,
    };
  }

  // 基线测量完成: 计算噪音基线并做"环境噪音过高"判定
  function finishBaseline() {
    calib.basePeaks.sort((a, b) => a - b);
    calib.noisePk = calib.basePeaks[Math.floor(calib.basePeaks.length * 0.95)] || 0;
    calib.noiseRms = calib.baseRms.reduce((a, b) => a + b, 0) / (calib.baseRms.length || 1);
    if (calib.noisePk >= CALIB_NOISY_PK) {
      setCalibPhase('error', '环境噪音过高');
      setCalibTip('当前环境噪音基线峰值 <b>' + calib.noisePk.toFixed(3) + '</b>, 已接近敲击信号强度, 无法区分有效敲击。<br>请更换到更安静的环境(关闭风机/车流/人声等)后, 点击【重新校正】');
      calibConfirm.disabled = false;
      calibConfirm.textContent = '重新校正';
      calib.phase = 'idle'; // 等待用户点"重新校正"重启流程
      calibConfirm.dataset.retry = '1';
      return;
    }
    calib.phase = 'strike';
    setCalibPhase('waiting', '第 2 步 · 请敲击一次');
    setCalibTip('基线测量完成(噪音峰值 ' + calib.noisePk.toFixed(3) + ')。<br><b>请现在用锤子以实际检测的力度敲击一次地面</b>, 完成后点击【我已敲击 · 确认】');
    calibConfirm.disabled = false;
    calibConfirm.textContent = '我已敲击 · 确认';
  }

  // 分析环形缓冲中的敲击样本并计算新阈值
  function analyzeStrike() {
    // 拼接环形缓冲
    const total = calib.ringSamples;
    const buf = new Float32Array(total);
    let off = 0;
    for (const c of calib.ring) { buf.set(c, off); off += c.length; }

    // 找峰值
    let peak = 0, peakIdx = 0;
    for (let i = 0; i < total; i++) {
      const a = buf[i] < 0 ? -buf[i] : buf[i];
      if (a > peak) { peak = a; peakIdx = i; }
    }

    // 异常: 敲击声音强度不足
    if (peak < CALIB_MIN_STRIKE || peak < calib.noisePk * 4) {
      const snr = calib.noisePk > 1e-4 ? (20 * Math.log10(peak / calib.noisePk)).toFixed(1) : '∞';
      setCalibPhase('error', '声音强度不足');
      setCalibTip('最近 ' + CALIB_RING_S + ' 秒内未检测到足够强度的敲击 (峰值 ' + peak.toFixed(3) + ', 信噪比 ' + snr + 'dB)。<br>请用更大的力度敲击, 或将手机靠近敲击点, 然后再次点击【我已敲击 · 确认】');
      calib.phase = 'strike'; // 保持监听, 允许重试
      return;
    }

    // 峰值附近 RMS(敲击段) 与频谱特征(起始处1024样本)
    let onsetIdx = peakIdx;
    const onsetLevel = Math.max(peak * 0.15, calib.noisePk * 2);
    while (onsetIdx > 0 && Math.abs(buf[onsetIdx]) > onsetLevel) onsetIdx--;
    const endIdx = Math.min(total, peakIdx + Math.round(calib.rate * 0.1)); // 峰后100ms
    let sumSq = 0, cnt = 0;
    for (let i = onsetIdx; i < endIdx; i++) { sumSq += buf[i] * buf[i]; cnt++; }
    const strikeRms = cnt ? Math.sqrt(sumSq / cnt) : 0;
    const specStart = Math.max(0, Math.min(onsetIdx, total - 1024));
    const spec = spectralFeatures(buf.subarray(specStart, specStart + 1024), calib.rate);

    // 阈值算法: 噪音基线安全裕量与敲击峰值折扣二者取大, 保证噪音不触发且敲击可触发
    const noiseGuard = calib.noisePk * 3;
    const strikeRatio = peak * 0.30;
    let th = Math.max(noiseGuard, strikeRatio);
    th = Math.min(th, peak * 0.6);    // 上限: 不超过敲击峰值的60%
    th = Math.min(0.95, Math.max(0.02, th));
    th = Math.round(th * 100) / 100;

    const snrDb = calib.noisePk > 1e-4 ? (20 * Math.log10(peak / calib.noisePk)) : 40;
    const clipped = peak > 0.985;

    // 应用并持久化
    state.settings.threshold = th;
    setThreshold.value = String(th);
    thVal.textContent = th.toFixed(2);
    saveSettings();

    calib.result = { th: th, peak: peak, strikeRms: strikeRms, snrDb: snrDb, clipped: clipped, spec: spec };
    calib.phase = 'done';
    calibResult.hidden = false;
    let rows =
      '<div class="th-big">新触发阈值 ' + th.toFixed(2) + '</div>' +
      '<table>' +
      '<tr><td>环境噪音基线</td><td>峰值 ' + calib.noisePk.toFixed(3) + ' · RMS ' + calib.noiseRms.toFixed(4) + '</td></tr>' +
      '<tr><td>敲击峰值振幅</td><td>' + peak.toFixed(3) + ' · RMS ' + strikeRms.toFixed(3) + '</td></tr>' +
      '<tr><td>信噪比</td><td>' + snrDb.toFixed(1) + ' dB</td></tr>' +
      '<tr><td>频谱质心 / 主导频率</td><td>' + spec.centroidHz + ' Hz / ' + spec.domHz + ' Hz</td></tr>' +
      '<tr><td>频段能量占比</td><td>低频 ' + spec.lowPct + '% · 中频 ' + spec.midPct + '% · 高频 ' + spec.highPct + '%</td></tr>' +
      '<tr><td>音频采样</td><td>' + (calib.rate / 1000).toFixed(1) + ' kHz · 单声道</td></tr>' +
      '</table>';
    if (clipped) {
      rows += '<p class="warn-line">警告: 敲击信号已削波(过载), 建议将手机稍微远离敲击点后重新校正, 否则弱敲击可能漏检</p>';
    }
    calibResult.innerHTML = rows;
    setCalibPhase('done', '校正完成');
    setCalibTip('阈值已应用并保存, 立即生效(含正在进行的记录)。<br>可点击【测试】再敲击一次验证新阈值效果');
    calibConfirm.disabled = false;
    calibConfirm.textContent = '重新校正';
    calibTest.disabled = false;
    calibCancel.textContent = '完成';
    toast('校正完成, 新触发阈值 ' + th.toFixed(2));
  }

  // 测试模式: 用新阈值实时判定敲击(仅反馈, 不记录), 验证校正效果
  function startTest() {
    calib.phase = 'testing';
    calib.testStart = Date.now();
    calib.lastTestTrig = 0;
    calibTest.disabled = true;
    calibConfirm.disabled = true;
    calibCancel.textContent = '结束测试';
    setCalibPhase('testing', '测试中 · 请敲击一次');
    setCalibTip('<b>请现在敲击一次地面</b>, 若新阈值合适, 此处将立即显示"检测到敲击"');
    calibResult.hidden = true;
  }
  function endTest(ok, msg) {
    calib.phase = 'done';
    calibTest.disabled = false;
    calibConfirm.disabled = false;
    calibConfirm.textContent = '重新校正';
    calibCancel.textContent = '完成';
    calibResult.hidden = false;
    if (ok) {
      setCalibPhase('done', '测试通过');
      setCalibTip('<b>已检测到有效敲击 ✓</b> — ' + msg + '<br>新阈值工作正常, 点击【完成】结束校正');
      detectFX();
    } else {
      setCalibPhase('error', '测试未通过');
      setCalibTip(msg);
    }
  }

  // 校正音频回调: 环形缓冲 + 基线统计 + 测试判定
  function onCalibProcess(event) {
    const input = event.inputBuffer.getChannelData(0);
    const n = input.length;
    let peak = 0, sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = input[i];
      const a = v < 0 ? -v : v;
      sumSq += v * v;
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sumSq / n);

    // 环形缓冲(必须拷贝, 回调缓冲区会被复用)
    calib.ring.push(input.slice());
    calib.ringSamples += n;
    const maxKeep = calib.rate * CALIB_RING_S;
    while (calib.ringSamples - calib.ring[0].length >= maxKeep) {
      calib.ringSamples -= calib.ring.shift().length;
    }

    if (calib.phase === 'baseline') {
      calib.basePeaks.push(peak);
      calib.baseRms.push(rms);
      if (Date.now() - calib.baseStart >= CALIB_BASE_MS) finishBaseline();
    } else if (calib.phase === 'testing') {
      const th = calib.result ? calib.result.th : state.settings.threshold;
      const now = Date.now();
      if (now - calib.testStart > CALIB_TEST_MS) {
        endTest(false, '超时未检测到敲击。可点击【测试】重试, 或【重新校正】');
      } else if (peak >= th && rms > calib.noiseRms * 3 && peak > rms * 2.5 && now - calib.lastTestTrig > 600) {
        calib.lastTestTrig = now;
        endTest(true, '峰值 ' + peak.toFixed(3) + ' ≥ 阈值 ' + th.toFixed(2) + ', 信噪比充足');
      }
    }

    calib.levels.push(peak);
    if (calib.levels.length > MAX_LEVELS) calib.levels.shift();
  }

  async function startCalib() {
    if (calib.active) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('当前环境无法访问麦克风, 请通过 HTTPS 访问本页面', 3600);
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { toast('当前浏览器不支持 Web Audio'); return; }

    calibModal.hidden = false;
    calibResult.hidden = true;
    sizeCalibCanvas();
    setCalibPhase('measuring', '第 1 步 · 测量噪音基线');
    setCalibTip('正在启动麦克风, 请稍候…');
    calibConfirm.disabled = true;
    calibTest.disabled = true;
    calibCancel.textContent = '取消';
    delete calibConfirm.dataset.retry;

    calib.active = true;
    calib.phase = 'baseline';
    calib.ring = []; calib.ringSamples = 0;
    calib.levels = [];
    calib.basePeaks = []; calib.baseRms = [];
    calib.result = null;

    calib.ctx = new AC();
    try {
      if (calib.ctx.state === 'suspended') await calib.ctx.resume().catch(() => {});
      // 与主检测一致的原始信号约束, 并请求 ≥44.1kHz 采样率(设备不满足时浏览器自动回退)
      // 加15秒超时: 部分浏览器权限确认UI挂起时 getUserMedia 会永久pending, 需主动报错
      calib.stream = await Promise.race([
        navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false, noiseSuppression: false, autoGainControl: false,
            channelCount: 1, sampleRate: 44100,
          },
        }),
        new Promise((_, rej) => setTimeout(
          () => rej(new Error('麦克风启动超时(15秒), 请检查浏览器麦克风权限设置后重试')), 15000)),
      ]);
    } catch (err) {
      const msg = err && err.name === 'NotAllowedError'
        ? '麦克风权限被拒绝, 请在浏览器设置中允许后重试'
        : '无法获取麦克风: ' + ((err && err.message) || err);
      toast(msg, 3600);
      cancelCalib();
      return;
    }

    calib.rate = calib.ctx.sampleRate;
    calib.source = calib.ctx.createMediaStreamSource(calib.stream);
    calib.processor = calib.ctx.createScriptProcessor(2048, 1, 1);
    calib.processor.onaudioprocess = onCalibProcess;
    calib.source.connect(calib.processor);
    calib.mute = calib.ctx.createGain();
    calib.mute.gain.value = 0;
    calib.processor.connect(calib.mute);
    calib.mute.connect(calib.ctx.destination);
    calib.baseStart = Date.now();
    setCalibTip('<b>第 1 步 / 共 2 步</b> · 正在测量环境噪音基线 (' + (CALIB_BASE_MS / 1000) + '秒)…<br>请保持现场安静, 不要说话和移动手机');
  }

  function stopCalibAudio() {
    try { if (calib.processor) calib.processor.onaudioprocess = null; } catch (e) { /* 忽略 */ }
    try { if (calib.source) calib.source.disconnect(); } catch (e) { /* 忽略 */ }
    try { if (calib.processor) calib.processor.disconnect(); } catch (e) { /* 忽略 */ }
    try { if (calib.mute) calib.mute.disconnect(); } catch (e) { /* 忽略 */ }
    try { if (calib.ctx) calib.ctx.close(); } catch (e) { /* 忽略 */ }
    if (calib.stream) calib.stream.getTracks().forEach((t) => t.stop());
    calib.ctx = null; calib.stream = null; calib.source = null; calib.processor = null; calib.mute = null;
  }

  function cancelCalib() {
    // 测试模式中点"结束测试"仅退出测试, 不关闭弹窗
    if (calib.phase === 'testing' && calib.result) {
      endTest(false, '已结束测试, 可点击【测试】重试或【重新校正】');
      calib.phase = 'done';
      setCalibPhase('done', '校正完成');
      return;
    }
    stopCalibAudio();
    calib.active = false;
    calib.phase = 'idle';
    calibModal.hidden = true;
  }

  function confirmCalib() {
    // 噪音过高后的"重新校正" / 完成后的"重新校正": 重启完整流程
    if (calibConfirm.dataset.retry || calib.phase === 'done' || calib.phase === 'idle') {
      delete calibConfirm.dataset.retry;
      stopCalibAudio();
      calib.active = false;
      startCalib();
      return;
    }
    if (calib.phase !== 'strike') return;
    analyzeStrike();
  }

  btnCalib.addEventListener('click', () => {
    // 展开设置面板以便看到校正结果反映到阈值滑块
    settingsBox.open = true;
    startCalib();
  });
  calibConfirm.addEventListener('click', confirmCalib);
  calibTest.addEventListener('click', () => { if (calib.phase === 'done') startTest(); });
  calibCancel.addEventListener('click', cancelCalib);


  /* ================= 实时时钟 ================= */

  let lastDateUpdate = 0;
  // CALIB_ANCHOR
  function frame() {
    const now = Date.now() + state.offsetMs;
    clockEl.textContent = fmtClock(now);
    if (now - lastDateUpdate > 1000) {
      dateLine.textContent = fmtDateLine(now);
      fitAll(); // 每秒校准一次字号, 覆盖字体加载/旋转/缩放等变化
      lastDateUpdate = now;
    }
    drawMeter();
    if (calib.active) drawCalib();
    requestAnimationFrame(frame);
  }

  /* ================= 事件绑定 ================= */

  btnToggle.addEventListener('click', () => {
    if (state.recording) stopRecording();
    else startRecording();
  });
  btnManual.addEventListener('click', manualRecord);
  btnUndo.addEventListener('click', undoRecord);
  btnClear.addEventListener('click', clearRecords);
  btnExport.addEventListener('click', exportCurrent);
  btnExportAll.addEventListener('click', exportAllSessions);
  btnSync.addEventListener('click', syncNetworkTime);
  document.querySelectorAll('.tabbar .tab').forEach((t) =>
    t.addEventListener('click', () => switchTab(t.dataset.tab)));
  btnTheme.addEventListener('click', () => {
    state.settings.theme = state.settings.theme === 'light' ? 'dark' : 'light';
    saveSettings();
    applyTheme();
  });
  btnSyncNow.addEventListener('click', () => runSync('manual'));
  setToken.addEventListener('input', () => {
    state.settings.syncToken = setToken.value.trim();
    saveSettings();
  });
  setSyncServer.addEventListener('input', () => {
    state.settings.syncServer = setSyncServer.value.trim();
    saveSettings();
    clearTimeout(window.__tkDetect);
    window.__tkDetect = setTimeout(detectTokenRequirement, 800);
  });
  window.addEventListener('online', () => {
    if (sync.pendingHits + sync.pendingSessions > 0) runSync('online');
  });
  window.addEventListener('offline', () => { if (!sync.running) setSyncState('offline'); });

  setThreshold.addEventListener('input', () => {
    state.settings.threshold = parseFloat(setThreshold.value);
    thVal.textContent = state.settings.threshold.toFixed(2);
    saveSettings();
  });
  setRefractory.addEventListener('input', () => {
    state.settings.refractoryMs = Math.round(parseFloat(setRefractory.value));
    rfVal.textContent = String(state.settings.refractoryMs);
    saveSettings();
  });
  setPrecision.addEventListener('change', () => {
    let v = parseInt(setPrecision.value, 10);
    if (!Number.isInteger(v)) v = DEFAULT_SETTINGS.precision;
    state.settings.precision = Math.min(6, Math.max(2, v));
    setPrecision.value = String(state.settings.precision);
    saveSettings();
    renderList();
  });
  setPrefix.addEventListener('input', () => {
    state.settings.prefix = setPrefix.value.trim();
    saveSettings();
  });
  setComp.addEventListener('input', () => {
    let v = parseInt(setComp.value, 10);
    if (!Number.isInteger(v)) v = 0;
    state.settings.extraCompMs = Math.max(-2000, Math.min(2000, v));
    saveSettings();
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.recording) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ================= 初始化 ================= */

  function initSettingsUI() {
    const s = state.settings;
    setThreshold.value = s.threshold;
    thVal.textContent = s.threshold.toFixed(2);
    setRefractory.value = s.refractoryMs;
    rfVal.textContent = String(s.refractoryMs);
    setPrecision.value = String(Math.min(6, Math.max(2, s.precision | 0 || 2)));
    setPrefix.value = s.prefix || '';
    setComp.value = s.extraCompMs || 0;
    setToken.value = s.syncToken || '';
    // setSyncServer 由 applyDefaultSyncServer() 处理(带默认值回填), 此处不覆盖
  }

  async function init() {
    loadPersisted();
    loadSyncMeta();
    applyTheme();
    applyDefaultSyncServer();
    detectTokenRequirement();
    initSettingsUI();
    updateRecordingUI();
    sizeCanvas();
    renderList();
    requestAnimationFrame(frame);

    const ok = await dbOpen();
    if (!ok) toast('IndexedDB 不可用, 已降级为内存存储 (刷新后数据可能丢失)', 3600);
    await migrateLegacy();
    await backfillSessionUpdatedAt();
    await renderHistory();
    // 恢复显示最近一次会话的记录
    const sessions = await Store.getSessions();
    if (sessions.length) {
      state.viewSid = sessions[0].id;
      state.records = await Store.getHits(state.viewSid);
      renderList();
    }
    fitAll();
    // 启动补同步: 有未上传数据时自动同步一次(不阻塞界面加载)
    setTimeout(() => {
      if (sync.pendingHits + sync.pendingSessions > 0) runSync('init');
    }, 1200);
  }

  init();
})();
