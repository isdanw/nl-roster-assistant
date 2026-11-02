'use strict';
/**
 * 仿真数据生成器：生成完全脱敏、仅供演示的机组/航班/排班/备勤/请假数据。
 * 数据以"运行当天"为锚点自动生成（45 天历史 + 14 天计划），
 * 保证 Demo 任何一天打开都是"以今天为中心"的有效数据。
 * 说明：所有机组姓名、航班号、机场均为模拟数据，不含任何真实航司生产数据。
 */
const fs = require('fs');
const path = require('path');
const U = require('./utils');
const P = require('./policy');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BACK_DAYS = 45;
const FWD_DAYS = 14;
const BASE_SEED = 20261029;

const BASES = [
  { code: 'PVG', name: '浦东', prefix: 'MU', perDay: 12, wideRatio: 0.3 },
  { code: 'SHA', name: '虹桥', prefix: 'MU', perDay: 8, wideRatio: 0.05 },
  { code: 'CAN', name: '广州', prefix: 'CZ', perDay: 6, wideRatio: 0.2 },
  { code: 'PEK', name: '北京', prefix: 'CA', perDay: 5, wideRatio: 0.2 },
];

const FLEET = {
  A320: { wide: false, foNeed: 1 },
  B737: { wide: false, foNeed: 1 },
  A330: { wide: true, foNeed: 1 },
  B787: { wide: true, foNeed: 2 },
};

const CREW_PLAN = {
  PVG: { CAPTAIN: 26, FIRST_OFFICER: 32 },
  SHA: { CAPTAIN: 12, FIRST_OFFICER: 14 },
  CAN: { CAPTAIN: 10, FIRST_OFFICER: 12 },
  PEK: { CAPTAIN: 10, FIRST_OFFICER: 12 },
};

const DEST = [
  { code: 'PEK', name: '北京', km: 1080 }, { code: 'CAN', name: '广州', km: 1180 },
  { code: 'CTU', name: '成都', km: 1660 }, { code: 'SZX', name: '深圳', km: 1200 },
  { code: 'XIY', name: '西安', km: 1220 }, { code: 'KMG', name: '昆明', km: 1960 },
  { code: 'HGH', name: '杭州', km: 170 }, { code: 'NKG', name: '南京', km: 270 },
  { code: 'CKG', name: '重庆', km: 1420 }, { code: 'WUH', name: '武汉', km: 690 },
  { code: 'CSX', name: '长沙', km: 900 }, { code: 'XMN', name: '厦门', km: 820 },
  { code: 'SYX', name: '三亚', km: 2010 }, { code: 'HRB', name: '哈尔滨', km: 1350 },
  { code: 'URC', name: '乌鲁木齐', km: 3250 }, { code: 'LXA', name: '拉萨', km: 2900, special: true },
  { code: 'HKG', name: '中国香港', km: 1230, intl: true }, { code: 'TPE', name: '中国台北', km: 690, intl: true },
  { code: 'ICN', name: '首尔', km: 830, intl: true }, { code: 'NRT', name: '东京', km: 1770, intl: true },
  { code: 'SIN', name: '新加坡', km: 3800, intl: true }, { code: 'BKK', name: '曼谷', km: 2900, intl: true },
  { code: 'DXB', name: '迪拜', km: 6400, intl: true, longHaul: true },
  { code: 'SYD', name: '悉尼', km: 8100, intl: true, longHaul: true },
  { code: 'FRA', name: '法兰克福', km: 8800, intl: true, longHaul: true },
];

const SURNAMES = ['张', '王', '李', '赵', '陈', '刘', '杨', '黄', '周', '吴', '徐', '孙', '马', '朱', '胡', '郭', '何', '高', '林', '罗', '郑', '梁', '谢', '宋', '唐', '许', '韩', '冯', '邓', '曹'];
const GIVEN1 = ['伟', '磊', '洋', '勇', '军', '强', '涛', '明', '超', '波', '斌', '宇', '浩', '嘉', '思', '文', '振', '海', '立', '睿', '向', '瑞', '若', '雨', '晨', '子', '佳', '志', '建', '安'];
const GIVEN2 = ['然', '杰', '晖', '宁', '辰', '阳', '轩', '航', '俊', '远', '泽', '诚', '琪', '怡', '峰', '涛', 'polis', 'е'];

