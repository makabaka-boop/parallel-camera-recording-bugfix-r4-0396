/**
 * app.js — 页面胶水层：设备选择、双路预览、录制控制、片段/缺口渲染、
 * 本机下载导出与 ObjectURL 撤销。所有数据只在浏览器内，绝无网络上传。
 */
import { ParallelRecorder } from './parallel-recorder.js';
import { Recorder } from './recorder-core.js';

const $ = (id) => document.getElementById(id);

const els = {
  primarySelect: $('primarySelect'),
  backupSelect: $('backupSelect'),
  audioToggle: $('audioToggle'),
  refreshDevices: $('refreshDevices'),
  permHint: $('permHint'),
  primaryVideo: $('primaryVideo'),
  backupVideo: $('backupVideo'),
  primaryName: $('primaryName'),
  backupName: $('backupName'),
  primaryDot: $('primaryDot'),
  backupDot: $('backupDot'),
  startBtn: $('startBtn'),
  switchBtn: $('switchBtn'),
  stopBtn: $('stopBtn'),
  recordDot: $('recordDot'),
  statusText: $('statusText'),
  heldInfo: $('heldInfo'),
  eventLog: $('eventLog'),
  segmentsBody: $('segmentsBody'),
  gapList: $('gapList'),
  downloadAllBtn: $('downloadAllBtn'),
  downloadManifestBtn: $('downloadManifestBtn'),
  clearAllBtn: $('clearAllBtn')
};

const MAX_HELD_BYTES = 256 * 1024 * 1024; // 页面媒体持有预算

/** @type {Recorder|null} */
let recorder = null;
/** 预览流：与录制流分开，选择设备后就可预览。 */
let previewStreams = { primary: null, backup: null };
let cachedDevices = [];

// ------------------------------------------------------------------ 工具

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

function fmtTime(isoOrMs) {
  if (isoOrMs == null) return '—';
  const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs);
  return d.toLocaleTimeString('zh-CN', { hour12: false }) +
    '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  return `${(ms / 1000).toFixed(2)} s`;
}

function log(msg, cls = '') {
  const line = document.createElement('div');
  line.className = `line ${cls}`;
  line.textContent = `[${fmtTime(Date.now())}] ${msg}`;
  els.eventLog.appendChild(line);
  els.eventLog.scrollTop = els.eventLog.scrollHeight;
}

// ------------------------------------------------------------------ 设备

async function listCameras() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput');
  } catch (err) {
    log(`枚举设备失败: ${err.message}`, 'ev-err');
    return [];
  }
}

function fillSelect(select, devices, selectedId) {
  const prev = selectedId || select.value;
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = devices.length ? '（请选择）' : '未检测到摄像头';
  select.appendChild(placeholder);
  for (const d of devices) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `摄像头 ${select.options.length}`;
    select.appendChild(opt);
  }
  if (prev && devices.some((d) => d.deviceId === prev)) select.value = prev;
}

async function refreshDevices() {
  cachedDevices = await listCameras();
  const p = els.primarySelect.value;
  const b = els.backupSelect.value;
  fillSelect(els.primarySelect, cachedDevices, p);
  fillSelect(els.backupSelect, cachedDevices, b);
  recorder?.setDeviceList(cachedDevices);
  const noLabels = cachedDevices.length && cachedDevices.every((d) => !d.label);
  els.permHint.hidden = !noLabels;
  if (noLabels) {
    els.permHint.textContent = '设备名为空：点击“开始录制”或选择设备授予摄像头权限后，将显示真实名称。';
  }
}

async function startPreview(role) {
  const select = role === 'primary' ? els.primarySelect : els.backupSelect;
  const video = role === 'primary' ? els.primaryVideo : els.backupVideo;
  const nameEl = role === 'primary' ? els.primaryName : els.backupName;
  const dot = role === 'primary' ? els.primaryDot : els.backupDot;

  const id = select.value;
  stopPreview(role);
  if (!id) {
    video.srcObject = null;
    nameEl.textContent = '未选择';
    dot.className = 'dot';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: id } },
      audio: false
    });
    // 等待期间用户可能改选了别的设备：迟到流立即释放。
    if (select.value !== id) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    previewStreams[role] = stream;
    video.srcObject = stream;
    nameEl.textContent = select.selectedOptions[0]?.textContent || id;
    dot.className = 'dot live';
  } catch (err) {
    nameEl.textContent = `不可用（${err.name || err.message}）`;
    dot.className = 'dot off';
    log(`${role === 'primary' ? '主' : '备'}设备预览失败: ${err.name}`, 'ev-err');
  }
}

