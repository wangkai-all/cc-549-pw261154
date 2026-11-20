'use strict';

// 核心域逻辑：接收端（按来源保存各自时间戳）、拼接端（标明缺口与替换范围）、
// 推送端（只对受影响的小时重发）。不依赖任何内置模块以外的包。

const SOURCES = ['realtime', 'archive'];
const MODES = ['prefer-fast', 'confirmed-only'];

const SOURCE_LABEL = { realtime: '快速采样', archive: '归档文件' };
const MODE_LABEL = { 'prefer-fast': '先保快速读数', 'confirmed-only': '只给确认值' };
const STATUS_LABEL = {
  confirmed: '已确认',
  provisional: '暂定（待归档确认）',
  withheld: '未确认（按规则暂不发布）',
  gap: '缺口',
};

class IngestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IngestError';
    this.statusCode = 400;
  }
}

function hourKeyOf(isoTime) {
  return isoTime.slice(0, 13); // 'YYYY-MM-DDTHH'
}

function hourLabel(hourKey) {
  return hourKey.replace('T', ' ') + ':00';
}

function isNextHour(a, b) {
  return Date.parse(a + ':00:00.000Z') + 3600000 === Date.parse(b + ':00:00.000Z');
}

// 把连续小时合并为「HH:00–HH:59」式的可读区间
function formatHourRanges(hourKeys) {
  const sorted = [...hourKeys].sort();
  const runs = [];
  for (const h of sorted) {
    const last = runs[runs.length - 1];
    if (last && isNextHour(last.to, h)) last.to = h;
    else runs.push({ from: h, to: h });
  }
  return runs
    .map((r) => `${hourLabel(r.from)}–${r.to.slice(11)}:59`)
    .join('、');
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function round3(x) {
  return x === null ? null : Math.round(x * 1000) / 1000;
}

function normalizeTime(value, index) {
  let ms;
  if (typeof value === 'number' && Number.isFinite(value)) {
    ms = value;
  } else if (typeof value === 'string') {
    ms = Date.parse(value);
  } else {
    ms = NaN;
  }
  if (!Number.isFinite(ms)) {
    throw new IngestError(`第 ${index + 1} 条记录的 time 无法解析：${JSON.stringify(value)}`);
  }
  return new Date(ms).toISOString();
}

function normalizeRecord(record, index) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new IngestError(`第 ${index + 1} 条记录不是对象`);
  }
  const time = normalizeTime(record.time, index);
  const height = record.height;
  if (typeof height !== 'number' || !Number.isFinite(height)) {
    throw new IngestError(`第 ${index + 1} 条记录的 height 不是有限数值：${JSON.stringify(record.height)}`);
  }
  return { time, height };
}

class TideStore {
  constructor() {
    // 接收端：两个来源各自独立保存，键为测量时间戳，值含接收时间戳
    this.readings = { realtime: new Map(), archive: new Map() };
    this.receipts = [];
    this.events = []; // 小时交接记录
    this.pushes = []; // 推送记录
    this.lastPushed = { 'prefer-fast': new Map(), 'confirmed-only': new Map() };
    this.seq = 0;
  }

  _event(type, summary, extra = {}) {
    const event = { seq: ++this.seq, at: new Date().toISOString(), type, summary, ...extra };
    this.events.push(event);
    return event;
  }

  // 接收端：校验并保存某来源的一批记录，随后拼接 + 推送受影响小时
  ingest(source, records, options = {}) {
    if (!SOURCES.includes(source)) {
      throw new IngestError(`未知来源：${JSON.stringify(source)}（可用：${SOURCES.join('、')}）`);
    }
    if (!Array.isArray(records) || records.length === 0) {
      throw new IngestError('records 必须是非空数组');
    }
    const receivedAt = options.receivedAt || new Date().toISOString();
    const normalized = records.map((r, i) => normalizeRecord(r, i));
    normalized.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

    const store = this.readings[source];
    const changedHours = new Set();
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    for (const rec of normalized) {
      const prev = store.get(rec.time);
      if (prev === undefined) {
        added++;
        changedHours.add(hourKeyOf(rec.time));
      } else if (prev.height !== rec.height) {
        updated++;
        changedHours.add(hourKeyOf(rec.time));
      } else {
        unchanged++;
      }
    }

    // 拼接端：先记录变化前的小时状态，再落库，再算变化后的状态
    const before = {};
    for (const mode of MODES) {
      before[mode] = new Map([...changedHours].map((h) => [h, this.hourInfo(h, mode)]));
    }
    for (const rec of normalized) {
      store.set(rec.time, { height: rec.height, receivedAt });
    }

    const receipt = {
      source,
      sourceLabel: SOURCE_LABEL[source],
      receivedAt,
      count: normalized.length,
      added,
      updated,
      unchanged,
      firstTime: normalized[0].time,
      lastTime: normalized[normalized.length - 1].time,
    };
    this.receipts.push(receipt);

    this._event(
      'receive',
      `接收${SOURCE_LABEL[source]} ${normalized.length} 条（新增 ${added}、更新 ${updated}、重复 ${unchanged}），` +
        `测量时间 ${normalized[0].time} – ${normalized[normalized.length - 1].time}`,
      { source, changedHours: [...changedHours].sort() }
    );

    const impact = {};
    const pushed = {};
    const summary = {};
    for (const mode of MODES) {
      impact[mode] = this._classifyImpact(mode, before[mode]);
      pushed[mode] = this._push(mode, impact[mode], source, receivedAt);
      summary[mode] = this._summarizeImpact(mode, source, impact[mode], pushed[mode]);
    }

    return { receipt, changedHours: [...changedHours].sort(), impact, pushed, summary };
  }