const NARROW_TIMES = ['06:30', '07:15', '08:00', '09:20', '11:05', '13:40', '15:10', '17:25', '19:00', '21:30'];
const SIGN_ON_MIN = 60;
const SIGN_OFF_MIN = 30;

function cleanGiven(rnd) {
  let g = U.pick(rnd, GIVEN2);
  while (!/^[一-龥]$/.test(g)) g = U.pick(rnd, GIVEN2.slice(0, 16));
  return g;
}

function uniqueName(rnd, used) {
  for (let i = 0; i < 300; i++) {
    const n = U.pick(rnd, SURNAMES) + U.pick(rnd, GIVEN1) + cleanGiven(rnd);
    if (!used.has(n)) { used.add(n); return n; }
  }
  const n = '机组成员' + (used.size + 1);
  used.add(n);
  return n;
}

// 每个基地的机型投放排布（决定每日航线结构的机型构成，随机按日轮转起始位）
const FLEET_PATTERN = {
  PVG: ['A320', 'B737', 'A330', 'A320', 'B787', 'B737', 'A320', 'B737', 'A330', 'B787', 'A320', 'B737'],
  SHA: ['A320', 'B737', 'A320', 'B737', 'A320', 'B737', 'A330', 'A320'],
  CAN: ['A320', 'B737', 'A330', 'A320', 'B787', 'B737'],
  PEK: ['A320', 'B737', 'A330', 'B737', 'A320'],
};

// 机组规模相对"每日岗位需求"的倍数（覆盖休息/请假/额度后的轮换系数）
const ROTATION = 2.4;

/** 依据基地机队计算出"每种机型每天需要的机长/副驾岗位数" */
function demandOfBase(base) {
  const pattern = FLEET_PATTERN[base.code];
  const cap = {};
  const fo = {};
  for (const t of pattern) {
    cap[t] = (cap[t] || 0) + 1;
    fo[t] = (fo[t] || 0) + FLEET[t].foNeed;
  }
  return { cap, fo };
}

function buildCrew(rnd, anchor) {
  const used = new Set();
  const crew = [];
  let seq = 0;
  for (const b of BASES) {
    const { cap, fo } = demandOfBase(b);
    for (const role of ['CAPTAIN', 'FIRST_OFFICER']) {
      const demand = role === 'CAPTAIN' ? cap : fo;
      // 按各机型需求倍数生成"资质槽位"，使队伍机型结构严格对齐航班机型结构
      const slots = [];
      for (const t of Object.keys(demand)) {
        const n = Math.max(2, Math.round(demand[t] * ROTATION));
        for (let i = 0; i < n; i++) slots.push(t);
      }
      // 稳定洗牌
      for (let i = slots.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [slots[i], slots[j]] = [slots[j], slots[i]];
      }
      let ptr = 0;
      for (let i = 0; i < slots.length; i++) {
        seq += 1;
        const primary = slots[ptr++];
        // 45% 的成员具备第二种机型资质（跨机型备份）；且不再是随机机型
        const others = Object.keys(demand).filter((t) => t !== primary);
        const types = [primary];
        if (others.length && rnd() < 0.45) types.push(others[Math.floor(rnd() * others.length)]);
        const typeRatings = types.map((t, k) => ({
          type: t,
          // 主机型具备机长资质；副机型部分具备 -> 预留资质不匹配样例
          pic: role === 'CAPTAIN' ? (k === 0 ? true : rnd() < 0.5) : false,
          since: `${2005 + Math.floor(rnd() * 18)}-${U.pad(1 + Math.floor(rnd() * 12))}-01`,
          hoursOnType: Math.round(role === 'CAPTAIN'
            ? (k === 0 ? 600 + rnd() * 4200 : 150 + rnd() * 2500)
            : (k === 0 ? 250 + rnd() * 1800 : 100 + rnd() * 900)),
        }));
        crew.push({
          id: 'C' + String(seq).padStart(3, '0'),
          employeeNo: `${b.code}${String(1000 + seq)}`,
          name: uniqueName(rnd, used),
          base: b.code,
          baseName: b.name,
          role,
          roleCn: role === 'CAPTAIN' ? '机长' : '副驾驶',
          license: role === 'CAPTAIN' ? 'ATPL' : (rnd() < 0.7 ? 'ATPL' : 'CPL'),
          typeRatings,
          medicalDue: U.addDays(anchor, Math.floor(rnd() * 400) - 40),
          lineCheckDue: U.addDays(anchor, Math.floor(rnd() * 400) - 30),
          englishLevel: 3 + Math.floor(rnd() * 3),
          highUtil: rnd() < 0.12,
        });
      }
    }
  }
  // 6 名低经历组成员：用于"每组至少一人本机型经历>=100h"规则演练
  for (const c of U.pickN(rnd, crew, 6)) {
    for (const tr of c.typeRatings) tr.hoursOnType = Math.round(28 + rnd() * 55);
  }
  // 3 名"额度突破"示范对象：放宽累计小时校验，用于演示超时/超限风险识别
  const dualRated = crew.filter((c) => {
    const t = c.typeRatings.map((x) => x.type);
    return t.includes('A320') && t.includes('B737') && U.diffDays(anchor, c.medicalDue) > 0;
  });
  const overs = [
    dualRated.find((c) => c.role === 'CAPTAIN'),
    dualRated.find((c) => c.role === 'FIRST_OFFICER'),
    crew.find((c) => c.typeRatings.some((x) => x.type === 'B787') && c.role === 'CAPTAIN'),
  ].filter(Boolean);
  const overIds = new Set(overs.map((c) => c.id));
  for (const c of crew) c.allowOver = overIds.has(c.id);
  return crew;
}