function stopPreview(role) {
  const s = previewStreams[role];
  if (s) {
    s.getTracks().forEach((t) => t.stop());
    previewStreams[role] = null;
  }
}

function stopAllPreviews() {
  stopPreview('primary');
  stopPreview('backup');
}

// ------------------------------------------------------------------ 录制控制

function ensureRecorder() {
  if (recorder) return recorder;
  const primaryId = els.primarySelect.value;
  const backupId = els.backupSelect.value || primaryId;
  const RecorderType = $('parallelToggle').checked ? ParallelRecorder : Recorder;
  recorder = new RecorderType({
    mediaDevices: navigator.mediaDevices,
    MediaRecorder: window.MediaRecorder,
    urlObj: URL,
    devices: { primaryId, backupId },
    maxHeldBytes: MAX_HELD_BYTES,
    timeslice: 1000,
    audio: els.audioToggle.checked
  });
  recorder.setDeviceList(cachedDevices);
  wireRecorderEvents(recorder);
  // 调试 / 自动化钩子：页面正常使用时无人读取，不产生任何网络行为。
  window.__recorder = recorder;
  return recorder;
}

function wireRecorderEvents(rec) {
  rec.addEventListener('segmentstart', ({ detail }) => {
    const s = detail.segment;
    log(`▶ 片段 #${s.index} 开始：${s.role === 'primary' ? '主' : '备'}设备 ${s.label}`, 'ev-ok');
    setStatus(`录制中（片段 #${s.index} · ${s.role === 'primary' ? '主' : '备'}）`);
    render();
  });
  rec.addEventListener('segmentsealing', ({ detail }) => {
    log(`■ 片段 #${detail.segment.index} 结束封口，原因：${detail.reason}`, 'ev-warn');
    render();
  });
  rec.addEventListener('segmentsealed', ({ detail }) => {
    const s = detail.segment;
    log(`✔ 片段 #${s.index} 已保存（${fmtBytes(s.bytes)}）`, 'ev-ok');
    render();
  });
  rec.addEventListener('forcedseal', ({ detail }) => {
    log(`⚠ 片段 #${detail.segment.index} onstop 超时，已强制封口`, 'ev-warn');
  });
  rec.addEventListener('laneended',()=>{setStatus(rec.running?'另一摄像头继续录制':'两路均已结束');render();});
  rec.addEventListener('failoverfailed', ({ detail }) => {
    log(`✖ ${detail.reason} 后无可用设备，录制在缺口处终止`, 'ev-err');
    setStatus('已停止（无可用设备，存在未闭合缺口）', true);
  });
  rec.addEventListener('acquireerror', ({ detail }) => {
    log(`✖ 无法打开设备 ${detail.deviceId}：${detail.error}（触发于 ${detail.trigger}）`, 'ev-err');
  });
  rec.addEventListener('switchfailed', ({ detail }) => {
    log(`⚠ 切换目标不可用（${detail.error}），尝试另一台`, 'ev-warn');
  });
  rec.addEventListener('recordererror', ({ detail }) => {
    log(`✖ MediaRecorder 错误：${detail.error}`, 'ev-err');
  });
  rec.addEventListener('quotaexceeded', ({ detail }) => {
    log(`✖ 达到媒体持有上限 ${fmtBytes(detail.maxHeldBytes)}，自动停止。请下载或清理后再录。`, 'ev-err');
  });
  rec.addEventListener('deviceschanged', () => {
    refreshDevices();
    log('检测到设备热插拔，已刷新设备列表', 'ev-warn');
  });
  rec.addEventListener('settled', () => {
    log('所有片段已落定（无待写数据）', 'ev-ok');
    updateButtons(false);
  });
}

function setStatus(text, isError = false) {
  els.statusText.textContent = text;
  els.statusText.classList.toggle('ev-err', isError);
}

async function onStart() {
  const primaryId = els.primarySelect.value;
  if (!primaryId) {
    log('请先选择主摄像头', 'ev-err');
    return;
  }
  if (recorder?.running) return;
  // 已有片段时，开始新会话前必须先 dispose：撤销旧 URL、释放旧轨道。
  if (recorder && recorder.segments.length) {
    await recorder.dispose();
    recorder = null;
  }
  const rec = ensureRecorder();
  updateHeld(rec);
  els.startBtn.disabled = true;
  els.stopBtn.disabled = false;
  els.switchBtn.disabled = false;
  els.recordDot.classList.add('rec');
  try {
    await rec.start('primary');
    await refreshDevices(); // 授权后拿到真实 label
    recorder.setDeviceList(cachedDevices);
    render();
  } catch (err) {
    log(`开始失败: ${err.message || err.name}`, 'ev-err');
    els.startBtn.disabled = false;
    els.stopBtn.disabled = true;
    els.switchBtn.disabled = true;
    els.recordDot.classList.remove('rec');
  }
}

