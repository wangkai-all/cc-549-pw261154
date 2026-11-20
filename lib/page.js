'use strict';

// 演示页面：三个真实功能按钮 + 拼接方式切换。
// 业务结果区带 data-evidence-result 属性，便于核对操作前后的内容。

function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>港口潮位采集演示</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 2rem auto; max-width: 960px; padding: 0 1rem; line-height: 1.6; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-top: 1.8rem; }
  .controls { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: 1rem 0; }
  button { padding: .45rem .9rem; border: 1px solid #888; border-radius: 6px; background: #1f6feb; color: #fff; cursor: pointer; font-size: .95rem; }
  button.secondary { background: transparent; color: inherit; }
  button:hover { filter: brightness(1.1); }
  select { padding: .4rem; font-size: .95rem; }
  #result { border: 1px solid #888; border-radius: 8px; padding: .8rem 1rem; margin: 1rem 0; white-space: pre-wrap; font-size: .95rem; background: rgba(127,127,127,.08); }
  table { border-collapse: collapse; width: 100%; font-size: .88rem; }
  th, td { border: 1px solid #8885; padding: .3rem .5rem; text-align: left; }
  tr.confirmed td { background: rgba(46,160,67,.12); }
  tr.provisional td { background: rgba(187,128,9,.12); }
  tr.withheld td { background: rgba(130,80,190,.12); }
  tr.gap td { background: rgba(207,34,46,.14); }
  ol#events { font-size: .88rem; padding-left: 1.4rem; }
  ol#events li { margin-bottom: .25rem; }
  .src { display: flex; gap: 1.5rem; flex-wrap: wrap; font-size: .9rem; }
  .src div { border: 1px solid #8885; border-radius: 8px; padding: .5rem .9rem; }
  .muted { opacity: .75; font-size: .85rem; }
</style>
</head>
<body>
<h1>港口潮位采集演示（虚构数据，可重复生成）</h1>
<p class="muted">两个本地来源：<b>快速采样</b>（实时到达，暂定值，03–04 时模拟缺测）与<b>归档文件</b>（晚到，02–05 时确认值）。
接收端分别保存各自时间戳；拼接端标明缺口与替换范围；推送端只对受影响的小时重发。</p>

<div class="controls">
  <button id="btnRealtime">接收实时潮位</button>
  <button id="btnArchive">补一段归档测量</button>
  <button id="btnHandover">查看小时交接记录</button>
  <label>拼接方式：
    <select id="mode">
      <option value="prefer-fast">先保快速读数</option>
      <option value="confirmed-only">只给确认值</option>
    </select>
  </label>
  <button id="btnReset" class="secondary">重置演示</button>
</div>

<section id="result" data-evidence-result aria-live="polite">尚未操作。点击上方按钮接收数据或查看交接记录。</section>

<h2>来源接收情况（各自时间戳独立保存）</h2>
<div class="src" id="sources"><span class="muted">加载中…</span></div>

<h2>逐小时拼接视图（谁补了哪段）</h2>
<table id="hours">
  <thead><tr>
    <th>小时</th><th>快速采样</th><th>归档文件</th><th>发布值来源</th><th>发布高度(m)</th><th>状态</th><th>说明</th>
  </tr></thead>
  <tbody><tr><td colspan="7" class="muted">加载中…</td></tr></tbody>
</table>
<p id="uncertain" class="muted"></p>

<h2>小时交接记录</h2>
<ol id="events"><li class="muted">加载中…</li></ol>

<script>
(function () {
  var resultEl = document.getElementById('result');
  var modeEl = document.getElementById('mode');

  function api(path, method) {
    return fetch(path, { method: method || 'GET' }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
        return body;
      });
    });
  }

  function currentMode() { return modeEl.value; }

  function fmtNum(x) { return x === null || x === undefined ? '—' : String(x); }

  function renderState(state) {
    var src = state.sources;
    document.getElementById('sources').innerHTML =
      '<div><b>快速采样</b>：' + src.realtime.count + ' 条，' +
      (src.realtime.firstTime || '—') + ' – ' + (src.realtime.lastTime || '—') +
      '<br><span class="muted">最近接收：' + (src.realtime.lastReceivedAt || '—') + '</span></div>' +
      '<div><b>归档文件</b>：' + src.archive.count + ' 条，' +
      (src.archive.firstTime || '—') + ' – ' + (src.archive.lastTime || '—') +
      '<br><span class="muted">最近接收：' + (src.archive.lastReceivedAt || '—') + '</span></div>';

    var tbody = document.querySelector('#hours tbody');
    if (!state.hours.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">暂无数据</td></tr>';
    } else {
      tbody.innerHTML = state.hours.map(function (h) {
        var note = h.status === 'gap' ? '两个来源都缺，仍不确定'
          : h.status === 'provisional' ? '暂定值，等归档确认'
          : h.status === 'withheld' ? '有快速读数但未确认，暂不发布'
          : (h.divergence !== null && h.realtimeCount > 0 ? '归档确认，修正偏差 ' + h.divergence + ' m' : '归档确认');
        return '<tr class="' + h.status + '"><td>' + h.label + '</td>' +
          '<td>' + (h.realtimeCount ? h.realtimeCount + ' 条 / ' + fmtNum(h.realtimeMean) + ' m' : '—') + '</td>' +
          '<td>' + (h.archiveCount ? h.archiveCount + ' 条 / ' + fmtNum(h.archiveMean) + ' m' : '—') + '</td>' +
          '<td>' + h.sourceLabel + '</td><td>' + fmtNum(h.height) + '</td>' +
          '<td>' + h.statusLabel + '</td><td>' + note + '</td></tr>';
      }).join('');
    }
    document.getElementById('uncertain').textContent = '仍不确定：' + state.uncertain.text;

    var ev = document.getElementById('events');
    if (!state.events.length) {
      ev.innerHTML = '<li class="muted">暂无交接记录</li>';
    } else {
      ev.innerHTML = state.events.map(function (e) {
        return '<li>#' + e.seq + ' [' + e.at + '] ' + e.summary + '</li>';
      }).join('');
    }
  }

  function refresh() {
    return api('/api/state?mode=' + encodeURIComponent(currentMode())).then(renderState);
  }

  function showResult(text) { resultEl.textContent = text; }

  document.getElementById('btnRealtime').addEventListener('click', function () {
    api('/api/ingest/realtime', 'POST').then(function (r) {
      return refresh().then(function (state) {
        showResult(r.summary[currentMode()] + '\\n仍不确定：' + state.uncertain.text);
      });
    }).catch(function (err) { showResult('接收失败：' + err.message); });
  });

  document.getElementById('btnArchive').addEventListener('click', function () {
    api('/api/ingest/archive', 'POST').then(function (r) {
      return refresh().then(function (state) {
        showResult(r.summary[currentMode()] + '\\n仍不确定：' + state.uncertain.text);
      });
    }).catch(function (err) { showResult('补录失败：' + err.message); });
  });

  document.getElementById('btnHandover').addEventListener('click', function () {
    refresh().then(function (state) {
      var lines = state.events.map(function (e) { return '#' + e.seq + ' ' + e.summary; });
      showResult('小时交接记录（' + state.events.length + ' 条）：\\n' + (lines.join('\\n') || '暂无'));
    }).catch(function (err) { showResult('查询失败：' + err.message); });
  });

  document.getElementById('btnReset').addEventListener('click', function () {
    api('/api/reset', 'POST').then(function () {
      return refresh();
    }).then(function () { showResult('已重置为空的演示环境。'); })
      .catch(function (err) { showResult('重置失败：' + err.message); });
  });

  modeEl.addEventListener('change', function () {
    refresh().then(function (state) {
      showResult('已切换拼接方式：' + state.modeLabel + '\\n仍不确定：' + state.uncertain.text);
    });
  });

  refresh().catch(function (err) { showResult('加载失败：' + err.message); });
})();
</script>
</body>
</html>`;
}

module.exports = { renderPage };
