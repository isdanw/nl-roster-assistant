'use strict';
/**
 * 20 条自然语言查询自测。
 * 直接调用 nlu.recognize + services.run（与 HTTP 服务同一条链路）。
 * 判定：命中接口(intent)是否正确；对部分用例额外断言服务返回关键结果。
 * 输出：控制台汇总 + 同级 selftest.md（【输入 / 命中接口 / 输出结果】表格）。
 *
 * 准确率 = 命中接口正确的条数 / 20，要求 ≥ 95%（即 ≥ 19/20）。
 */
const fs = require('fs');
const path = require('path');
const { recognize } = require('../src/nlu');
const { run } = require('../src/services');
const { get } = require('../src/dataStore');
const U = require('../src/utils');

const db = get();
const anchor = db.meta.anchorDate;

// ---- 从当前仿真数据动态挑选稳定样本（避免硬编码姓名/航班号随重生成失效）----
function topHoursCrew() {
  let best = db.crew[0], val = -1;
  for (const c of db.crew) {
    const s = require('../src/roster').hoursSummary(c.id, anchor);
    if (s.yearHours > val) { val = s.yearHours; best = c; }
  }
  return best;
}
function scenarioFlightNo(type) {
  const sc = (db.meta.scenarios || []).find((s) => s.type === type);
  if (!sc) return null;
  const f = db.index.flightsById.get(sc.flightId);
  return f ? f.flightNo : null;
}
function restShortCaptainName() {
  const sc = (db.meta.scenarios || []).find((s) => s.type === 'REST_SHORT');
  if (!sc) return topHoursCrew().name;
  const cap = (db.index.assignmentsByFlight.get(sc.flightId) || []).find((a) => a.position === 'CAPTAIN');
  return db.index.crewById.get(cap.crewId).name;
}
function covDateCN() {
  const d = U.addDays(anchor, 1);
  return `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;
}

const realCrew = topHoursCrew().name;
const noPic = scenarioFlightNo('NO_PIC_ON_TYPE');
const med = scenarioFlightNo('MEDICAL_EXPIRED');
const low = scenarioFlightNo('LOW_HOURS_PAIR');
const leave = scenarioFlightNo('LEAVE_CONFLICT');
const restCrew = restShortCaptainName();
const covCN = covDateCN();

// ---- 20 条用例：[输入, 期望接口, 期望接口中文标题, 可选结果断言] ----
const CASES = [
  [`${realCrew} 还有多少飞行小时`, 'remaining_hours', '剩余飞行小时+超时风险', (r) => r.ok && r.year],
  [`${realCrew} 这个月超时风险怎么样`, 'remaining_hours', '剩余飞行小时+超时风险', (r) => r.ok && r.month],
  [`${realCrew} 剩余额度还剩多少`, 'remaining_hours', '剩余飞行小时+超时风险', (r) => r.ok && r.week7],
  [`${realCrew} 可用飞行小时`, 'remaining_hours', '剩余飞行小时+超时风险', (r) => r.ok && r.year],

  [`航班${noPic} 配组合法吗`, 'pairing_check', '配组合法性', (r) => r.ok && r.results.some(x => x.violations.some(v => v.rule === 'NO_PIC_ON_TYPE'))],
  [`航班${med} 资质合规吗`, 'pairing_check', '配组合法性', (r) => r.ok && r.results.some(x => x.violations.some(v => v.rule === 'MEDICAL_EXPIRED'))],
  [`航班${low} 这班配组`, 'pairing_check', '配组合法性', (r) => r.ok && r.results.some(x => x.violations.some(v => v.rule === 'LOW_HOURS_PAIR'))],
  [`航班${leave} 合法吗`, 'pairing_check', '配组合法性', (r) => r.ok && r.results.some(x => x.violations.some(v => v.rule === 'LEAVE_CONFLICT'))],

  ['浦东 明天 备勤够不够', 'standby_gap', '浦东基地备勤缺口', (r) => r.ok && r.rows.length >= 1],
  ['虹桥 今天 备勤缺口', 'standby_gap', '浦东基地备勤缺口', (r) => r.ok && r.base === 'SHA'],
  ['广州 备勤', 'standby_gap', '浦东基地备勤缺口', (r) => r.ok && r.base === 'CAN'],

  [`${covCN} 浦东 排班覆盖`, 'base_coverage', '某日基地排班覆盖', (r) => r.ok && r.totalFlights > 0],
  ['今天 浦东 排班', 'base_coverage', '某日基地排班覆盖', (r) => r.ok && r.totalFlights > 0],
  ['帮我看看明天的排班', 'base_coverage', '某日基地排班覆盖', (r) => r.ok && r.totalFlights > 0],
  ['浦东 覆盖情况', 'base_coverage', '某日基地排班覆盖', (r) => r.ok && r.totalFlights > 0],

  [`${realCrew} 连续执勤合规吗`, 'rest_compliance', '连续执勤/休息期合规', (r) => r.ok && r.window],
  [`${realCrew} 休息期够不够`, 'rest_compliance', '连续执勤/休息期合规', (r) => r.ok && r.window],
  [`${restCrew} 执勤休息合规`, 'rest_compliance', '连续执勤/休息期合规', (r) => r.ok && r.violationCount >= 1],

  ['天气怎么样', null, '未识别', (r) => r.intent === null && r.message],
  ['你好', null, '未识别', (r) => r.intent === null && r.message],
];

function summarize(rec, res) {
  if (!rec.intent) return `未识别 → ${String(res.message || '').slice(0, 24)}…`;
  const r = res.result || res;
  switch (rec.intent) {
    case 'remaining_hours':
      return `年度 ${r.year.used}/${r.year.limit}(${r.year.risk})；月度 ${r.month.used}/${r.month.limit}(${r.month.risk})；连续7日 ${r.week7.used}(${r.week7.risk})`;
    case 'pairing_check': {
      const f = r.results && r.results[0];
      const rules = f ? f.violations.map((v) => v.rule).join(',') || '合法' : '-';
      return `航班 ${f ? f.flightNo : '-'}：${r.count} 班 / 违规 ${r.illegalCount} 班；首班违规[${rules}]`;
    }
    case 'standby_gap':
      return `合计缺口 ${r.totalGap}；${r.rows.map((x) => `${x.date}:需${x.required}/实${x.actual}(${x.status})`).join('；')}`;
    case 'base_coverage':
      return `总 ${r.totalFlights} 班 / 覆盖 ${r.covered} 班 / 率 ${Math.round(r.coverageRate * 100)}% / 未覆盖 ${r.uncovered}`;
    case 'rest_compliance':
      return `${r.compliant ? '合规' : '违规 ' + r.violationCount + ' 项'}（窗口 ${r.window.since}~${r.window.until}）`;
    default:
      return JSON.stringify(r).slice(0, 60);
  }
}

let pass = 0;
const rows = [];
for (const [input, expIntent, expTitle, assertFn] of CASES) {
  const rec = recognize(input);
  const hit = rec.intent === expIntent;
  let res, extraOk = true;
  try { res = hit || rec.intent === null ? (rec.intent ? run(rec.intent, rec.slots) : { message: rec.message, intent: null }) : { message: rec.message, intent: rec.intent }; }
  catch (e) { res = { error: String(e.message) }; }
  if (assertFn) { try { extraOk = !!assertFn(res); } catch (_) { extraOk = false; } }
  const ok = hit && extraOk;
  if (ok) pass += 1;
  rows.push({ input, expTitle, hit, res, out: summarize(rec, res), ok });
}

const accuracy = pass / CASES.length;
const md = ['# 自然语言排班助手 · 20 条自测', '',
  `> 数据锚点：${anchor}（仿真/脱敏）。准确率判定：命中接口(intent)正确且关键结果断言通过。`,
  `> 自测结果：**${pass}/${CASES.length} 通过，准确率 ${(accuracy * 100).toFixed(0)}%**（要求 ≥ 95%）。`,
  '',
  '| # | 输入 | 命中接口 | 输出结果 | 判定 |',
  '| - | ---- | -------- | -------- | ---- |',
  ...rows.map((r, i) => `| ${i + 1} | ${r.input} | ${r.expTitle} | ${r.out} | ${r.ok ? '✅' : '❌'} |`),
].join('\n');

fs.writeFileSync(path.join(__dirname, '..', 'selftest.md'), md, 'utf-8');

console.log(`\n自测：${pass}/${CASES.length} 通过，准确率 ${(accuracy * 100).toFixed(0)}%`);
rows.forEach((r, i) => console.log(`${r.ok ? '✅' : '❌'} ${String(i + 1).padStart(2)} [${r.expTitle}] ${r.input}  →  ${r.out}`));
console.log(`\n已生成 selftest.md（${path.join(__dirname, '..', 'selftest.md')}）`);
process.exit(accuracy >= 0.95 ? 0 : 1);
