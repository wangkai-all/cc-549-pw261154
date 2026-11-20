'use strict';

// 可重复生成的虚构潮位记录。
// 固定基准日期 + 固定种子伪随机数，任何时候跑出来的数据完全一致。

const BASE_MS = Date.UTC(2026, 10, 21, 0, 0, 0); // 2026-11-21T00:00:00.000Z
const STEP_MIN = 10;

// mulberry32：小而确定的伪随机数发生器
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 虚构的半日潮模型（米），仅用于演示
function tideModel(hoursSinceBase) {
  return (
    2.5 +
    1.8 * Math.sin((2 * Math.PI * (hoursSinceBase - 3)) / 12.4) +
    0.4 * Math.sin((2 * Math.PI * hoursSinceBase) / 6.1)
  );
}

function isoUTC(ms) {
  return new Date(ms).toISOString();
}

// 快速采样源：00:00–11:59 每 10 分钟一条。
// 模拟采集故障：03:00–04:59 的样本永远不会到达（形成缺口）。
// 读数带噪声和 +0.02m 偏差，属于未确认的暂定值。
function realtimeBatch() {
  const rand = mulberry32(20261121);
  const out = [];
  for (let m = 0; m < 12 * 60; m += STEP_MIN) {
    const hour = Math.floor(m / 60);
    if (hour === 3 || hour === 4) continue; // 缺测窗口
    const noise = (rand() - 0.5) * 0.1;
    const height = Math.round((tideModel(m / 60) + 0.02 + noise) * 1000) / 1000;
    out.push({ time: isoUTC(BASE_MS + m * 60000), height });
  }
  return out;
}

// 归档文件源：晚到，覆盖 02:00–05:59，每 10 分钟一条。
// 经过核定的确认值（无噪声，保留两位小数）。
function archiveBatch() {
  const out = [];
  for (let m = 2 * 60; m < 6 * 60; m += STEP_MIN) {
    const height = Math.round(tideModel(m / 60) * 100) / 100;
    out.push({ time: isoUTC(BASE_MS + m * 60000), height });
  }
  return out;
}

module.exports = { realtimeBatch, archiveBatch, BASE_MS };
