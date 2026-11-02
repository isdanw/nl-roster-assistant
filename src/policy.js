'use strict';
/**
 * 仿真口径的合规策略（对 CCAR-121-R7 相关条款做工程化简化，仅用于 Demo 演示，
 * 不等同于任何航司/局方的真实运行手册）。
 */
const LIMITS = {
  YEAR_HOURS_MAX: 1000,   // 任一日历年内飞行小时上限（演示取值）
  MONTH_HOURS_MAX: 100,   // 任一日历月飞行小时上限
  WEEK7_HOURS_MAX: 40,    // 任意连续 7 个日历日飞行小时上限
  DAY_BLOCK_MAX: 9,       // 单个日历日航段飞行小时上限
  FDP_MAX: 12,            // 单个日历日值勤期上限（小时）
  MIN_REST_MIN: 600,      // 两次值勤之间最小休息期：10 小时
  MAX_DUTY_STREAK: 6,     // 连续值勤天数上限
  WEEK_REST_MIN: 1440,    // 任意连续 7 日内至少 1 段连续休息 ≥ 24h（演示取 24h）
  SPECIAL_AIRPORT_MIN_PIC_HOURS: 100, // 高原/特殊机场：机长本机型机长经历门槛（小时）
  CREW_MIX_MIN_TYPE_HOURS: 100,       // 每组至少一名成员本机型经历 ≥100h
  NEW_PIC_MAX: 500,                   // 本机型 <500h 视为"新机长"，两名新机长不得同组
  STANDBY_PER_DEPARTURES: 12,         // 每 12 个出港航班需 1 个备勤组
  STANDBY_MIN: 2,
  STANDBY_MAX: 8,
  LANDINGS_MAX_PER_DAY: 6,
};

const RISK = {
  SAFE: '正常',
  WATCH: '关注',
  WARN: '预警',
  EXCEED: '超限',
};

/** 剩余小时 -> 风险等级（针对"剩余额度"型指标） */
function riskOfRemaining(hoursUsed, limit) {
  const rate = hoursUsed / limit;
  if (rate > 1) return RISK.EXCEED;
  if (rate >= 0.9) return RISK.WARN;
  if (rate >= 0.75) return RISK.WATCH;
  return RISK.SAFE;
}

function levelOf(count) {
  if (count === 0) return 'OK';
  return 'NG';
}

module.exports = { LIMITS, RISK, riskOfRemaining, levelOf };
