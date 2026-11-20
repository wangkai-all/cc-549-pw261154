'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TideStore, IngestError } = require('../lib/tide-store');
const demo = require('../lib/demo-data');
const { createServer } = require('../server');

// ---------- 虚构数据生成器 ----------

test('虚构数据可重复生成：两次生成的记录完全一致', () => {
  assert.deepEqual(demo.realtimeBatch(), demo.realtimeBatch());
  assert.deepEqual(demo.archiveBatch(), demo.archiveBatch());
});

test('快速采样批次：60 条，03、04 时缺测；归档批次：24 条，覆盖 02–05 时', () => {
  const rt = demo.realtimeBatch();
  assert.equal(rt.length, 60);
  const rtHours = new Set(rt.map((r) => r.time.slice(11, 13)));
  assert.ok(!rtHours.has('03') && !rtHours.has('04'), '实时批次不应包含 03/04 时');
  const ar = demo.archiveBatch();
  assert.equal(ar.length, 24);
  assert.equal(ar[0].time, '2026-11-21T02:00:00.000Z');
  assert.equal(ar[ar.length - 1].time, '2026-11-21T05:50:00.000Z');
});

// ---------- 接收端 ----------

test('接收端按来源分别保存各自时间戳', () => {
  const store = new TideStore();
  store.ingest('realtime', demo.realtimeBatch());
  store.ingest('archive', demo.archiveBatch());
  const state = store.state('prefer-fast');
  assert.equal(state.sources.realtime.count, 60);
  assert.equal(state.sources.archive.count, 24);
  assert.equal(state.sources.realtime.firstTime, '2026-11-21T00:00:00.000Z');
  assert.equal(state.sources.archive.firstTime, '2026-11-21T02:00:00.000Z');
  assert.ok(state.sources.realtime.lastReceivedAt, '应记录接收时间戳');
  assert.ok(state.sources.archive.lastReceivedAt, '应记录接收时间戳');
});

// ---------- 拼接端：正常流程 ----------

test('先保快速读数：实时数据到达后 03、04 时标为缺口，其余为暂定', () => {
  const store = new TideStore();
  store.ingest('realtime', demo.realtimeBatch());
  const state = store.state('prefer-fast');
  const byHour = new Map(state.hours.map((h) => [h.hour, h]));
  assert.equal(byHour.get('2026-11-21T03').status, 'gap');
  assert.equal(byHour.get('2026-11-21T04').status, 'gap');
  assert.equal(byHour.get('2026-11-21T00').status, 'provisional');
  assert.equal(byHour.get('2026-11-21T00').source, 'realtime');
  assert.deepEqual(state.uncertain.gaps, ['2026-11-21T03', '2026-11-21T04']);
});

test('归档补录：标明缺口补齐与替换范围，确认值覆盖快速读数', () => {
  const store = new TideStore();
  store.ingest('realtime', demo.realtimeBatch());
  const result = store.ingest('archive', demo.archiveBatch());

  const impact = result.impact['prefer-fast'];
  const kinds = new Map(impact.map((i) => [i.hour, i.kind]));
  assert.equal(kinds.get('2026-11-21T03'), 'filled', '03 时应为缺口补齐');
  assert.equal(kinds.get('2026-11-21T04'), 'filled', '04 时应为缺口补齐');
  assert.equal(kinds.get('2026-11-21T02'), 'replaced', '02 时应为来源替换');
  assert.equal(kinds.get('2026-11-21T05'), 'replaced', '05 时应为来源替换');

  const state = store.state('prefer-fast');
  const byHour = new Map(state.hours.map((h) => [h.hour, h]));
  const h02 = byHour.get('2026-11-21T02');
  assert.equal(h02.source, 'archive');
  assert.equal(h02.status, 'confirmed');
  assert.equal(h02.height, h02.archiveMean, '发布值应为归档确认值');
  assert.ok(h02.divergence > 0, '应给出快速读数与确认值的偏差');
  assert.deepEqual(state.uncertain.gaps, [], '缺口应已全部补齐');
});

test('只给确认值：归档到达前全部不发布，到达后只确认 02–05 时', () => {
  const store = new TideStore();
  store.ingest('realtime', demo.realtimeBatch());
  let state = store.state('confirmed-only');
  assert.ok(state.hours.every((h) => h.height === null), '无归档时不发布任何高度');
  assert.equal(state.hours.filter((h) => h.status === 'withheld').length, 10, '有快速读数的小时暂不发布');
  assert.equal(state.hours.filter((h) => h.status === 'gap').length, 2, '03、04 时为缺口');

  store.ingest('archive', demo.archiveBatch());
  state = store.state('confirmed-only');
  const byHour = new Map(state.hours.map((h) => [h.hour, h]));
  assert.equal(byHour.get('2026-11-21T02').status, 'confirmed');
  assert.equal(byHour.get('2026-11-21T05').status, 'confirmed');
  assert.equal(byHour.get('2026-11-21T00').status, 'withheld', '00 时仍只有未确认的快速读数');
  assert.equal(state.uncertain.withheld.length, 8, '00、01、06–11 时仍未确认');
});

// ---------- 推送端 ----------