  _classifyImpact(mode, beforeMap) {
    const items = [];
    for (const [hour, b] of beforeMap) {
      const a = this.hourInfo(hour, mode);
      let kind;
      if (!b.source && a.source) kind = 'filled'; // 缺口被补齐
      else if (b.source && a.source && b.source !== a.source) kind = 'replaced'; // 来源被替换
      else if (b.source && a.source && b.height !== a.height) kind = 'updated'; // 同源数值修正
      else kind = 'no-change';
      items.push({ hour, kind, before: b, after: a });
    }
    items.sort((x, y) => (x.hour < y.hour ? -1 : 1));
    return items;
  }

  // 推送端：只对合并结果发生变化的小时重发
  _push(mode, impact, triggerSource, at) {
    const affected = impact.filter((i) => i.kind !== 'no-change');
    if (affected.length === 0) return null;
    const hours = affected.map((i) => ({
      hour: i.hour,
      height: i.after.height,
      source: i.after.source,
      status: i.after.status,
    }));
    const last = this.lastPushed[mode];
    for (const h of hours) last.set(h.hour, `${h.source}:${h.height}`);
    const entry = {
      seq: ++this.seq,
      at,
      mode,
      modeLabel: MODE_LABEL[mode],
      reason: `receive:${triggerSource}`,
      hours,
    };
    this.pushes.push(entry);
    this.events.push({
      seq: entry.seq,
      at,
      type: 'push',
      mode,
      summary:
        `推送（${MODE_LABEL[mode]}）重发 ${hours.length} 个小时：` +
        formatHourRanges(hours.map((h) => h.hour)),
      hours: hours.map((h) => h.hour),
    });
    return entry;
  }

  _summarizeImpact(mode, source, impact, pushEntry) {
    const filledRt = impact.filter((i) => i.kind === 'filled' && i.after.source === 'realtime').map((i) => i.hour);
    const filledAr = impact.filter((i) => i.kind === 'filled' && i.after.source === 'archive').map((i) => i.hour);
    const replaced = impact.filter((i) => i.kind === 'replaced');
    const updated = impact.filter((i) => i.kind === 'updated').map((i) => i.hour);
    const parts = [`【${MODE_LABEL[mode]}】${SOURCE_LABEL[source]}到达后`];
    if (filledRt.length) parts.push(`新增暂定覆盖 ${formatHourRanges(filledRt)}`);
    if (filledAr.length) parts.push(`补齐缺口 ${formatHourRanges(filledAr)}（归档确认）`);
    if (replaced.length) {
      const runs = formatHourRanges(replaced.map((i) => i.hour));
      const from = SOURCE_LABEL[replaced[0].before.source];
      const to = SOURCE_LABEL[replaced[0].after.source];
      parts.push(`替换 ${runs}（${from}→${to}）`);
    }
    if (updated.length) parts.push(`修正 ${formatHourRanges(updated)}`);
    if (!filledRt.length && !filledAr.length && !replaced.length && !updated.length) parts.push('合并结果无变化');
    parts.push(pushEntry ? `重发 ${pushEntry.hours.length} 个小时` : '无需重发');
    return parts.join('；');
  }

  _hourValues(source, hourKey) {
    const out = [];
    for (const [time, rec] of this.readings[source]) {
      if (hourKeyOf(time) === hourKey) out.push(rec.height);
    }
    return out;
  }

