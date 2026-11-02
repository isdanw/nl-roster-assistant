'use strict';
// 通用工具：日期、随机、格式化。零第三方依赖。

function pad(n) { return String(n).padStart(2, '0'); }

/** 本地时区的 YYYY-MM-DD */
function toISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function today() { return toISO(new Date()); }

function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

function diffDays(a, b) {
  return Math.round((parseISO(b) - parseISO(a)) / 86400000);
}

const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function weekdayCN(iso) { return WD[parseISO(iso).getDay()]; }
function weekdayIdx(iso) { return parseISO(iso).getDay(); }

function monthOf(iso) { return iso.slice(0, 7); }
function yearOf(iso) { return iso.slice(0, 4); }

/** 本周一 */
function mondayOf(iso) {
  const idx = weekdayIdx(iso); // 0=周日
  const back = idx === 0 ? 6 : idx - 1;
  return addDays(iso, -back);
}

/** HH:mm -> 分钟 */
function hm2min(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function min2hm(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** 起飞时刻 + 分钟 -> HH:mm（同一日历日内环绕，跨日用 +1d 标记） */
function addMinutes(hhmm, mins) {
  const total = hm2min(hhmm) + mins;
  const wrap = total >= 1440;
  return { time: min2hm(total), nextDay: wrap };
}

/** 跨日历日到达时，落地分钟数（相对起飞时刻所在日的 00:00） */
function endMinutes(startHHMM, blockMinutes) {
  return hm2min(startHHMM) + blockMinutes;
}

function min2h(min) { return Math.round((min / 60) * 100) / 100; }

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function round(v, digits = 1) { const p = 10 ** digits; return Math.round(v * p) / p; }

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rnd, arr) { return arr[Math.floor(rnd() * arr.length)]; }
function pickN(rnd, arr, n) {
  const pool = arr.slice(); const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return out;
}

module.exports = {
  pad, toISO, today, parseISO, addDays, diffDays, weekdayCN, weekdayIdx,
  monthOf, yearOf, mondayOf, hm2min, min2hm, addMinutes, endMinutes,
  min2h, clamp, round, mulberry32, pick, pickN,
};
