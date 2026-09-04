#!/usr/bin/env node
/* 时间记录器 - 零依赖 HTTPS 静态服务器 + 单向数据同步备份接口
 *
 * 手机浏览器仅在安全上下文(HTTPS)下允许访问麦克风, 故提供本服务器。
 * 首次运行自动调用 openssl 生成自签名证书(有效期10年)。
 *
 * 同步备份接口(客户端 IndexedDB → 服务器, 单向):
 *   POST /api/sync        接收敲击记录与会话数据, 校验SHA-256完整性后落盘, 按唯一键去重(幂等)
 *   GET  /api/sync/stats  汇总各设备备份数量与最近同步日志(供运维查看)
 * 数据落盘位置: data/<设备ID>/
 *   hits.jsonl     敲击记录, 一行一条JSON(追加式)
 *   sessions.json  会话记录, { 会话id: 会话对象 } (每次同步覆盖保存最新状态)
 *   sync.log       服务器侧同步日志
 *
 * 用法: node server.js  (或 npm start)
 * 环境变量: PORT (HTTPS端口, 默认8443), HTTP_PORT (跳转端口, 默认8080)
 *           SYNC_TOKEN (可选; 设置后客户端须在"设置-同步令牌"中填入相同值才允许同步)
 */
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const HTTPS_PORT = parseInt(process.env.PORT || '8443', 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8080', 10);
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';
const WEB_DIR = path.join(ROOT, 'web');
const DATA_DIR = path.join(ROOT, 'data');
const MAX_BODY = 8 * 1024 * 1024; // 同步请求体上限 8MB
const CERT = path.join(ROOT, 'cert.pem');
const KEY = path.join(ROOT, 'key.pem');

function ensureCert() {
  if (fs.existsSync(CERT) && fs.existsSync(KEY)) return true;
  console.log('首次运行: 正在生成自签名证书 (有效期10年)…');
  try {
    const r = spawnSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', KEY, '-out', CERT, '-days', '3650',
      '-subj', '/CN=time-logger',
    ], { stdio: 'inherit' });
    return r.status === 0 && fs.existsSync(CERT) && fs.existsSync(KEY);
  } catch (e) {
    return false;
  }
}

if (!ensureCert()) {
  console.error('无法自动生成证书。请手动执行:');
  console.error('  openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 3650 -subj "/CN=time-logger"');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.dat': 'application/octet-stream',
};

/* ================= 同步备份接口 ================= */

// 与客户端约定的确定性序列化(用于传输完整性校验)
function hitKeyStr(h) {
  return [h.sessionId, h.id, h.t, h.src || 'auto', h.lvl == null ? 0 : h.lvl].join('|');
}
function sessKeyStr(s) {
  return [s.id, s.startT, s.endT == null ? '' : s.endT, s.hitCount,
    s.precision == null ? '' : s.precision, s.note || ''].join('|');
}
function checksumOf(arr, keyFn, algo) {
  const str = arr.map(keyFn).join(';');
  if (algo === 'djb2') {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return String(h >>> 0);
  }
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// 设备数据状态缓存(首次访问时从磁盘加载, 用于去重; 重启服务自动重载)
const deviceCache = new Map();
function ensureDeviceState(deviceId) {
  if (deviceCache.has(deviceId)) return deviceCache.get(deviceId);
  const dir = path.join(DATA_DIR, deviceId);
  fs.mkdirSync(dir, { recursive: true });
  const st = { dir, hitKeys: new Set(), sessKeys: new Map(), sessData: new Map() };
  const hf = path.join(dir, 'hits.jsonl');
  if (fs.existsSync(hf)) {
    for (const line of fs.readFileSync(hf, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { st.hitKeys.add(hitKeyStr(JSON.parse(line))); } catch (e) { /* 跳过坏行 */ }
    }
  }
  const sf = path.join(dir, 'sessions.json');
  if (fs.existsSync(sf)) {
    try {
      const obj = JSON.parse(fs.readFileSync(sf, 'utf8'));
      for (const k of Object.keys(obj)) {
        st.sessData.set(Number(k), obj[k]);
        st.sessKeys.set(Number(k), sessKeyStr(obj[k]));
      }
    } catch (e) { /* 忽略损坏文件, 由下次同步覆盖 */ }
  }
  deviceCache.set(deviceId, st);
  return st;
}

function appendDeviceLog(dir, line) {
  try {
    fs.appendFileSync(path.join(dir, 'sync.log'), `[${new Date().toISOString()}] ${line}\n`);
  } catch (e) { /* 日志失败不影响数据 */ }
}
function ip(req) { return (req.socket && req.socket.remoteAddress) || ''; }
function jsonRes(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit, cb) {
  let size = 0;
  const chunks = [];
  let done = false;
  const fail = (e) => { if (!done) { done = true; cb(e); } };
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { req.destroy(); fail(new Error('too large')); return; }
    chunks.push(c);
  });
  req.on('end', () => { if (!done) { done = true; cb(null, Buffer.concat(chunks)); } });
  req.on('error', fail);
}