  // 拼接端的时间轴：从最早到最晚有数据的小时连续铺开，
  // 中间没有任何来源数据的小时就是缺口，必须显式列出。
  hours() {
    const set = new Set();
    for (const source of SOURCES) {
      for (const time of this.readings[source].keys()) set.add(hourKeyOf(time));
    }
    if (set.size === 0) return [];
    const sorted = [...set].sort();
    const out = [];
    const end = Date.parse(sorted[sorted.length - 1] + ':00:00.000Z');
    for (let cur = Date.parse(sorted[0] + ':00:00.000Z'); cur <= end; cur += 3600000) {
      out.push(new Date(cur).toISOString().slice(0, 13));
    }
    return out;
  }

  // 拼接端：某个小时在指定模式下的合并结果与来源解释
  hourInfo(hourKey, mode) {
    if (!MODES.includes(mode)) {
      throw new IngestError(`未知拼接方式：${JSON.stringify(mode)}（可用：${MODES.join('、')}）`);
    }
    const rt = this._hourValues('realtime', hourKey);
    const ar = this._hourValues('archive', hourKey);
    const rtMean = round3(mean(rt));
    const arMean = round3(mean(ar));

    let source = null;
    let height = null;
    if (mode === 'prefer-fast') {
      // 先保快速读数：确认值到达前先用快速读数顶着，确认值一到即替换
      if (ar.length) {
        source = 'archive';
        height = arMean;
      } else if (rt.length) {
        source = 'realtime';
        height = rtMean;
      }
    } else if (ar.length) {
      // 只给确认值：没有归档确认的小时一律不发布
      source = 'archive';
      height = arMean;
    }

    let status;
    if (source === 'archive') status = 'confirmed';
    else if (source === 'realtime') status = 'provisional';
    else if (rt.length) status = 'withheld'; // 只给确认值模式下：有快速读数但未确认
    else status = 'gap';

    return {
      hour: hourKey,
      label: hourLabel(hourKey),
      realtimeCount: rt.length,
      archiveCount: ar.length,
      realtimeMean: rtMean,
      archiveMean: arMean,
      source,
      sourceLabel: source ? SOURCE_LABEL[source] : '—',
      height,
      status,
      statusLabel: STATUS_LABEL[status],
      uncertain: status !== 'confirmed',
      divergence: rtMean !== null && arMean !== null ? round3(Math.abs(rtMean - arMean)) : null,
    };
  }

  _sourceStat(source) {
    const times = [...this.readings[source].keys()].sort();
    const hours = new Set(times.map(hourKeyOf));
    return {
      count: times.length,
      firstTime: times[0] || null,
      lastTime: times[times.length - 1] || null,
      hours: hours.size,
      lastReceivedAt: this.receipts.filter((r) => r.source === source).map((r) => r.receivedAt).pop() || null,
    };
  }

  // 当前仍不确定的部分：缺口、暂定、未确认，按连续区间给出
  uncertainRanges(hours) {
    const pick = (status) => hours.filter((h) => h.status === status).map((h) => h.hour);
    const gaps = pick('gap');
    const provisional = pick('provisional');
    const withheld = pick('withheld');
    const parts = [];
    if (gaps.length) parts.push(`缺口 ${formatHourRanges(gaps)}（两个来源都没有数据）`);
    if (provisional.length) parts.push(`暂定 ${formatHourRanges(provisional)}（仅有快速采样，待归档确认）`);
    if (withheld.length) parts.push(`未确认 ${formatHourRanges(withheld)}（有快速读数，但当前只发布确认值）`);
    return {
      gaps,
      provisional,
      withheld,
      text: parts.length ? parts.join('；') : '全部小时均已确认',
    };
  }

  state(mode) {
    if (!MODES.includes(mode)) {
      throw new IngestError(`未知拼接方式：${JSON.stringify(mode)}（可用：${MODES.join('、')}）`);
    }
    const hours = this.hours().map((h) => this.hourInfo(h, mode));
    return {
      mode,
      modeLabel: MODE_LABEL[mode],
      modes: MODES.map((m) => ({ value: m, label: MODE_LABEL[m] })),
      sourceLabels: SOURCE_LABEL,
      generatedAt: new Date().toISOString(),
      sources: { realtime: this._sourceStat('realtime'), archive: this._sourceStat('archive') },
      hours,
      uncertain: this.uncertainRanges(hours),
      events: this.events.slice(-100),
      pushes: this.pushes.slice(-100),
    };
  }
}

module.exports = { TideStore, IngestError, SOURCES, MODES, MODE_LABEL, SOURCE_LABEL, formatHourRanges };
