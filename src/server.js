'use strict';
/**
 * 零依赖 HTTP 服务：罗列接口(NLU) → 语义识别 → 调接口 → 前端展示。
 * 仅用 Node 内置 http / fs / path，不引入任何第三方依赖。
 *
 * 路由：
 *   GET  /                      前端查询页
 *   POST /api/query  {q}       自然语言 → 识别意图+槽位 → 调对应接口 → 返回结果
 *   GET  /api/query?q=...      同上（GET 便于直接在浏览器/命令行调试）
 *   GET  /api/services          5 类接口清单（用途/入参/出参说明）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const { recognize } = require('./nlu');
const { run, listServices } = require('./services');
const store = require('./dataStore');
const R = require('./roster');
const U = require('./utils');

/** 基于当前仿真数据生成"保证能命中"的示例查询，供前端示例按钮使用 */
function buildDemoExamples() {
  const db = store.get();
  const anchor = db.meta.anchorDate;
  // 1) 高利用率机组（用于剩余飞行小时）
  let topCrew = null, topVal = -1;
  for (const c of db.crew) {
    const s = R.hoursSummary(c.id, anchor);
    if (s.yearHours > topVal) { topVal = s.yearHours; topCrew = c; }
  }
  const crewName = topCrew ? topCrew.name : (db.crew[0] && db.crew[0].name);
  // 2) 一个含注入违规的航班（用于配组合法性）
  const sc = (db.meta.scenarios || []).find((s) => s.type === 'NO_PIC_ON_TYPE' || s.type === 'MEDICAL_EXPIRED')
    || (db.meta.scenarios || [])[0];
  const scFlight = sc ? db.index.flightsById.get(sc.flightId) : null;
  const flightNo = scFlight ? scFlight.flightNo : (db.flights[0] && db.flights[0].flightNo);
  // 3) 一个用于排班覆盖的日期/基地（取明天浦东，格式 MM月DD日）
  const covDate = U.addDays(anchor, 1);
  const covText = `${Number(covDate.slice(5, 7))}月${Number(covDate.slice(8, 10))}日 浦东 排班覆盖`;
  // 4) 一个用于连续执勤合规的机组
  const restCrew = db.crew.find((c) => c.role === 'CAPTAIN') || db.crew[0];
  return [
    `${crewName} 还有多少飞行小时`,
    `航班${flightNo} 这班配组合法吗`,
    `浦东 明天 备勤够不够`,
    covText,
    `${restCrew.name} 连续执勤合规吗`,
  ];
}

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function serveStatic(res, file) {
  const p = path.join(PUBLIC_DIR, file);
  fs.readFile(p, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(p);
    const ct = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'text/plain';
    res.writeHead(200, { 'Content-Type': ct + '; charset=utf-8' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(buf));
  });
}

/** 自然语言 → 全链路结果 */
function handleQuery(q) {
  if (!q || !q.trim()) {
    return { ok: false, error: '缺少查询文本 q' };
  }
  const rec = recognize(q);
  if (!rec.intent) {
    return { ok: false, intent: null, recognized: false, message: rec.message, slots: rec.slots };
  }
  if (rec.message) {
    // 意图识别到但槽位不足：返回提示（不再臆造调用）
    return { ok: false, intent: rec.intent, recognized: true, message: rec.message, slots: rec.slots };
  }
  const result = run(rec.intent, rec.slots);
  return {
    ok: result.ok !== false,
    recognized: true,
    intent: rec.intent,
    intentTitle: (require('./services').REGISTRY[rec.intent] || {}).title,
    slots: rec.slots,
    confidence: rec.confidence,
    result,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/' || pathname === '/index.html') {
      return serveStatic(res, 'index.html');
    }
    if (pathname === '/api/services') {
      return sendJSON(res, 200, { ok: true, services: listServices() });
    }
    if (pathname === '/api/demo') {
      return sendJSON(res, 200, { ok: true, examples: buildDemoExamples() });
    }
    if (pathname === '/api/query') {
      let q = url.searchParams.get('q');
      if (!q && req.method === 'POST') {
        const raw = await readBody(req);
        try { q = (JSON.parse(raw).q) || null; } catch (_) { q = raw; }
      }
      return sendJSON(res, 200, handleQuery(q));
    }
    // 未知路径
    return sendJSON(res, 404, { ok: false, error: 'unknown route' });
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: String(e && e.message || e) });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[server] 自然语言排班助手 Demo 已启动: http://localhost:${PORT}`);
    console.log(`[server] 接口清单: http://localhost:${PORT}/api/services`);
  });
}

module.exports = { server, handleQuery };
