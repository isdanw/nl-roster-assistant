'use strict';
/**
 * 5 类查询服务层（罗列接口）。
 * 全部基于仿真数据 + roster.js 计算内核，不修改核心求解器。
 * 每个服务都接收「已解析的参数对象」，返回结构化结果（ok / 错误 / 数据）。
 *
 * 服务清单：
 *   1) remaining_hours   剩余飞行小时 + 超时风险
 *   2) pairing_check     配组合法性（单个航班或某日某基地整批）
 *   3) standby_gap       浦东基地备勤缺口（默认浦东，可指定基地/日期）
 *   4) base_coverage     某日基地排班覆盖
 *   5) rest_compliance   连续执勤 / 休息期合规
 */
const store = require('./dataStore');
const R = require('./roster');
const U = require('./utils');
const P = require('./policy');

function db() { return store.get(); }
function anchorDate() { return db().meta.anchorDate; }

// ---- 解析辅助 ----
function resolveCrew(token) {
  if (!token) return null;
  const d = db();
  if (d.index.crewByName.has(token)) return d.index.crewByName.get(token);
  for (const c of d.crew) {
    if (c.id === token || c.employeeNo === token) return c;
  }
  if (token.length >= 2) {
    for (const c of d.crew) if (c.name.includes(token)) return c;
  }
  return null;
}

const BASE_MAP = { 浦东: 'PVG', 虹桥: 'SHA', 广州: 'CAN', 北京: 'PEK' };
const BASE_REV = { PVG: 'PVG', SHA: 'SHA', CAN: 'CAN', PEK: 'PEK' };
function baseCode(token) {
  if (!token) return null;
  if (BASE_MAP[token]) return BASE_MAP[token];
  return BASE_REV[token] ? token : null;
}
function baseName(code) {
  return ({ PVG: '浦东', SHA: '虹桥', CAN: '广州', PEK: '北京' })[code] || code;
}

// ============================================================
// 1) 剩余飞行小时 + 超时风险
// ============================================================
function remainingHours(params) {
  const c = resolveCrew(params.crew);
  if (!c) return { ok: false, error: `未找到机组「${params.crew || ''}」，请确认姓名/工号` };
  const asOf = params.asOf || anchorDate();
  const s = R.hoursSummary(c.id, asOf);
  return {
    ok: true,
    service: 'remaining_hours',
    crew: { id: c.id, name: c.name, employeeNo: c.employeeNo, base: c.base, baseName: c.baseName, role: c.roleCn },
    asOf,
    year: { used: s.yearHours, limit: s.limits.year, remain: s.remain.year, risk: s.risk.year },
    month: { used: s.monthHours, limit: s.limits.month, remain: s.remain.month, risk: s.risk.month },
    week7: { used: s.rolling7Max, limit: s.limits.week7, remain: s.remain.week7, risk: s.risk.week7, windowEnd: s.rolling7WindowEnd },
    plannedFuture: s.plannedFuture,
    next7Hours: s.next7Hours,
  };
}

// ============================================================
// 2) 配组合法性
// ============================================================
function ratingOf(crew, aircraft) {
  if (!crew) return null;
  return crew.typeRatings.find((t) => t.type === aircraft) || null;
}