function buildFlights(rnd, start, end) {
  const flights = [];
  let id = 0;
  let dayIdx = 0;
  for (let day = start; U.diffDays(day, end) >= 0; day = U.addDays(day, 1)) {
    for (const b of BASES) {
      for (let i = 0; i < b.perDay; i++) {
        // 机型投放排布按日轮转：每日机型构成稳定，机组资质可精确对齐
        const pat = FLEET_PATTERN[b.code];
        const type = pat[(i + dayIdx) % pat.length];
        const wide = FLEET[type].wide;
        const pool = wide
          ? DEST.filter((d) => d.longHaul || (d.intl && d.km > 2500) || d.km > 1500)
          : DEST.filter((d) => !d.longHaul && d.km <= 3300);
        const dest = U.pick(rnd, pool.length ? pool : DEST);
        const bh = U.round(Math.max(1.0, dest.km / 760 + 0.4), 1);
        const depBase = wide ? (rnd() < 0.5 ? '01:20' : '11:40') : NARROW_TIMES[i % NARROW_TIMES.length];
        const depT = U.addMinutes(depBase, Math.floor(rnd() * 40));
        const arr = U.addMinutes(depT.time, Math.round(bh * 60));
        id += 1;
        flights.push({
          flightId: 'FL' + String(id).padStart(5, '0'),
          flightNo: `${b.prefix}${String(2000 + id)}`,
          date: day,
          dep: b.code,
          depName: b.name,
          arr: dest.code,
          arrName: dest.name,
          aircraft: type,
          depTime: depT.time,
          arrTime: arr.time,
          arrNextDay: arr.nextDay,
          blockHours: bh,
          specialAirport: !!dest.special,
          intl: !!dest.intl,
          require: { CAPTAIN: 1, FIRST_OFFICER: FLEET[type].foNeed },
        });
      }
    }
    dayIdx += 1;
  }
  return flights;
}