function handleSyncPost(req, res) {
  if (SYNC_TOKEN && req.headers['x-sync-token'] !== SYNC_TOKEN) {
    return jsonRes(res, 401, { ok: false, error: 'invalid sync token' });
  }
  readBody(req, MAX_BODY, (err, buf) => {
    if (err) return jsonRes(res, 413, { ok: false, error: 'payload too large' });
    let payload;
    try { payload = JSON.parse(buf.toString('utf8')); }
    catch (e) { return jsonRes(res, 400, { ok: false, error: 'invalid json' }); }
    if (!payload || typeof payload.deviceId !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(payload.deviceId)) {
      return jsonRes(res, 400, { ok: false, error: 'invalid deviceId' });
    }
    let st;
    try { st = ensureDeviceState(payload.deviceId); }
    catch (e) { return jsonRes(res, 500, { ok: false, error: 'storage error' }); }

    const out = { ok: true, storedHits: 0, dupHits: 0, storedSessions: 0, dupSessions: 0, recvChecksum: '' };
    const algo = (payload.hitChecksum && payload.hitChecksum.algo) || 'sha256';

    // ---- 敲击记录: 校验完整性 → 按唯一键去重 → 追加落盘 ----
    if (Array.isArray(payload.hits) && payload.hits.length) {
      const calc = checksumOf(payload.hits, hitKeyStr, algo);
      out.recvChecksum = calc;
      if (!payload.hitChecksum || calc !== payload.hitChecksum.value) {
        appendDeviceLog(st.dir, `REJECT hits: 校验和不一致 ip=${ip(req)}`);
        return jsonRes(res, 400, { ok: false, error: 'hit checksum mismatch' });
      }
      const lines = [];
      for (const h of payload.hits) {
        if (!h || !Number.isFinite(h.id) || !Number.isFinite(h.t) || !Number.isFinite(h.sessionId)) continue;
        const key = hitKeyStr(h);
        if (st.hitKeys.has(key)) { out.dupHits++; continue; }
        st.hitKeys.add(key);
        lines.push(JSON.stringify({
          sessionId: h.sessionId, id: h.id, t: h.t,
          src: h.src === 'manual' ? 'manual' : 'auto', lvl: Number(h.lvl) || 0,
          syncedAt: Date.now(),
        }));
        out.storedHits++;
      }
      if (lines.length) fs.appendFileSync(path.join(st.dir, 'hits.jsonl'), lines.join('\n') + '\n');
    }

    // ---- 会话记录: 校验完整性 → 变更检测 → 覆盖保存最新状态 ----
    if (Array.isArray(payload.sessions) && payload.sessions.length) {
      const calc = checksumOf(payload.sessions, sessKeyStr, algo);
      out.recvChecksum = calc;
      if (!payload.sessChecksum || calc !== payload.sessChecksum.value) {
        appendDeviceLog(st.dir, `REJECT sessions: 校验和不一致 ip=${ip(req)}`);
        return jsonRes(res, 400, { ok: false, error: 'session checksum mismatch' });
      }
      let changed = false;
      for (const s of payload.sessions) {
        if (!s || !Number.isFinite(s.id) || !Number.isFinite(s.startT)) continue;
        const key = sessKeyStr(s);
        if (st.sessKeys.get(s.id) === key) { out.dupSessions++; continue; }
        st.sessKeys.set(s.id, key);
        st.sessData.set(s.id, {
          id: s.id, startT: s.startT, endT: s.endT == null ? null : s.endT,
          hitCount: s.hitCount | 0,
          precision: s.precision == null ? null : s.precision,
          threshold: s.threshold == null ? null : s.threshold,
          refractoryMs: s.refractoryMs == null ? null : s.refractoryMs,
          note: String(s.note || ''), updatedAt: s.updatedAt || 0,
          syncedAt: Date.now(),
        });
        out.storedSessions++;
        changed = true;
      }
      if (changed) {
        const obj = {};
        for (const [id, s] of st.sessData) obj[id] = s;
        fs.writeFileSync(path.join(st.dir, 'sessions.json'), JSON.stringify(obj, null, 1));
      }
    }

    appendDeviceLog(st.dir, `SYNC 敲击 新增${out.storedHits}/重复${out.dupHits}, 会话 新增${out.storedSessions}/重复${out.dupSessions}, ip=${ip(req)}`);
    jsonRes(res, 200, out);
  });
}

