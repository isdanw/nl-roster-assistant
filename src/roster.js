'use strict';
/** 执勤/飞行小时计算内核（供各查询服务复用） */
const U = require('./utils');
const P = require('./policy');
const store = require('./dataStore');

const SIGN_ON_MIN = 60;
const SIGN_OFF_MIN = 30;

function absMinutes(date, hhmm) {
  const d = U.parseISO(date);
  const [h, m] = hhmm.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return Math.round(d.getTime() / 60000);
}

function flightWindow(f) {
  const start = absMinutes(f.date, f.depTime);
  let end = absMinutes(f.date, f.arrTime);
  if (f.arrNextDay) end += 1440;
  return { start, end };
}

/** 某机组的执勤日列表（含请假日、备勤日），按日期升序 */
function dutyDays(crewId, since, until) {
  const db = store.get();
  const idx = db.index;
  const daily = new Map();

  const touch = (date) => {
    if (!daily.has(date)) daily.set(date, { date, legs: [], standby: [], leave: null, blockHours: 0 });
    return daily.get(date);
  };
  const inRange = (d) => (!since || U.diffDays(since, d) >= 0) && (!until || U.diffDays(d, until) >= 0);

  for (const a of (idx.assignmentsByCrew.get(crewId) || [])) {
    const f = idx.flightsById.get(a.flightId);
    if (!f) continue;
    if (inRange(f.date)) {
      const day = touch(f.date);
      const w = flightWindow(f);
      day.legs.push({ flight: f, position: a.position, startAbs: w.start, endAbs: w.end, assignmentId: a.id });
    }
    // 跨零点航班：落地次日计入前一日的值勤，同时标记次日被占用
    if (f.arrNextDay) {
      const nxt = U.addDays(f.date, 1);
      if (inRange(nxt)) touch(nxt).crossPrev = true;
    }
  }
  for (const s of (idx.standbyByCrew.get(crewId) || [])) {
    if (inRange(s.date)) touch(s.date).standby.push(s);
  }
  for (const l of (idx.leavesByCrew.get(crewId) || [])) {
    for (let d = l.start; U.diffDays(d, l.end) >= 0; d = U.addDays(d, 1)) {
      if (inRange(d)) touch(d).leave = l;
    }
  }
  const out = [...daily.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const day of out) {
    day.legs.sort((a, b) => a.startAbs - b.startAbs);
    day.blockHours = U.round(day.legs.reduce((s, l) => s + l.flight.blockHours, 0), 2);
    if (day.legs.length) {
      const start = Math.min(...day.legs.map((l) => l.startAbs)) - SIGN_ON_MIN;
      const end = Math.max(...day.legs.map((l) => l.endAbs)) + SIGN_OFF_MIN;
      day.dutyStartAbs = start;
      day.dutyEndAbs = end;
      day.fdpHours = U.round((end - start) / 60, 2);
    }
    day.hasFlight = day.legs.length > 0;
  }
  return out;
}

/** 到 asOf 为止的飞行小时口径统计 */
function hoursSummary(crewId, asOf) {
  const db = store.get();
  const idx = db.index;
  const crew = idx.crewById.get(crewId);
  const priorYear = (db.meta.priorYearHours && db.meta.priorYearHours[crewId]) || 0;
  const daily = new Map();
  for (const a of (idx.assignmentsByCrew.get(crewId) || [])) {
    const f = idx.flightsById.get(a.flightId);
    if (!f) continue;
    daily.set(f.date, U.round((daily.get(f.date) || 0) + f.blockHours, 2));
  }
  const monthKey = U.monthOf(asOf);
  let monthHours = 0;
  let yearHours = priorYear;
  let plannedFuture = 0;
  let plannedFutureInMonth = 0;
  for (const [date, h] of daily) {
    if (U.yearOf(date) === U.yearOf(asOf)) yearHours += h;
    if (U.monthOf(date) === monthKey) monthHours += h;
    if (U.diffDays(asOf, date) > 0) {
      plannedFuture += h;
      if (U.monthOf(date) === monthKey) plannedFutureInMonth += h;
    }
  }
  // 含今天在内的任意连续 7 日最大值
  let rolling7Max = 0;
  let rolling7End = null;
  for (let back = 0; back <= 6; back++) {
    const endD = U.addDays(asOf, -back);
    let s = 0;
    for (let k = 0; k < 7; k++) s += daily.get(U.addDays(endD, -k)) || 0;
    s = U.round(s, 2);
    if (s > rolling7Max) { rolling7Max = s; rolling7End = endD; }
  }
  // 未来 7 日（含今天）已排
  let next7 = 0;
  for (let k = 0; k < 7; k++) next7 += daily.get(U.addDays(asOf, k)) || 0;
  const res = {
    crewId,
    crew,
    asOf,
    yearHours: U.round(yearHours, 2),
    monthHours: U.round(monthHours, 2),
    rolling7Max: U.round(rolling7Max, 2),
    rolling7WindowEnd: rolling7End,
    plannedFuture: U.round(plannedFuture, 2),
    plannedFutureInMonth: U.round(plannedFutureInMonth, 2),
    next7Hours: U.round(next7, 2),
    limits: {
      year: P.LIMITS.YEAR_HOURS_MAX,
      month: P.LIMITS.MONTH_HOURS_MAX,
      week7: P.LIMITS.WEEK7_HOURS_MAX,
    },
    remain: {
      year: U.round(Math.max(0, P.LIMITS.YEAR_HOURS_MAX - yearHours), 2),
      month: U.round(Math.max(0, P.LIMITS.MONTH_HOURS_MAX - monthHours), 2),
      week7: U.round(Math.max(0, P.LIMITS.WEEK7_HOURS_MAX - rolling7Max), 2),
    },
  };
  res.risk = {
    year: P.riskOfRemaining(res.yearHours, P.LIMITS.YEAR_HOURS_MAX),
    month: P.riskOfRemaining(monthHours, P.LIMITS.MONTH_HOURS_MAX),
    week7: P.riskOfRemaining(rolling7Max, P.LIMITS.WEEK7_HOURS_MAX),
  };
  return res;
}