function buildAssignments(rnd, crew, flights, start, priorYearHours, leaves = []) {
  // 休假/训练占用：按"人+日期"建索引，排班时跳过
  const leaveMap = new Map();
  for (const l of leaves) {
    for (let d = l.start; U.diffDays(d, l.end) >= 0; d = U.addDays(d, 1)) leaveMap.set(`${l.crewId}|${d}`, l);
  }
  const state = new Map();
  for (const c of crew) {
    state.set(c.id, {
      monthHours: new Map(),
      dayHours: new Map(),
      dayLegs: new Map(),
      lastDutyEndAbs: null,
      lastDutyDate: null,
      streak: 0,
      yearHours: priorYearHours[c.id] || 0,
      onDutyDates: new Set(),
    });
  }
  const assign = [];
  const dayIdxOf = (date) => U.diffDays(start, date);
  const absStart = (f) => dayIdxOf(f.date) * 1440 + U.hm2min(f.depTime);
  const absEnd = (f) => dayIdxOf(f.date) * 1440 + U.hm2min(f.arrTime) + (f.arrNextDay ? 1440 : 0);

  const sorted = flights.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : U.hm2min(a.depTime) - U.hm2min(b.depTime)));

  let rosterId = 0;
  for (const f of sorted) {
    const need = [];
    for (let i = 0; i < f.require.CAPTAIN; i++) need.push('CAPTAIN');
    for (let i = 0; i < f.require.FIRST_OFFICER; i++) need.push('FIRST_OFFICER');
    const taken = new Set();
    for (const pos of need) {
      const cands = crew.filter((c) =>
        c.base === f.dep && c.role === pos && !taken.has(c.id) &&
        c.typeRatings.some((t) => t.type === f.aircraft && (pos === 'CAPTAIN' ? t.pic : true)) &&
        U.diffDays(c.medicalDue, f.date) <= 0); // 排除体检合格证已过期的机组，使基础排班可信、仅注入样例暴露问题
      if (!cands.length) continue;
      const sample = U.pickN(rnd, cands, Math.min(8, cands.length));
      let best = null;
      for (const c of sample) {
        const st = state.get(c.id);
        const dStart = absStart(f);
        const dEnd = absEnd(f);
        // 休假期不得排班
        const lv = leaveMap.get(`${c.id}|${f.date}`);
        if (lv) continue;
        // 最小休息期（硬性，任何人不豁免）
        if (st.lastDutyEndAbs !== null && dStart - st.lastDutyEndAbs < P.LIMITS.MIN_REST_MIN) continue;
        const dayBlock = st.dayHours.get(f.date) || 0;
        const over = !!c.allowOver || c.highUtil;
        if (over ? dayBlock + f.blockHours > P.LIMITS.DAY_BLOCK_MAX + 3 : dayBlock + f.blockHours > P.LIMITS.DAY_BLOCK_MAX) continue;
        const legs = (st.dayLegs.get(f.date) || []).concat([{ s: dStart, e: dEnd }]);
        if (legs.length > P.LIMITS.LANDINGS_MAX_PER_DAY) continue;
        if (legs.length > 1 && legs.some((l, idx) => idx < legs.length - 1 && l.e + 45 > dStart)) continue;
        const fdp = (Math.max(...legs.map((x) => x.e)) - Math.min(...legs.map((x) => x.s)) + SIGN_ON_MIN + SIGN_OFF_MIN) / 60;
        if (fdp > P.LIMITS.FDP_MAX) continue;
        const consec = st.lastDutyDate && U.diffDays(st.lastDutyDate, f.date) === 1;
        if (consec && st.streak + 1 > P.LIMITS.MAX_DUTY_STREAK) continue;
        if (!c.allowOver) {
          let w7 = f.blockHours;
          for (let k = 1; k <= 6; k++) w7 += st.dayHours.get(U.addDays(f.date, -k)) || 0;
          if (w7 > P.LIMITS.WEEK7_HOURS_MAX) continue;
          const mh = (st.monthHours.get(U.monthOf(f.date)) || 0) + f.blockHours;
          if (mh > P.LIMITS.MONTH_HOURS_MAX) continue;
          if (st.yearHours + f.blockHours > P.LIMITS.YEAR_HOURS_MAX) continue;
        }
        // 额度突破示范对象优先获得任务，用于演示"超限"（违规行为样例数据）
        const score = (c.allowOver ? -1000 : 0) + (st.monthHours.get(U.monthOf(f.date)) || 0) + rnd() * 3;
        if (!best || score < best.score) best = { c, score, legs, dStart, dEnd, consec };
      }
      if (!best) continue;
      const c = best.c;
      const st = state.get(c.id);
      taken.add(c.id);
      rosterId += 1;
      assign.push({ id: 'AS' + String(rosterId).padStart(6, '0'), flightId: f.flightId, crewId: c.id, position: pos });
      st.dayHours.set(f.date, U.round((st.dayHours.get(f.date) || 0) + f.blockHours, 2));
      st.monthHours.set(U.monthOf(f.date), U.round((st.monthHours.get(U.monthOf(f.date)) || 0) + f.blockHours, 2));
      st.yearHours = U.round(st.yearHours + f.blockHours, 2);
      st.dayLegs.set(f.date, best.legs);
      if (st.lastDutyDate !== f.date) {
        st.streak = best.consec ? st.streak + 1 : 1;
        st.lastDutyDate = f.date;
        st.onDutyDates.add(f.date);
      }
      st.lastDutyEndAbs = Math.max(st.lastDutyEndAbs || 0, best.dEnd + SIGN_OFF_MIN);
    }
  }
  return assign;
}