function handleStats(req, res) {
  const devices = [];
  try {
    for (const name of fs.readdirSync(DATA_DIR)) {
      const dir = path.join(DATA_DIR, name);
      let stat;
      try { stat = fs.statSync(dir); } catch (e) { continue; }
      if (!stat.isDirectory()) continue;
      const hf = path.join(dir, 'hits.jsonl');
      const sf = path.join(dir, 'sessions.json');
      const lf = path.join(dir, 'sync.log');
      let hits = 0;
      if (fs.existsSync(hf)) hits = fs.readFileSync(hf, 'utf8').split('\n').filter((l) => l.trim()).length;
      let sessions = 0;
      if (fs.existsSync(sf)) {
        try { sessions = Object.keys(JSON.parse(fs.readFileSync(sf, 'utf8'))).length; } catch (e) { /* 忽略 */ }
      }
      let lastLog = '';
      if (fs.existsSync(lf)) {
        const ls = fs.readFileSync(lf, 'utf8').trim().split('\n');
        lastLog = ls[ls.length - 1] || '';
      }
      devices.push({ device: name, hits, sessions, lastLog });
    }
  } catch (e) { /* data 目录不存在时返回空 */ }
  jsonRes(res, 200, { ok: true, tokenRequired: !!SYNC_TOKEN, devices });
}

/* ================= 静态文件服务 ================= */

function serveStatic(req, res) {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(WEB_DIR, p));
  if (!file.startsWith(WEB_DIR + path.sep) && file !== WEB_DIR) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function route(req, res) {
  const u = (req.url || '').split('?')[0];
  // API 允许跨域: APK 内 WebView 源为 https://localhost, 访问局域网服务器属跨域场景
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sync-Token, X-TimeLogger-Sync');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (u.startsWith('/api/')) {
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (u === '/api/sync' && req.method === 'POST') return handleSyncPost(req, res);
    if (u === '/api/sync/stats' && req.method === 'GET') return handleStats(req, res);
    return jsonRes(res, 404, { ok: false, error: 'not found' });
  }
  serveStatic(req, res);
}

const httpsServer = https.createServer(
  { key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) },
  route
);
httpsServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${HTTPS_PORT} 已被占用, 可指定其他端口: PORT=9443 node server.js`);
    process.exit(1);
  }
  throw err;
});
httpsServer.listen(HTTPS_PORT, () => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log('时间记录器 Time Logger 已启动 (HTTPS)');
  console.log('----------------------------------------');
  ips.forEach((ip) => console.log(`  https://${ip}:${HTTPS_PORT}`));
  console.log(`  https://localhost:${HTTPS_PORT}`);
  console.log('----------------------------------------');
  console.log('手机与电脑连接同一 Wi-Fi/热点后, 用手机浏览器打开以上局域网地址');
  console.log('同步备份数据落盘位置: ' + DATA_DIR);
  console.log('运维查看汇总: curl -sk https://<本机IP>:' + HTTPS_PORT + '/api/sync/stats');
  if (SYNC_TOKEN) console.log('已启用同步令牌校验 (SYNC_TOKEN)');
  console.log('首次访问证书不受信任: Android Chrome 点"高级-继续访问";');
  console.log('iOS Safari 点"显示详细信息-访问此网站"(如需麦克风请尽量安装/信任证书)');
});

// HTTP 端口仅做跳转, 方便用户误输 http:// 时自动进入 HTTPS
const httpServer = http.createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0] || 'localhost';
  res.writeHead(301, { Location: `https://${host}:${HTTPS_PORT}${req.url}` });
  res.end();
});
httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`提示: HTTP ${HTTP_PORT} 端口被占用, 跳过 HTTP 跳转服务 (不影响 HTTPS 使用)`);
  } else {
    console.error('HTTP 跳转服务异常:', err.message);
  }
});
httpServer.listen(HTTP_PORT, () => {
  console.log(`HTTP ${HTTP_PORT} 端口请求将自动跳转到 HTTPS ${HTTPS_PORT}`);
});
