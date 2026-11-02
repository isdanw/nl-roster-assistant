'use strict';
/**
 * 语义识别层：自然语言 → 意图 + 槽位 → 对应接口名。
 * 不接任何外部 NLP 服务，纯规则 + 词典匹配，零第三方依赖。
 *
 * 支持意图（与 services.REGISTRY 一一对应）：
 *   remaining_hours   剩余飞行小时 + 超时风险
 *   pairing_check     配组合法性
 *   standby_gap       浦东基地备勤缺口
 *   base_coverage     某日基地排班覆盖
 *   rest_compliance   连续执勤 / 休息期合规
 *
 * 未识别或槽位不足时，返回清晰提示（message），不臆造结果。
 */
const store = require('./dataStore');
const U = require('./utils');

function anchor() { return store.get().meta.anchorDate; }

// ---- 槽位提取 ----
function extractDate(text) {
  const a = anchor();
  if (/(今天|今日)/.test(text)) return a;
  if (/(明天)/.test(text)) return U.addDays(a, 1);
  if (/(后天)/.test(text)) return U.addDays(a, 2);
  if (/(大后天)/.test(text)) return U.addDays(a, 3);
  if (/(昨天)/.test(text)) return U.addDays(a, -1);
  if (/(前天)/.test(text)) return U.addDays(a, -2);
  // YYYY-MM-DD
  const iso = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
  // M月D日 / M月D号
  const md = text.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (md) {
    const y = U.yearOf(a);
    return `${y}-${String(Number(md[1])).padStart(2, '0')}-${String(Number(md[2])).padStart(2, '0')}`;
  }
  // 本周X（一~日）
  const wk = text.match(/本周([一二三四五六日])/);
  if (wk) {
    const map = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6 };
    const target = map[wk[1]];
    const mon = U.mondayOf(a);
    // mondayOf 返回的是"本周一"；若 target<mon的星期则顺延到下周
    let d = mon;
    while (U.weekdayIdx(d) !== target) d = U.addDays(d, 1);
    return d;
  }
  return null;
}

function extractBase(text) {
  if (/浦东|PVG/.test(text)) return 'PVG';
  if (/虹桥|SHA/.test(text)) return 'SHA';
  if (/广州|CAN/.test(text)) return 'CAN';
  if (/北京|PEK/.test(text)) return 'PEK';
  return null;
}

function extractFlightNo(text) {
  const m = text.toUpperCase().match(/[A-Z]{2}\s?\d{2,5}/);
  if (m) return m[0].replace(/\s/g, '');
  return null;
}

function extractFlightId(text) {
  const m = text.toUpperCase().match(/FL\s?\d{4,6}/);
  if (m) return m[0].replace(/\s/g, '');
  return null;
}

function extractCrew(text) {
  const db = store.get();
  // 优先精确匹配已知姓名（取最长命中，避免子串误判）
  let best = null;
  for (const name of db.index.crewByName.keys()) {
    if (text.includes(name) && (!best || name.length > best.length)) best = name;
  }
  if (best) return best;
  // 工号 / 编号
  const id = text.match(/\b(C\d{3}|[A-Z]{3}\d{4})\b/);
  if (id) return id[0];
  return null;
}

const INTENT_INFO = {
  remaining_hours: { title: '剩余飞行小时 + 超时风险', needCrew: true },
  pairing_check: { title: '配组合法性' },
  standby_gap: { title: '浦东基地备勤缺口' },
  base_coverage: { title: '某日基地排班覆盖' },
  rest_compliance: { title: '连续执勤 / 休息期合规', needCrew: true },
};

function recognize(text) {
  const t = (text || '').trim();
  if (!t) return { intent: null, service: null, slots: {}, confidence: 0, message: '请输入查询，例如：邓勇涛 还有多少飞行小时' };

  const slots = {
    crew: extractCrew(t),
    flightId: extractFlightId(t),
    flightNo: extractFlightNo(t),
    base: extractBase(t),
    date: extractDate(t),
  };

  let intent = null;
  if (/备勤|备份/.test(t)) intent = 'standby_gap';
  else if (/休息|执勤|连续|周休/.test(t)) intent = 'rest_compliance';
  else if (/覆盖|到位/.test(t)) intent = 'base_coverage';
  else if (/配组|资质|机组/.test(t) || slots.flightNo || slots.flightId) intent = 'pairing_check';
  else if (/排班/.test(t)) intent = 'base_coverage';
  else if (/飞行小时|剩余|超时|额度|小时|可用/.test(t)) intent = 'remaining_hours';

  if (!intent) {
    return {
      intent: null,
      service: null,
      slots,
      confidence: 0,
      message: '未能识别查询意图。可尝试：①「邓勇涛 还有多少飞行小时」②「MU1790 配组合法吗」③「浦东 明天 备勤够不够」④「10月30号 浦东 排班覆盖」⑤「王五 连续执勤合规吗」',
    };
  }

  // 槽位补全：备勤/覆盖默认基地浦东；覆盖/备勤默认今天
  if (intent === 'standby_gap' || intent === 'base_coverage') {
    if (!slots.base) slots.base = 'PVG';
  }

  // 意图需要的必填槽位检查 -> 给出明确提示
  const info = INTENT_INFO[intent];
  if (info.needCrew && !slots.crew) {
    return {
      intent,
      service: intent,
      slots,
      confidence: 0.5,
      message: `已识别为【${info.title}】，但缺少机组姓名/工号，请补充（如：「何睿航 还有多少飞行小时」）。`,
    };
  }
  if (intent === 'pairing_check' && !slots.flightNo && !slots.flightId && !slots.date) {
    return {
      intent,
      service: intent,
      slots,
      confidence: 0.5,
      message: `已识别为【${info.title}】，但缺少航班号/航班ID或日期+基地，请补充（如：「MU1790 配组合法吗」或「2026-10-30 浦东 配组」）。`,
    };
  }

  return { intent, service: intent, slots, confidence: 0.9, message: null };
}

module.exports = { recognize, extractDate, extractBase, extractFlightNo, extractFlightId, extractCrew, INTENT_INFO };