/**
 * 注入"违规样例"：让 Demo 的配组/合规查询能查出真实存在的问题。
 * 每类问题注入 2 条（在今日及未来的计划航班上），并在 meta.scenarios 中记录清单。
 */
function injectIssues(rnd, crew, flights, assignments, leaves, anchor) {
  const flightById = new Map(flights.map((f) => [f.flightId, f]));
  const byFlight = new Map();
  for (const a of assignments) {
    if (!byFlight.has(a.flightId)) byFlight.set(a.flightId, []);
    byFlight.get(a.flightId).push(a);
  }
  const crewById = new Map(crew.map((c) => [c.id, c]));
  const leaveByCrewDate = new Map();
  for (const l of leaves) {
    for (let d = l.start; U.diffDays(d, l.end) >= 0; d = U.addDays(d, 1)) leaveByCrewDate.set(`${l.crewId}|${d}`, l);
  }
  const scenarios = [];
  const future = flights.filter((f) => U.diffDays(anchor, f.date) >= 0 && U.diffDays(anchor, f.date) <= 12);
  const shufflePool = U.pickN(rnd, future, future.length);
  const note = (flightId, type, desc) => scenarios.push({ flightId, type, desc });
  const setMember = (flightId, position, newCrewId) => {
    const list = byFlight.get(flightId) || [];
    const a = list.find((x) => x.position === position && x.crewId !== newCrewId);
    if (!a) return false;
    // 同一航班不允许出现重复人员
    if (list.some((x) => x.crewId === newCrewId && x !== a)) return false;
    a.crewId = newCrewId;
    return true;
  };

  const budgets = { NO_PIC_ON_TYPE: 2, MEDICAL_EXPIRED: 2, LOW_HOURS_PAIR: 2, LEAVE_CONFLICT: 2, REST_SHORT: 2 };
  for (const f of shufflePool) {
    const list = byFlight.get(f.flightId) || [];
    if (!list.length) continue;
    const capSlot = list.find((a) => a.position === 'CAPTAIN');
    const foSlot = list.find((a) => a.position === 'FIRST_OFFICER');
    // 每架航班仅注入一种违规样例，避免同一机长席位被多次覆盖导致场景与数据不一致
    let done = false;
    // 1) 机长无本机型的机长(PIC)资质
    if (!done && budgets.NO_PIC_ON_TYPE > 0 && capSlot) {
      const alt = crew.find((c) => c.role === 'CAPTAIN' && c.base === f.dep &&
        c.typeRatings.some((t) => t.type === f.aircraft && !t.pic) && c.id !== (foSlot && foSlot.crewId));
      if (alt && setMember(f.flightId, 'CAPTAIN', alt.id)) {
        budgets.NO_PIC_ON_TYPE -= 1;
        note(f.flightId, 'NO_PIC_ON_TYPE', `${alt.name} 机长未取得 ${f.aircraft} 机长资质`);
        done = true;
      }
    } else if (!done && budgets.MEDICAL_EXPIRED > 0) {
      // 2) 体检合格证过期
      const alt = crew.find((c) => c.base === f.dep && U.diffDays(c.medicalDue, f.date) > 0 &&
        c.typeRatings.some((t) => t.type === f.aircraft && (c.role === 'CAPTAIN' ? t.pic : true)));
      const pos = alt ? (alt.role === 'CAPTAIN' ? 'CAPTAIN' : 'FIRST_OFFICER') : null;
      if (alt && pos && setMember(f.flightId, pos, alt.id)) {
        budgets.MEDICAL_EXPIRED -= 1;
        note(f.flightId, 'MEDICAL_EXPIRED', `${alt.name} 体检合格证已于 ${alt.medicalDue} 到期`);
        done = true;
      }
    } else if (!done && budgets.LOW_HOURS_PAIR > 0 && f.require.FIRST_OFFICER === 1) {
      // 3) 双低经历配组（本机型经历均 <100h）
      const rookCap = crew.find((c) => c.role === 'CAPTAIN' && c.base === f.dep &&
        c.typeRatings.some((t) => t.type === f.aircraft && t.pic && t.hoursOnType < P.LIMITS.CREW_MIX_MIN_TYPE_HOURS));
      const rookFo = crew.find((c) => c.role === 'FIRST_OFFICER' && c.base === f.dep &&
        c.typeRatings.some((t) => t.type === f.aircraft && t.hoursOnType < P.LIMITS.CREW_MIX_MIN_TYPE_HOURS));
      if (rookCap && rookFo && setMember(f.flightId, 'CAPTAIN', rookCap.id) && setMember(f.flightId, 'FIRST_OFFICER', rookFo.id)) {
        budgets.LOW_HOURS_PAIR -= 1;
        note(f.flightId, 'LOW_HOURS_PAIR', `${rookCap.name}+${rookFo.name} 本机型经历均 <${P.LIMITS.CREW_MIX_MIN_TYPE_HOURS}h`);
        done = true;
      }
    } else if (!done && budgets.LEAVE_CONFLICT > 0) {
      // 4) 与请假/训练冲突
      const alt = crew.find((c) => c.base === f.dep &&
        leaveByCrewDate.has(`${c.id}|${f.date}`) &&
        c.typeRatings.some((t) => t.type === f.aircraft && (c.role === 'CAPTAIN' ? t.pic : true)));
      const pos = alt ? (alt.role === 'CAPTAIN' ? 'CAPTAIN' : 'FIRST_OFFICER') : null;
      if (alt && pos && setMember(f.flightId, pos, alt.id)) {
        budgets.LEAVE_CONFLICT -= 1;
        const lv = leaveByCrewDate.get(`${alt.id}|${f.date}`);
        note(f.flightId, 'LEAVE_CONFLICT', `${alt.name} ${f.date} 处于${lv.type}期间仍被排班`);
        done = true;
      }
    } else if (!done && budgets.REST_SHORT > 0 && capSlot) {
      const prevDate = U.addDays(f.date, -1);
      const lateY = assignments.filter((a) => {
        const g = flightById.get(a.flightId);
        return g && g.date === prevDate;
      });
      const altEntry = lateY.map((a) => {
        const g = flightById.get(a.flightId);
        const c = crewById.get(a.crewId);
        const endAbs = absEndOf(g, flightById, start0(flights));
        return { c, endAbs, g };
      }).find((x) => x.c && x.c.base === f.dep && x.c.role === 'CAPTAIN' &&
        x.c.typeRatings.some((t) => t.type === f.aircraft && t.pic) &&
        (U.hm2min(f.depTime) + 1440 - 60) - x.endAbs < P.LIMITS.MIN_REST_MIN);
      if (altEntry && setMember(f.flightId, 'CAPTAIN', altEntry.c.id)) {
        budgets.REST_SHORT -= 1;
        note(f.flightId, 'REST_SHORT', `${altEntry.c.name} 前一航段结束与本机签到间隔 <${P.LIMITS.MIN_REST_MIN / 60}h`);
        done = true;
      }
    }
    if (Object.values(budgets).every((v) => v === 0)) break;
  }
  return scenarios;
}

