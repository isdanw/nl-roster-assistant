# 接口清单（API Reference）

> 自然语言排班助手 Demo。所有数据均为**仿真/脱敏样本**，不接任何真实排班系统。
> 链路：自然语言 → 语义识别（意图+槽位）→ 命中下列 5 类查询接口 → 前端展示。
> 核心求解器（`src/roster.js` 的飞行小时/执勤/休息计算）保持不变，本文件描述的 5 个接口均为在其之上的**应用层封装**。

## 调用方式

- 整体链路：`POST /api/query { "q": "<自然语言>" }` 或 `GET /api/query?q=<自然语言>`
  - 返回 `{ ok, recognized, intent, intentTitle, slots, confidence, result }`
  - 未识别：`{ ok:false, intent:null, message:"..." }`；意图命中但槽位不足：`{ ok:false, intent, message:"..." }`
- 接口清单：`GET /api/services`
- 可用示例：`GET /api/demo`（返回基于当前数据、保证可命中的示例问句）
- 各接口也可被语义层直接调用：`run(serviceName, params)`，params 见下文。

---

## 1. 剩余飞行小时 + 超时风险 `remaining_hours`

**用途**：查询指定机组在某一时点的年度 / 月度 / 任意连续 7 日飞行小时消耗与剩余额度，并给出超时风险等级（正常 / 关注 / 预警 / 超限）。

**入参**
| 参数 | 必填 | 说明 |
| - | - | - |
| `crew` | 是 | 机组姓名 / 工号（如 `何睿航` `PVG1001` `C001`） |
| `asOf` | 否 | 统计截止日 `YYYY-MM-DD`，默认今天（数据锚点日） |

**出参**
```
{
  crew:   { id, name, employeeNo, base, baseName, role },
  asOf,
  year:   { used, limit:1000, remain, risk },
  month:  { used, limit:100,  remain, risk },
  week7:  { used, limit:40,   remain, risk, windowEnd },
  plannedFuture, next7Hours
}
```

**示例**
- 输入：`何睿航 还有多少飞行小时`
- 输出（节选）：
```
year:  used 959.5 / limit 1000 / remain 40.5 / risk 预警
month: used 103.2 / limit 100  / remain 0    / risk 超限
week7: used 23.5  / limit 40   / remain 16.5 / risk 正常
```

---

## 2. 配组合法性 `pairing_check`

**用途**：审查单个航班或某日某基地整批航班的机组合法性：机长 PIC 资质、体检合格证有效性、本机型经历门槛（每组至少 1 人 ≥100h）、请假/训练冲突、高原/特殊机场机长经历等。

**入参（满足其一即可）**
| 参数 | 必填 | 说明 |
| - | - | - |
| `flightId` | 否 | 航班内部 ID（如 `FL01432`） |
| `flightNo` | 否 | 航班号（如 `MU3570`），跨日整批审查 |
| `date` + `base` | 否 | 某日某基地整批审查（如 `date=2026-10-30, base=PVG`） |

**出参**
```
{
  scope, count, illegalCount,
  results: [{
    flightNo, date, aircraft, dep, arr, depTime,
    members: [{ position, name, rating:{pic,hours}, medicalDue }],
    violations: [{ rule, severity:'HIGH'|'LOW', detail }],
    legal: boolean
  }]
}
```
规则枚举：`NO_PIC_ON_TYPE` `MEDICAL_EXPIRED` `LOW_HOURS_PAIR` `MISSING_CAPTAIN` `MISSING_FO` `TYPE_MISSING` `LEAVE_CONFLICT` `SPECIAL_AIRPORT` `NEW_PIC_WATCH`。

**示例**
- 输入：`航班MU3570 配组合法吗`
- 输出（节选）：
```
scope: 航班号 MU3570, count:1, illegalCount:1
results[0]: 航班 MU3570 / B737
  violations: [{ rule:"NO_PIC_ON_TYPE", severity:"HIGH",
                 detail:"机长 徐涛琪 未取得 B737 机长(PIC)资质" }]
```

