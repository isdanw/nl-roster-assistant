'use strict';
/**
 * 数据装载层：负责读取仿真数据、判断是否过期（锚点日期非今天则自动重生成），
 * 并建立内存索引。所有数据源均为 data/ 下的仿真 JSON。
 */
const fs = require('fs');
const path = require('path');
const U = require('./utils');
const { generate, writeAll, DATA_DIR } = require('./generateData');

let cache = null;

function loadRaw() {
  const read = (k) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${k}.json`), 'utf-8'));
  return {
    meta: read('meta'),
    crew: read('crew'),
    flights: read('flights'),
    assignments: read('assignments'),
    leaves: read('leaves'),
    standby: read('standby'),
  };
}

function exists() {
  return ['meta', 'crew', 'flights', 'assignments', 'leaves', 'standby']
    .every((k) => fs.existsSync(path.join(DATA_DIR, `${k}.json`)));
}

function buildIndex(raw) {
  const crewById = new Map(raw.crew.map((c) => [c.id, c]));
  const crewByName = new Map(raw.crew.map((c) => [c.name, c]));
  const flightsById = new Map(raw.flights.map((f) => [f.flightId, f]));
  const flightsByDateBase = new Map();
  const flightsByNoDate = new Map();
  for (const f of raw.flights) {
    const k1 = `${f.date}|${f.dep}`;
    if (!flightsByDateBase.has(k1)) flightsByDateBase.set(k1, []);
    flightsByDateBase.get(k1).push(f);
    flightsByNoDate.set(`${f.flightNo}|${f.date}`, f);
  }
  const assignmentsByFlight = new Map();
  const assignmentsByCrew = new Map();
  for (const a of raw.assignments) {
    if (!assignmentsByFlight.has(a.flightId)) assignmentsByFlight.set(a.flightId, []);
    assignmentsByFlight.get(a.flightId).push(a);
    if (!assignmentsByCrew.has(a.crewId)) assignmentsByCrew.set(a.crewId, []);
    assignmentsByCrew.get(a.crewId).push(a);
  }
  const leavesByCrew = new Map();
  for (const l of raw.leaves) {
    if (!leavesByCrew.has(l.crewId)) leavesByCrew.set(l.crewId, []);
    leavesByCrew.get(l.crewId).push(l);
  }
  const standbyByDateBase = new Map();
  for (const s of raw.standby) {
    const k = `${s.date}|${s.base}`;
    if (!standbyByDateBase.has(k)) standbyByDateBase.set(k, []);
    standbyByDateBase.get(k).push(s);
  }
  const standbyByCrew = new Map();
  for (const s of raw.standby) {
    if (!standbyByCrew.has(s.crewId)) standbyByCrew.set(s.crewId, []);
    standbyByCrew.get(s.crewId).push(s);
  }
  return {
    crewById, crewByName, flightsById, flightsByDateBase, flightsByNoDate,
    assignmentsByFlight, assignmentsByCrew, leavesByCrew, standbyByDateBase, standbyByCrew,
  };
}

function ensure() {
  const anchor = U.today();
  if (cache && cache.meta.anchorDate === anchor) return cache;
  if (!exists()) writeAll(DATA_DIR);
  let raw = loadRaw();
  if (raw.meta.anchorDate !== anchor) {
    raw = generate(anchor); // 日期变化 -> 按新锚点重新生成仿真数据
    writeAll(DATA_DIR);
  }
  cache = Object.assign({}, raw, { index: buildIndex(raw) });
  return cache;
}

function get() { return ensure(); }

module.exports = { ensure, get, buildIndex, DATA_DIR };