function absEndOf(f) { return U.hm2min(f.arrTime) + (f.arrNextDay ? 1440 : 0); }
function start0(flights) { return flights.reduce((m, f) => (f.date < m ? f.date : m), flights[0].date); }

function buildLeaves(rnd, crew, start, end) {
  const leaves = [];
  const span = U.diffDays(start, end);
  let id = 0;
  for (const c of U.pickN(rnd, crew, Math.round(crew.length * 0.16))) {
    const kind = U.pick(rnd, ['年休假', '病假', '事假', '复训', '模拟机检查', '体检']);
    const s = U.addDays(start, Math.floor(rnd() * Math.max(1, span)));
    const len = kind === '年休假' ? 3 + Math.floor(rnd() * 5) : 1 + Math.floor(rnd() * 2);
    id += 1;
    leaves.push({ id: 'LV' + String(id).padStart(4, '0'), crewId: c.id, type: kind, start: s, end: U.addDays(s, len - 1), remark: '仿真数据' });
  }
  return leaves;
}

function buildStandby(rnd, crew, flights, assignments, anchor) {
  const rows = [];
  const flightsByBaseDay = new Map();
  for (const f of flights) {
    const k = `${f.date}|${f.dep}`;
    flightsByBaseDay.set(k, (flightsByBaseDay.get(k) || 0) + 1);
  }
  const flying = new Set();
  const flightDate = new Map(flights.map((f) => [f.flightId, f.date]));
  for (const a of assignments) flying.add(`${a.crewId}|${flightDate.get(a.flightId)}`);

  let id = 0;
  const daysSet = [...new Set(flights.map((f) => f.date))].sort();
  for (const d of daysSet) {
    for (const b of BASES) {
      const deps = flightsByBaseDay.get(`${d}|${b.code}`) || 0;
      const required = U.clamp(Math.ceil(deps / P.LIMITS.STANDBY_PER_DEPARTURES), P.LIMITS.STANDBY_MIN, P.LIMITS.STANDBY_MAX);
      const dd = U.diffDays(anchor, d);
      let gap = 0;
      if (b.code === 'PVG' && dd === 1) gap = 2;
      else if (b.code === 'PVG' && (dd === 2 || dd === 4)) gap = 1;
      else if (rnd() < 0.2) gap = 1;
      gap = Math.min(gap, required);
      const usedOnDay = new Set();
      const pool = crew.filter((c) => c.base === b.code && !flying.has(`${c.id}|${d}`));
      for (let i = 0; i < required - gap; i++) {
        const slot = i < Math.ceil(required / 2) ? 'AM' : 'PM';
        const cands = pool.filter((c) => !usedOnDay.has(c.id));
        if (!cands.length) break;
        const c = U.pick(rnd, cands);
        usedOnDay.add(c.id);
        id += 1;
        rows.push({ id: 'SB' + String(id).padStart(5, '0'), crewId: c.id, date: d, base: b.code, slot, status: 'PLANNED' });
      }
    }
  }
  return rows;
}