function checkFlight(f) {
  const idx = db().index;
  const assigns = idx.assignmentsByFlight.get(f.flightId) || [];
  const members = assigns.map((a) => {
    const cr = idx.crewById.get(a.crewId);
    const tr = ratingOf(cr, f.aircraft);
    return {
      position: a.position,
      positionCn: a.position === 'CAPTAIN' ? '机长' : '副驾驶',
      crewId: a.crewId,
      name: cr ? cr.name : '?',
      base: cr ? cr.base : null,
      rating: tr ? { pic: tr.pic, hours: tr.hoursOnType } : null,
      medicalDue: cr ? cr.medicalDue : null,
    };
  });
  const violations = [];
  const cap = members.filter((m) => m.position === 'CAPTAIN');
  const fo = members.filter((m) => m.position === 'FIRST_OFFICER');
  const needCap = f.require.CAPTAIN;
  const needFo = f.require.FIRST_OFFICER;

  if (cap.length < needCap) violations.push({ rule: 'MISSING_CAPTAIN', severity: 'HIGH', detail: `机长缺 ${needCap - cap.length} 人` });
  if (fo.length < needFo) violations.push({ rule: 'MISSING_FO', severity: 'HIGH', detail: `副驾驶缺 ${needFo - fo.length} 人` });

  for (const m of members) {
    if (!m.rating) {
      violations.push({ rule: 'TYPE_MISSING', severity: 'HIGH', detail: `${m.name}(${m.positionCn}) 无 ${f.aircraft} 机型资质` });
      continue;
    }
    if (m.position === 'CAPTAIN' && !m.rating.pic) {
      violations.push({ rule: 'NO_PIC_ON_TYPE', severity: 'HIGH', detail: `机长 ${m.name} 未取得 ${f.aircraft} 机长(PIC)资质` });
    }
    if (m.medicalDue && U.diffDays(m.medicalDue, f.date) > 0) {
      violations.push({ rule: 'MEDICAL_EXPIRED', severity: 'HIGH', detail: `${m.name} 体检合格证已于 ${m.medicalDue} 到期` });
    }
  }
  // 全组至少一人本机型经历 >= 100h
  const hasExp = members.some((m) => m.rating && m.rating.hours >= P.LIMITS.CREW_MIX_MIN_TYPE_HOURS);
  if (members.length && !hasExp) {
    violations.push({ rule: 'LOW_HOURS_PAIR', severity: 'HIGH', detail: `全组本机型经历均 < ${P.LIMITS.CREW_MIX_MIN_TYPE_HOURS}h` });
  }
  // 新机长提示（本机型 <500h）
  for (const m of cap) {
    if (m.rating && m.rating.hours < P.LIMITS.NEW_PIC_MAX) {
      violations.push({ rule: 'NEW_PIC_WATCH', severity: 'LOW', detail: `机长 ${m.name} 本机型经历 ${m.rating.hours}h < ${P.LIMITS.NEW_PIC_MAX}h（新机长，关注带飞）` });
    }
  }
  // 请假/训练冲突
  for (const m of members) {
    const lvList = idx.leavesByCrew.get(m.crewId) || [];
    const lv = lvList.find((l) => U.diffDays(l.start, f.date) >= 0 && U.diffDays(f.date, l.end) >= 0);
    if (lv) violations.push({ rule: 'LEAVE_CONFLICT', severity: 'HIGH', detail: `${m.name} ${f.date} 处于${lv.type}期间仍被排班` });
  }
  // 高原/特殊机场机长经历门槛
  if (f.specialAirport) {
    for (const m of cap) {
      if (m.rating && m.rating.hours < P.LIMITS.SPECIAL_AIRPORT_MIN_PIC_HOURS) {
        violations.push({ rule: 'SPECIAL_AIRPORT', severity: 'HIGH', detail: `${m.name} 高原/特殊机场机长经历 ${m.rating.hours}h < ${P.LIMITS.SPECIAL_AIRPORT_MIN_PIC_HOURS}h` });
      }
    }
  }
  const highCount = violations.filter((v) => v.severity === 'HIGH').length;
  return {
    flightId: f.flightId,
    flightNo: f.flightNo,
    date: f.date,
    aircraft: f.aircraft,
    dep: f.depName,
    arr: f.arrName,
    depTime: f.depTime,
    members,
    violations,
    legal: highCount === 0,
    highCount,
  };
}

