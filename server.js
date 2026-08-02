// ========== 暗夜突围 NightBreak 排行榜后端 ==========
// 零依赖 Node.js 实现，数据存 rank.json，直接 `node server.js` 启动
// 部署到 https://www.szkj.site 即可，前端配置 RANK_API 指向该域名
//
// 接口：
//   POST /api/rank/submit   提交分数  body: { name, score, level, kills, time, wave, token }
//                            返回: { ok, rank, best, entry }
//   GET  /api/rank/top?limit=50   取榜单  返回: { ok, list: [...] }
//   GET  /api/rank/my?name=xxx    查个人最佳  返回: { ok, entry }
//   GET  /api/rank/health         健康检查  返回: { ok: true }
//
// 防作弊：分数合理性上限校验 + 简单 token 校验 + IP 限流

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const RANK_FILE = path.join(__dirname, 'rank.json');
const MAX_RANK = 1000;          // 最多保留条数
const MAX_NAME_LEN = 12;        // 昵称最大长度
const SCORE_HARD_CAP = 999999;  // 单局分数硬上限（防作弊）
const SUBMIT_SECRET = 'nightbreak-2024-secret'; // 简单 token，前端硬编码对应

// IP 限流：每个 IP 提交频率限制
const ipSubmitLog = new Map(); // ip -> [timestamp...]
const RATE_WINDOW_MS = 60000;  // 60 秒窗口
const RATE_MAX_SUBMIT = 5;     // 每窗口最多提交 5 次

// ---------- 数据读写 ----------
function loadRanks() {
  try {
    if (!fs.existsSync(RANK_FILE)) return [];
    const raw = fs.readFileSync(RANK_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function saveRanks(list) {
  try { fs.writeFileSync(RANK_FILE, JSON.stringify(list.slice(0, MAX_RANK)), 'utf8'); } catch (e) {}
}

// ---------- 工具 ----------
function send(res, code, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  }, headers || {}));
  res.end(body);
}
function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 8192) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
function rateLimit(ip) {
  const now = Date.now();
  const arr = (ipSubmitLog.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX_SUBMIT) return false;
  arr.push(now);
  ipSubmitLog.set(ip, arr);
  return true;
}
function sanitizeName(name) {
  if (typeof name !== 'string') return '';
  // 去除首尾空白，截断长度
  let s = name.trim().slice(0, MAX_NAME_LEN);
  // 过滤控制字符与明显非法字符（保留中文/英文/数字/部分符号）
  s = s.replace(/[\u0000-\u001f\u007f<>\"'\\]/g, '');
  return s;
}

// ---------- 业务 ----------
function handleTop(req, res) {
  const q = url.parse(req.url, true).query;
  const limit = Math.min(parseInt(q.limit, 10) || 50, MAX_RANK);
  const list = loadRanks()
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(e => ({ name: e.name, score: e.score, level: e.level, kills: e.kills, time: e.time, wave: e.wave, date: e.date }));
  send(res, 200, { ok: true, list });
}

function handleMy(req, res) {
  const q = url.parse(req.url, true).query;
  const name = sanitizeName(q.name || '');
  if (!name) return send(res, 200, { ok: true, entry: null });
  const list = loadRanks();
  const mine = list.filter(e => e.name === name).sort((a, b) => b.score - a.score);
  send(res, 200, { ok: true, entry: mine[0] || null });
}

async function handleSubmit(req, res) {
  const ip = getClientIp(req);
  if (!rateLimit(ip)) return send(res, 429, { ok: false, error: '提交太频繁，请稍后再试' });

  const body = await readBody(req);
  if (!body) return send(res, 400, { ok: false, error: '参数错误' });

  const name = sanitizeName(body.name);
  const score = Math.floor(Number(body.score));
  const level = Math.floor(Number(body.level)) || 1;
  const kills = Math.floor(Number(body.kills)) || 0;
  const t = Math.floor(Number(body.time)) || 0;
  const wave = Math.floor(Number(body.wave)) || 1;
  const token = body.token;

  if (!name) return send(res, 400, { ok: false, error: '昵称不能为空' });
  if (!Number.isFinite(score) || score < 0 || score > SCORE_HARD_CAP) {
    return send(res, 400, { ok: false, error: '分数异常' });
  }
  // token 校验（简单防刷，非加密级）
  if (token !== SUBMIT_SECRET) {
    return send(res, 403, { ok: false, error: '无效请求' });
  }

  const list = loadRanks();
  const existIdx = list.findIndex(e => e.name === name);
  const prevBest = existIdx >= 0 ? list[existIdx].score : 0;
  const isNewBest = score > prevBest;
  // 同名只保留最高分；最终分数取本次与历史最高中的较大值
  const finalScore = Math.max(score, prevBest);
  const entry = { name, score: finalScore, level, kills, time: t, wave, date: Date.now(), ip };

  if (existIdx >= 0) {
    if (isNewBest) list[existIdx] = entry; // 刷新最高分记录
  } else {
    list.push(entry);
  }
  list.sort((a, b) => b.score - a.score);
  saveRanks(list);

  // 计算本次名次（按该玩家当前最高分排名）
  const rank = list.findIndex(e => e.name === name) + 1;
  const best = isNewBest || existIdx < 0; // 首次上榜也算 best

  send(res, 200, { ok: true, rank: rank || list.length, best, entry: { name, score: finalScore, level, kills, time: t, wave } });
}

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
  const pathname = url.parse(req.url).pathname;
  if (req.method === 'OPTIONS') return send(res, 204, {});
  try {
    if (pathname === '/api/rank/health') return send(res, 200, { ok: true, time: Date.now() });
    if (pathname === '/api/rank/top' && req.method === 'GET') return handleTop(req, res);
    if (pathname === '/api/rank/my' && req.method === 'GET') return handleMy(req, res);
    if (pathname === '/api/rank/submit' && req.method === 'POST') return await handleSubmit(req, res);
    send(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    send(res, 500, { ok: false, error: '服务器错误' });
  }
});
server.listen(PORT, () => {
  console.log(`[NightBreak Rank] running at http://0.0.0.0:${PORT}`);
  console.log(`健康检查: http://localhost:${PORT}/api/rank/health`);
});