function generate(anchor = U.today()) {
  const seedMix = parseInt(anchor.replace(/-/g, ''), 10) % 1000000;
  const rnd = U.mulberry32(BASE_SEED + seedMix);
  const jan1 = `${U.yearOf(anchor)}-01-01`;
  const candidate = U.addDays(anchor, -BACK_DAYS);
  const start = U.diffDays(jan1, candidate) > 0 ? candidate : jan1;
  const end = U.addDays(anchor, FWD_DAYS);

  const crew = buildCrew(rnd, anchor);
  const elapsedBeforeWindow = Math.max(0, U.diffDays(jan1, start));
  const priorYearHours = {};
  for (const c of crew) {
    priorYearHours[c.id] = U.round(elapsedBeforeWindow * 2.6 * (0.7 + rnd() * 0.6), 1);
  }

  const flights = buildFlights(rnd, start, end);
  const leaves = buildLeaves(rnd, crew, start, end);
  const assignments = buildAssignments(rnd, crew, flights, start, priorYearHours, leaves);
  // 注入可控的"违规样例"，保证 Demo 的合规/配组查询能查出真实问题
  const scenarios = injectIssues(rnd, crew, flights, assignments, leaves, anchor);
  const standby = buildStandby(rnd, crew, flights, assignments, anchor);

  return {
    meta: {
      anchorDate: anchor,
      windowStart: start,
      windowEnd: end,
      generatedAt: new Date().toISOString(),
      notice: '仿真/脱敏样本数据，不含任何真实航司生产数据',
      scenarioVersion: 'v1.1',
      scenarios,
      standbyRequiredPer: P.LIMITS.STANDBY_PER_DEPARTURES,
      priorYearHours,
    },
    crew, flights, assignments, leaves, standby,
  };
}

function writeAll(dir = DATA_DIR) {
  const data = generate();
  fs.mkdirSync(dir, { recursive: true });
  for (const k of ['meta', 'crew', 'flights', 'assignments', 'leaves', 'standby']) {
    fs.writeFileSync(path.join(dir, `${k}.json`), JSON.stringify(data[k]), 'utf-8');
  }
  return data;
}

module.exports = { generate, writeAll, BASES, FLEET, CREW_PLAN, DATA_DIR, BACK_DAYS, FWD_DAYS };

if (require.main === module) {
  const d = writeAll();
  console.log('[generate] anchor=%s crew=%d flights=%d assignments=%d standby=%d leaves=%d window=%s~%s',
    d.meta.anchorDate, d.crew.length, d.flights.length, d.assignments.length, d.standby.length, d.leaves.length,
    d.meta.windowStart, d.meta.windowEnd);
}