function pairingCheck(params) {
  const idx = db().index;
  let flights = [];
  let scope = '';
  if (params.flightId) {
    const f = idx.flightsById.get(params.flightId);
    if (f) flights = [f];
    scope = `航班 ${params.flightId}`;
  } else if (params.flightNo) {
    flights = db().flights.filter((f) => f.flightNo === params.flightNo);
    scope = `航班号 ${params.flightNo}`;
  } else if (params.date && params.base) {
    const b = baseCode(params.base);
    flights = db().flights.filter((f) => f.date === params.date && f.dep === b);
    scope = `${baseName(b)} ${params.date}`;
  } else {
    return { ok: false, error: '配组合法性查询需提供 flightId / flightNo / (date + base) 之一' };
  }
  if (!flights.length) return { ok: false, error: `未找到匹配航班：${scope}` };
  const results = flights.map(checkFlight);
  const illegal = results.filter((r) => !r.legal).length;
  return {
    ok: true,
    service: 'pairing_check',
    scope,
    count: results.length,
    illegalCount: illegal,
    results,
  };
}

// ============================================================
// 3) 浦东基地备勤缺口
// ============================================================
function resolveDateList(params) {
  if (params.date) return [params.date];
  if (params.dateFrom && params.dateTo) {
    const out = [];
    for (let d = params.dateFrom; U.diffDays(d, params.dateTo) >= 0; d = U.addDays(d, 1)) out.push(d);
    return out;
  }
  if (params.days) {
    const a = anchorDate();
    return Array.from({ length: params.days }, (_, i) => U.addDays(a, i));
  }
  return [anchorDate()];
}

function standbyGap(params) {
  const b = baseCode(params.base) || 'PVG';
  const dates = resolveDateList(params);
  const rows = dates.map((date) => {
    const deps = (db().index.flightsByDateBase.get(`${date}|${b}`) || []).length;
    const required = U.clamp(Math.ceil(deps / P.LIMITS.STANDBY_PER_DEPARTURES), P.LIMITS.STANDBY_MIN, P.LIMITS.STANDBY_MAX);
    const actual = (db().index.standbyByDateBase.get(`${date}|${b}`) || []).length;
    const gap = Math.max(0, required - actual);
    let status = '充足';
    if (gap > 0) status = '缺口';
    else if (actual > required) status = '富余';
    return { date, base: b, baseName: baseName(b), departures: deps, required, actual, gap, status };
  });
  const totalGap = rows.reduce((s, r) => s + r.gap, 0);
  return {
    ok: true,
    service: 'standby_gap',
    base: b,
    baseName: baseName(b),
    rows,
    totalGap,
    hasGap: totalGap > 0,
  };
}

// ============================================================
// 4) 某日基地排班覆盖
// ============================================================
function baseCoverage(params) {
  const b = baseCode(params.base) || 'PVG';
  const date = params.date || anchorDate();
  const flights = db().flights.filter((f) => f.date === date && f.dep === b);
  const rows = flights.map((f) => {
    const assigns = db().index.assignmentsByFlight.get(f.flightId) || [];
    const cap = assigns.filter((a) => a.position === 'CAPTAIN').length;
    const fo = assigns.filter((a) => a.position === 'FIRST_OFFICER').length;
    const covered = cap >= f.require.CAPTAIN && fo >= f.require.FIRST_OFFICER;
    return {
      flightNo: f.flightNo,
      flightId: f.flightId,
      aircraft: f.aircraft,
      depTime: f.depTime,
      arr: f.arrName,
      cap, fo,
      needCap: f.require.CAPTAIN,
      needFo: f.require.FIRST_OFFICER,
      covered,
    };
  });
  const total = flights.length;
  const coveredN = rows.filter((r) => r.covered).length;
  return {
    ok: true,
    service: 'base_coverage',
    date,
    base: b,
    baseName: baseName(b),
    totalFlights: total,
    covered: coveredN,
    uncovered: total - coveredN,
    coverageRate: total ? U.round(coveredN / total, 2) : 0,
    flights: rows,
  };
}