async function onSwitch() {
  if (!recorder?.running) return;
  const currentlyPrimary = recorder.activeRole === 'primary';
  els.switchBtn.disabled = true;
  try {
    if(recorder instanceof ParallelRecorder) {
      const role=$('replaceRole').value;
      await recorder.replace(role,role==='primary'?els.primarySelect.value:els.backupSelect.value);
    } else await recorder.switchTo(currentlyPrimary ? 'backup' : 'primary');
    render();
  } catch (err) {
    log(`切换失败: ${err.message}`, 'ev-err');
  } finally {
    els.switchBtn.disabled = false;
  }
}

async function onStop() {
  if (!recorder) return;
  els.stopBtn.disabled = true;
  els.switchBtn.disabled = true;
  setStatus('正在停止，等待最后一块数据归属原片段…');
  await recorder.stop();
  await recorder.whenSettled();
  els.recordDot.classList.remove('rec');
  setStatus('已停止（分段保存，未上传任何媒体）');
  els.startBtn.disabled = false;
  render();
}

// ------------------------------------------------------------------ 渲染

function updateButtons(running) {
  els.startBtn.disabled = running;
  els.stopBtn.disabled = !running;
  els.switchBtn.disabled = !running;
  if (!running) els.recordDot.classList.remove('rec');
}

function updateHeld(rec = recorder) {
  if (!rec) {
    els.heldInfo.textContent = `持有媒体 0 B / 配额 ${fmtBytes(MAX_HELD_BYTES)}`;
    return;
  }
  const over = rec.heldBytes > MAX_HELD_BYTES;
  els.heldInfo.textContent = `持有媒体 ${fmtBytes(rec.heldBytes)} / 配额 ${fmtBytes(MAX_HELD_BYTES)}`;
  els.heldInfo.style.color = over ? 'var(--danger)' : '';
}

const REASON_TEXT = {
  start: '开始',
  'user-stop': '用户停止',
  'manual-switch': '手动切换',
  disconnect: '设备断开',
  ended: '轨道结束(设备拔出)',
  mute: '轨道静音',
  permission: '摄像头权限失效',
  'recorder-error': '录制器错误',
  'quota-limit': '达到持有上限',
  'stop-timeout': 'onstop 超时',
  dispose: '页面释放'
};

function render() {
  if (!recorder) {
    els.segmentsBody.innerHTML = '<tr class="empty"><td colspan="9">尚无片段</td></tr>';
    els.gapList.innerHTML = '<li class="empty">无缺口</li>';
    els.downloadAllBtn.disabled = true;
    els.downloadManifestBtn.disabled = true;
    els.clearAllBtn.disabled = true;
    updateHeld(null);
    return;
  }

  const rec = recorder;
  els.segmentsBody.innerHTML = '';
  const live = rec.segments.filter((s) => !s.released);
  for (const s of rec.segments) {
    const tr = document.createElement('tr');
    const stateText = {
      recording: '录制中', sealing: '封口中', sealed: '已保存', error: '错误'
    }[s.state];
    tr.innerHTML = `
      <td>#${s.index}<span class="mini seg-state-${s.state}">${stateText}</span></td>
      <td>${s.label || s.deviceId}<span class="mini">${s.deviceId.slice(0, 12)}…</span></td>
      <td>${s.role === 'primary' ? '主' : '备'}</td>
      <td>${fmtTime(s.startedAt)}</td>
      <td>${fmtTime(s.endedAt)}</td>
      <td>${fmtDuration(s.endPerf ? s.endPerf - s.startPerf : null)}</td>
      <td>${s.released ? '已释放' : fmtBytes(s.bytes)}</td>
      <td>${s.reason ? REASON_TEXT[s.reason] || s.reason : '—'}</td>
      <td class="seg-actions"></td>`;
    const actions = tr.querySelector('.seg-actions');
    if (s.url && !s.released) {
      const dl = document.createElement('button');
      dl.textContent = '下载本段';
      dl.onclick = () => downloadBlob(s.url, segmentFileName(rec, s));
      actions.appendChild(dl);
      const rel = document.createElement('button');
      rel.textContent = '释放';
      rel.title = '撤销 ObjectURL 并从内存清掉该段（先下载！）';
      rel.onclick = async () => {
        await rec.releaseSegment(s.index);
        render();
      };
      actions.appendChild(rel);
    }
    els.segmentsBody.appendChild(tr);
  }
  if (!rec.segments.length) {
    els.segmentsBody.innerHTML = '<tr class="empty"><td colspan="9">尚无片段</td></tr>';
  }

  // 缺口清单
  els.gapList.innerHTML = '';
  if (!rec.gaps.length) {
    els.gapList.innerHTML = '<li class="empty">无缺口</li>';
  }
  for (const g of rec.gaps) {
    const li = document.createElement('li');
    const open = g.to == null;
    li.className = open ? 'open' : '';
    const reasonText = {
      disconnect: '设备断开',
      mute: '轨道静音',
      permission: '权限失效',
      switch: '手动切换',
      'failover-failed': '接管失败（无可用备机）'
    }[g.reason] || g.reason;
    li.textContent =
      `片段 #${g.afterSegment} 之后：${fmtTime(g.from)} → ` +
      `${open ? '仍未恢复' : fmtTime(g.to)}` +
      `（${open ? '缺口未闭合' : fmtDuration(g.to - g.from)}，原因：${reasonText}）`;
    els.gapList.appendChild(li);
  }

  const hasSealed = rec.segments.some((s) => s.state === 'sealed' && !s.released);
  els.downloadAllBtn.disabled = !hasSealed;
  els.downloadManifestBtn.disabled = !rec.segments.length;
  els.clearAllBtn.disabled = rec.running || !rec.segments.length;
  updateButtons(rec.running);
  updateHeld(rec);

  // 切换按钮文案反映下一台
  if (rec.running) {
    els.switchBtn.textContent =
      rec.activeRole === 'primary' ? '手动切换到备机' : '手动切回主机';
  } else {
    els.switchBtn.textContent = '手动切换到备机';
  }
}