/** 机组在指定日期区间的最大连续值勤天数、违规休息、超时 Kosovo */
function restScan(crewId, since, until) {
  const days = dutyDays(crewId, since, until);
  const violations = [];
  // 1) 执勤间最小休息期
  const flightDays = days.filter((d) => d.hasFlight);
  for (let i = 1; i < flightDays.length; i++) {
    const prev = flightDays[i - 1];
    const cur = flightDays[i];
    const gapMin = cur.dutyStartAbs - prev.dutyEndAbs;
    if (gapMin < P.LIMITS.MIN_REST_MIN) {
      violations.push({
        rule: 'MIN_REST',
        severity: 'HIGH',
        date: `${prev.date} → ${cur.date}`,
        detail: `两值勤间休息 ${U.round(gapMin / 60, 1)}h < 要求 ${P.LIMITS.MIN_REST_MIN / 60}h`,
      });
    }
  }
  // 2) 连续值勤天数（逐自然日，含备勤；出现无任务日即中断）
  let streak = 0; let streakStart = null; let prev = null;
  for (const d of days) {
    if (prev && U.diffDays(prev, d.date) !== 1) { streak = 0; streakStart = null; }
    const hasDuty = d.hasFlight || d.standby.length > 0;
    if (hasDuty) {
      if (streak === 0) streakStart = d.date;
      streak += 1;
      if (streak > P.LIMITS.MAX_DUTY_STREAK) {
        violations.push({
          rule: 'CONSECUTIVE_DUTY', severity: 'HIGH', date: d.date,
          detail: `自 ${streakStart} 起连续值勤 ${streak} 天 > 上限 ${P.LIMITS.MAX_DUTY_STREAK} 天`,
        });
      }
    } else { streak = 0; streakStart = null; }
    prev = d.date;
  }
  // 3) 值勤期上限 / 日飞行小时
  for (const d of days) {
    if (d.hasFlight) {
      if (d.fdpHours > P.LIMITS.FDP_MAX) {
        violations.push({ rule: 'FDP_MAX', severity: 'HIGH', date: d.date, detail: `值勤期 ${d.fdpHours}h > 上限 ${P.LIMITS.FDP_MAX}h` });
      }
      if (d.blockHours > P.LIMITS.DAY_BLOCK_MAX) {
        violations.push({ rule: 'DAY_BLOCK_MAX', severity: 'MEDIUM', date: d.date, detail: `当日航段飞行 ${d.blockHours}h > 上限 ${P.LIMITS.DAY_BLOCK_MAX}h` });
      }
    }
    if (d.leave && d.hasFlight) {
      violations.push({ rule: 'LEAVE_CONFLICT', severity: 'HIGH', date: d.date, detail: `${d.leave.type}期间被安排任务` });
    }
    if (d.standby.length && d.hasFlight) {
      violations.push({ rule: 'STANDBY_CONFLICT', severity: 'MEDIUM', date: d.date, detail: '当日同时安排备勤与航班任务' });
    }
  }
  return { violations, days };
}

/** 任意连续 7 日内最长连续休息时长（分钟）是否满足周休要求 */
function weeklyRest(crewId, since, until) {
  const days = dutyDays(crewId, since, until);
  const out = [];
  if (!days.length) return out;
  const map = new Map(days.map((d) => [d.date, d]));
  // 为保证窗口完整，把扫描范围向前后各延展 1 天
  const scanStart = U.addDays(days[0].date, -1);
  const scanEnd = U.addDays(days[days.length - 1].date, -6);
  const busy = [];
  for (let d = scanStart; U.diffDays(d, scanEnd) >= 0; d = U.addDays(d, 1)) {
    const day = map.get(d);
    if (!day) continue;
    if (day.hasFlight) busy.push([day.dutyStartAbs, day.dutyEndAbs]);
    for (const s of day.standby) {
      const range = s.slot === 'AM' ? ['06:00', '12:00'] : ['12:00', '22:00'];
      busy.push([absMinutes(d, range[0]), absMinutes(d, range[1])]);
    }
  }
  busy.sort((a, b) => a[0] - b[0]);
  const startD = days[0].date;
  const endD = days[days.length - 1].date;
  for (let d = startD; U.diffDays(U.addDays(d, 6), endD) >= 0; d = U.addDays(d, 1)) {
    const wStart = absMinutes(d, '00:00');
    const wEnd = absMinutes(U.addDays(d, 7), '00:00');
    let maxGap = 0;
    let cursor = wStart;
    for (const [s, e] of busy) {
      const cs = U.clamp(s, wStart, wEnd);
      const ce = U.clamp(e, wStart, wEnd);
      if (ce <= wStart || cs >= wEnd) continue;
      if (cs > cursor) maxGap = Math.max(maxGap, cs - cursor);
      cursor = Math.max(cursor, ce);
    }
    maxGap = Math.max(maxGap, wEnd - cursor);
    if (maxGap < P.LIMITS.WEEK_REST_MIN) {
      out.push({
        windowStart: d,
        windowEnd: U.addDays(d, 6),
        maxRestHours: U.round(maxGap / 60, 1),
        required: P.LIMITS.WEEK_REST_MIN / 60,
      });
    }
  }
  return out;
}

module.exports = { absMinutes, flightWindow, dutyDays, hoursSummary, restScan, weeklyRest, SIGN_ON_MIN, SIGN_OFF_MIN };