// ============================================================
// 5) 连续执勤 / 休息期合规
// ============================================================
function restCompliance(params) {
  const c = resolveCrew(params.crew);
  if (!c) return { ok: false, error: `未找到机组「${params.crew || ''}」，请确认姓名/工号` };
  const a = anchorDate();
  const since = params.since || U.addDays(a, -10);
  const until = params.until || U.addDays(a, 10);
  const scan = R.restScan(c.id, since, until);
  const wk = R.weeklyRest(c.id, since, until);
  return {
    ok: true,
    service: 'rest_compliance',
    crew: { id: c.id, name: c.name, employeeNo: c.employeeNo, base: c.base, baseName: c.baseName, role: c.roleCn },
    window: { since, until },
    violations: scan.violations,
    weeklyRestGaps: wk,
    compliant: scan.violations.length === 0 && wk.length === 0,
    violationCount: scan.violations.length + wk.length,
  };
}

// ============================================================
// 服务注册表 + 调度器
// ============================================================
const REGISTRY = {
  remaining_hours: {
    title: '剩余飞行小时 + 超时风险',
    handler: remainingHours,
    purpose: '查询指定机组在某一时点的年度/月度/连续7日飞行小时消耗与剩余额度，并给出超时风险等级（正常/关注/预警/超限）。',
    params: [
      { name: 'crew', desc: '机组姓名 / 工号 / 编号（如「邓勇涛」「PVG1001」「C001」）', required: true },
      { name: 'asOf', desc: '统计截止日 YYYY-MM-DD，默认今天', required: false },
    ],
    exampleInput: '邓勇涛 还有多少飞行小时',
  },
  pairing_check: {
    title: '配组合法性',
    handler: pairingCheck,
    purpose: '审查单个航班或某日某基地整批航班的机组合法性：机长PIC资质、体检有效性、本机型经历门槛、请假冲突、特殊机场经历等。',
    params: [
      { name: 'flightId', desc: '航班内部ID（如 FL01667）', required: false },
      { name: 'flightNo', desc: '航班号（如 MU1790），可跨日整批审查', required: false },
      { name: 'date + base', desc: '某日某基地整批审查（如 date=2026-10-30, base=PVG）', required: false },
    ],
    exampleInput: 'MU1790 这班配组合法吗',
  },
  standby_gap: {
    title: '浦东基地备勤缺口',
    handler: standbyGap,
    purpose: '按「每12个出港航班需1个备勤组、下限2上限8」计算各基地每日应备勤数量，与实际排布对比，输出备勤缺口。默认浦东。',
    params: [
      { name: 'base', desc: '基地代码/名称，默认 PVG（浦东）', required: false },
      { name: 'date / dateFrom+dateTo / days', desc: '查询日期或区间，默认今天', required: false },
    ],
    exampleInput: '浦东 明天 备勤够不够',
  },
  base_coverage: {
    title: '某日基地排班覆盖',
    handler: baseCoverage,
    purpose: '统计某日某基地所有出港航班的机组覆盖情况：是否每个航班都配齐所需机长与副驾驶，输出覆盖率与未覆盖航班清单。',
    params: [
      { name: 'date', desc: '查询日期 YYYY-MM-DD，默认今天', required: false },
      { name: 'base', desc: '基地代码/名称，默认 PVG（浦东）', required: false },
    ],
    exampleInput: '10月30号 浦东 排班覆盖',
  },
  rest_compliance: {
    title: '连续执勤 / 休息期合规',
    handler: restCompliance,
    purpose: '审查机组在指定时间窗内的连续执勤天数、值勤间最小休息期、值勤期上限、周休是否满足，输出违规清单。',
    params: [
      { name: 'crew', desc: '机组姓名 / 工号 / 编号', required: true },
      { name: 'since / until', desc: '审查时间窗，默认今天前后各10天', required: false },
    ],
    exampleInput: '王五 连续执勤合规吗',
  },
};

function listServices() {
  return Object.keys(REGISTRY).map((name) => {
    const m = REGISTRY[name];
    return { name, title: m.title, purpose: m.purpose, params: m.params, exampleInput: m.exampleInput };
  });
}

function run(name, params = {}) {
  const m = REGISTRY[name];
  if (!m) return { ok: false, error: `未知服务：${name}` };
  const out = m.handler(params);
  out.service = name;
  return out;
}

module.exports = { REGISTRY, listServices, run, resolveCrew, baseCode, baseName };