test('推送端只对受影响的小时重发', () => {
  const store = new TideStore();
  const r1 = store.ingest('realtime', demo.realtimeBatch());
  assert.equal(r1.pushed['prefer-fast'].hours.length, 10, '首次接收应推送全部 10 个有数据的小时');
  assert.equal(r1.pushed['confirmed-only'], null, '只给确认值模式下实时数据不产生推送');

  const r2 = store.ingest('archive', demo.archiveBatch());
  assert.deepEqual(
    r2.pushed['prefer-fast'].hours.map((h) => h.hour),
    ['2026-11-21T02', '2026-11-21T03', '2026-11-21T04', '2026-11-21T05'],
    '归档补录只应重发受影响的 02–05 时'
  );
  assert.deepEqual(
    r2.pushed['confirmed-only'].hours.map((h) => h.hour),
    ['2026-11-21T02', '2026-11-21T03', '2026-11-21T04', '2026-11-21T05']
  );
});

test('重复接收相同数据不产生新的推送', () => {
  const store = new TideStore();
  store.ingest('realtime', demo.realtimeBatch());
  store.ingest('archive', demo.archiveBatch());
  const pushesBefore = store.pushes.length;
  const again = store.ingest('archive', demo.archiveBatch());
  assert.equal(again.receipt.unchanged, 24);
  assert.equal(again.receipt.added, 0);
  assert.equal(again.pushed['prefer-fast'], null);
  assert.equal(store.pushes.length, pushesBefore, '不应新增推送记录');
});

test('小时交接记录按顺序记录接收与推送', () => {
  const store = new TideStore();
  store.ingest('realtime', demo.realtimeBatch());
  store.ingest('archive', demo.archiveBatch());
  const types = store.events.map((e) => e.type);
  assert.deepEqual(types, ['receive', 'push', 'receive', 'push', 'push']);
  const seqs = store.events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), '序号应递增');
  assert.match(store.events[0].summary, /快速采样 60 条/);
  assert.match(store.events[3].summary, /重发 4 个小时/);
});

// ---------- 异常输入（核心逻辑） ----------

test('异常：未知来源被拒绝', () => {
  const store = new TideStore();
  assert.throws(() => store.ingest('satellite', [{ time: '2026-11-21T00:00:00Z', height: 1 }]), IngestError);
});

test('异常：空记录数组被拒绝', () => {
  const store = new TideStore();
  assert.throws(() => store.ingest('realtime', []), /非空数组/);
  assert.throws(() => store.ingest('realtime', 'not-an-array'), /非空数组/);
});

test('异常：时间无法解析的记录被拒绝，且不落库', () => {
  const store = new TideStore();
  assert.throws(
    () => store.ingest('realtime', [{ time: 'not-a-time', height: 1.2 }]),
    /time 无法解析/
  );
  assert.equal(store.state('prefer-fast').hours.length, 0, '失败批次不应留下任何数据');
});

test('异常：高度不是有限数值被拒绝', () => {
  const store = new TideStore();
  assert.throws(() => store.ingest('realtime', [{ time: '2026-11-21T00:00:00Z', height: 'high' }]), /height/);
  assert.throws(() => store.ingest('realtime', [{ time: '2026-11-21T00:00:00Z', height: NaN }]), /height/);
  assert.throws(() => store.ingest('realtime', [{ time: '2026-11-21T00:00:00Z' }]), /height/);
});

test('异常：未知拼接方式被拒绝', () => {
  const store = new TideStore();
  assert.throws(() => store.state('fastest-wins'), /未知拼接方式/);
});

// ---------- HTTP 层 ----------

async function withServer(fn) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('HTTP：页面可访问且业务结果区带 data-evidence-result', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /data-evidence-result/);
    assert.match(html, /接收实时潮位/);
    assert.match(html, /补一段归档测量/);
    assert.match(html, /查看小时交接记录/);
  });
});

test('HTTP：完整演示流程（接收实时 → 补归档 → 查交接）', async () => {
  await withServer(async (base) => {
    let res = await fetch(`${base}/api/ingest/realtime`, { method: 'POST' });
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.receipt.count, 60);

    res = await fetch(`${base}/api/ingest/archive`, { method: 'POST' });
    assert.equal(res.status, 200);
    body = await res.json();
    assert.equal(body.pushed['prefer-fast'].hours.length, 4);
    assert.match(body.summary['prefer-fast'], /补齐缺口/);
    assert.match(body.summary['prefer-fast'], /替换/);

    res = await fetch(`${base}/api/state?mode=confirmed-only`);
    assert.equal(res.status, 200);
    body = await res.json();
    assert.equal(body.events.length, 5);
    const confirmed = body.hours.filter((h) => h.status === 'confirmed');
    assert.equal(confirmed.length, 4);
  });
});

test('HTTP：重置后可以重新演示', async () => {
  await withServer(async (base) => {
    await fetch(`${base}/api/ingest/realtime`, { method: 'POST' });
    let res = await fetch(`${base}/api/reset`, { method: 'POST' });
    assert.equal(res.status, 200);
    res = await fetch(`${base}/api/state`);
    const body = await res.json();
    assert.equal(body.hours.length, 0);
    assert.equal(body.events.length, 0);
  });
});

test('HTTP 异常：未知路径 404，方法不允许 405', async () => {
  await withServer(async (base) => {
    let res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
    res = await fetch(`${base}/api/ingest/realtime`);
    assert.equal(res.status, 405);
    assert.match(res.headers.get('allow'), /POST/);
  });
});

test('HTTP 异常：非法 JSON、未知来源、坏记录都返回 400', async () => {
  await withServer(async (base) => {
    let res = await fetch(`${base}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{broken',
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /JSON/);

    res = await fetch(`${base}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'moon', records: [{ time: '2026-11-21T00:00:00Z', height: 1 }] }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /未知来源/);

    res = await fetch(`${base}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'realtime', records: [{ time: '2026-11-21T00:00:00Z', height: 'x' }] }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /height/);

    res = await fetch(`${base}/api/state?mode=guess`);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /未知拼接方式/);
  });
});