function segmentFileName(rec, s) {
  const ext = (rec.mimeType || 'video/webm').includes('mp4') ? 'mp4' : 'webm';
  return `segment-${String(s.index).padStart(3, '0')}.${ext}`;
}

// ------------------------------------------------------------------ 导出（纯本机）

function downloadBlob(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 注意：段自身的 URL 仍保留用于表格内操作，由“释放/清空”统一撤销。
}

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], {
    type: 'application/json'
  });
  const url = URL.createObjectURL(blob);
  downloadBlob(url, filename);
  // 清单是临时 URL，下载发起后立即撤销。
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function onDownloadAll() {
  const rec = recorder;
  if (!rec) return;
  for (const s of rec.segments) {
    if (s.state === 'sealed' && s.url && !s.released) {
      downloadBlob(s.url, segmentFileName(rec, s));
      await new Promise((r) => setTimeout(r, 250)); // 避免浏览器合并下载拦截
    }
  }
  downloadJson(rec.buildManifest(), 'recording-manifest.json');
  log('已在本机触发全部片段与清单下载，未发生任何上传', 'ev-ok');
}

function onDownloadManifest() {
  if (!recorder) return;
  downloadJson(recorder.buildManifest(), 'recording-manifest.json');
}

async function onClearAll() {
  if (!recorder) return;
  if (recorder.running) return;
  await recorder.dispose();
  recorder = null;
  render();
  log('已清空全部片段并撤销所有 ObjectURL', 'ev-ok');
}

// ------------------------------------------------------------------ 事件绑定

els.refreshDevices.addEventListener('click', async () => {
  await refreshDevices();
});
els.primarySelect.addEventListener('change', () => startPreview('primary'));
els.backupSelect.addEventListener('change', () => startPreview('backup'));
els.startBtn.addEventListener('click', onStart);
els.switchBtn.addEventListener('click', onSwitch);
els.stopBtn.addEventListener('click', onStop);
els.downloadAllBtn.addEventListener('click', onDownloadAll);
els.downloadManifestBtn.addEventListener('click', onDownloadManifest);
els.clearAllBtn.addEventListener('click', onClearAll);

navigator.mediaDevices.addEventListener?.('devicechange', () => {
  // 核心 recorder 自己也监听；这里负责刷新选择器与预览。
  refreshDevices();
});

window.addEventListener('beforeunload', () => {
  // 离开页面时停止所有轨道（录制器 URL 随浏览上下文一起回收，无需再 revoke）。
  stopAllPreviews();
  if (recorder?.running) {
    recorder.stop();
  }
});

// 初始化
(async function init() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('当前环境不支持 getUserMedia（需要 HTTPS 或 localhost）', true);
    log('getUserMedia 不可用', 'ev-err');
    return;
  }
  await refreshDevices();
  // 默认主选第一个，备选第二个（若有）。
  if (cachedDevices[0]) els.primarySelect.value = cachedDevices[0].deviceId;
  if (cachedDevices[1]) els.backupSelect.value = cachedDevices[1].deviceId;
  render();
})();