---

## 3. 浦东基地备勤缺口 `standby_gap`

**用途**：按规则「每 12 个出港航班需 1 个备勤组、下限 2、上限 8」计算各基地每日应备勤数量，与实际排布对比，输出备勤缺口。默认浦东。

**入参**
| 参数 | 必填 | 说明 |
| - | - | - |
| `base` | 否 | 基地代码/名称，默认 `PVG`（浦东），支持 `SHA/CAN/PEK` |
| `date` / `dateFrom`+`dateTo` / `days` | 否 | 查询日期或区间，默认今天 |

**出参**
```
{ base, baseName, totalGap, hasGap,
  rows: [{ date, base, departures, required, actual, gap, status:'充足'|'缺口'|'富余' }] }
```

**示例**
- 输入：`浦东 明天 备勤够不够`
- 输出（节选）：
```
rows: [{ date:"2026-10-30", base:"PVG", departures:12, required:2, actual:0, gap:2, status:"缺口" }]
totalGap: 2
```

---

## 4. 某日基地排班覆盖 `base_coverage`

**用途**：统计某日某基地所有出港航班的机组覆盖情况——每个航班是否配齐所需机长与副驾驶，输出覆盖率与未覆盖航班清单。

**入参**
| 参数 | 必填 | 说明 |
| - | - | - |
| `date` | 否 | 查询日期 `YYYY-MM-DD`，默认今天 |
| `base` | 否 | 基地代码/名称，默认 `PVG`（浦东） |

**出参**
```
{ date, base, baseName, totalFlights, covered, uncovered, coverageRate,
  flights: [{ flightNo, aircraft, depTime, arr, cap, fo, needCap, needFo, covered }] }
```

**示例**
- 输入：`10月30日 浦东 排班覆盖`
- 输出（节选）：
```
totalFlights:12, covered:11, uncovered:1, coverageRate:0.92
```

---

## 5. 连续执勤 / 休息期合规 `rest_compliance`

**用途**：审查机组在指定时间窗内的连续执勤天数、值勤间最小休息期（≥10h）、值勤期上限、周休（任意连续 7 日含 ≥24h 连续休息）是否满足，输出违规清单。

**入参**
| 参数 | 必填 | 说明 |
| - | - | - |
| `crew` | 是 | 机组姓名 / 工号 / 编号 |
| `since` / `until` | 否 | 审查时间窗，默认今天前后各 10 天 |

**出参**
```
{ crew, window:{since,until}, compliant, violationCount,
  violations: [{ rule:'MIN_REST'|'CONSECUTIVE_DUTY'|'FDP_MAX'|'DAY_BLOCK_MAX'|'LEAVE_CONFLICT'|'STANDBY_CONFLICT', severity, date, detail }],
  weeklyRestGaps: [{ windowStart, windowEnd, maxRestHours, required }] }
```

**示例**
- 输入：`何睿航 连续执勤合规吗`
- 输出（节选）：
```
window: { since:"2026-10-19", until:"2026-11-08" }
compliant: false, violationCount: 1
```

---

## 语义识别层（NLU）支持的槽位

| 槽位 | 识别方式 | 示例 |
| - | - | - |
| 机组 `crew` | 精确匹配仿真花名册姓名 / 工号 / 编号 | `何睿航` `PVG1001` `C001` |
| 航班号 `flightNo` | `AA\d{2,5}` 形式（如 `MU3570`） | `MU3570` |
| 航班ID `flightId` | `FL\d{4,6}` 形式 | `FL01432` |
| 基地 `base` | 浦东/虹桥/广州/北京 或 PVG/SHA/CAN/PEK | `浦东` |
| 日期 `date` | 今天/明天/昨天、`MM月DD日`、`YYYY-MM-DD`、本周X | `10月30日` `2026-10-30` |

未识别或槽位不足时返回明确提示，不臆造结果。
