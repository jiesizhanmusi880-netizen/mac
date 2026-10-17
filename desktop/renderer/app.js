'use strict';

/* ================= 基础 ================= */

let API = 'http://127.0.0.1:8787';   // 打包运行时由主进程告知实际端口（见 init 开头）
const el = (id) => document.getElementById(id);
const stageFrame = el('stageView');
const audio = el('audioEl');

let project = null;
let cues = [];
let playing = false;
let pollingTimer = null;
let wavePeaks = null;
let waveRms = null;
let lastWaveRatio = -1;
let resizeTimer = null;
let pxPerSecond = 90;          // 时间轴缩放
let selectedMediaIds = [];     // 当前选中的素材片段 id（有序，最后一个是“主选中”；支持框选多选）
let marquee = null;            // 素材轨框选会话
let lastMarqueeAt = -1e9;      // 上次框选结束时间（用于吞掉尾随的 click）
let clipboardMedia = [];       // Ctrl+C 复制的素材快照（fileName + 裁剪区间）
let clipboardProjectId = null; // 复制来源工程（副本仅支持在同一工程内粘贴）
let pasteBusy = false;         // 粘贴进行中（防止连按重复粘贴）
let selectedCueIndexes = [];   // 当前选中的歌词行索引（有序；与素材选中互斥）
let clipboardCues = [];        // Ctrl+C 复制的歌词行快照
let lastSplitCut = null;       // 最近一次分割的切点 { time, at }（用于接缝闪光）
let hoverSplitTime = null;     // 光标在时间轴上的时间（秒）：分割优先以光标处为切点
let ctrlHeld = false;          // Ctrl / Cmd 是否按住（决定切点预览线显示）
let hoverTrack = null;         // 光标所在轨道：'media' | 'audio' | null（决定 Ctrl+B 分素材还是分音频）
let audioSegments = [];        // 音频分段 [{ key, start, end }]（本地存档，不进工程文件）
let selectedAudioSeg = null;   // 选中音频段的 key
let audioSegProjectId = null;  // audioSegments 所属工程
let audioSegBackup = null;     // 删除音频段前的分段快照（供撤销还原）
let lastAudioCut = null;       // 最近一次音频分割 { time, at }（接缝闪光）
let undoStack = [];            // 时间轴撤销栈（Ctrl+Z）：快照 = 素材片段布局 + 音频分段
let undoStackProjectId = null; // 栈所属工程（切换工程自动清空）
const UNDO_LIMIT = 40;         // 撤销栈上限
let audioCutWaveBackup = null; // 删除音频段时保存的波形 bins（撤销时插回，省去重建波形）
let audioBusy = false;         // 音频物理处理进行中（裁剪 / 撤销期间防重复触发）
let cueOffsetAccum = 0;        // 口型校正：字幕整体偏移累计（秒，未保存）

/* 素材片段「分帧裁剪」参数：1 帧 = 1/30 秒，所有拖动与微调都对齐到帧 */
const FRAME_RATE = 30;
const FRAME_SEC = 1 / FRAME_RATE;
const MIN_CLIP_SEC = FRAME_SEC;       // 片段最短 1 帧
const DEFAULT_CLIP_SEC = 4;           // 已冻结布局下新素材的默认时长
const SNAP_PX = 9;                    // 磁吸触发距离（像素）
const DRAG_THRESHOLD = 3;             // 拖动判定阈值（像素），小于该值算点击
const AUTO_SCROLL_EDGE = 46;          // 拖动到视口边缘多少像素内开始自动滚动
let snapEnabled = true;               // 磁吸开关（拖动中按住 Alt 临时关闭）
let clipLayout = {};                  // 片段键 -> { start, end, srcIn, custom, mediaId }（秒）
                                      // 未分割时片段键 = mediaId；分割出的第 2 段起用 "mediaId:xxx" 键
let layoutFrozen = false;             // 首次裁剪后把均匀布局固化成显式布局
let layoutProjectId = null;           // clipLayout 所属工程
let clipDrag = null;                  // 当前拖动会话
let lastClipDragAt = -1e9;            // 上次拖动结束时间（用于吞掉尾随的 click）
let cueSnapHitIndex = -1;             // 被磁吸点亮的文案行索引（-1 = 无，字幕轨重建时必须复位）

/*
 * 字幕模板：只保留已经实现的一套 ——「双行KTV · 成组续唱」。
 * 每屏最多两行：第一行贴左边距、逐字扫色，唱完保持已唱色；第二行贴右边距、「原位」接唱，
 * 不再把下一行挪到左上槽位；组内两行都唱完才整组切到下一组。
 * 单行句相邻两句一组；超长句自行折行时整句独占一组（仍是最多两行）。
 * 逐字扫色 + 自动折行 + 淡入淡出，由 stage/ktv-stage.html 统一渲染；
 * 其余未实现的模板（毛笔重影 / 语义重墨 / 卡点闪烁 …）已全部移除。
 * 流程：先识别字幕 → 再挑选并应用字幕模板。
 */
const SUBTITLE_TEMPLATES = [
  {
    id: 'ktv-follow',
    name: '双行KTV',
    desc: '左右贴边 · 逐字扫色 · 成组续唱',
    font: '抖音美好体',
    mode: 'gradient',
    colors: ['#A900B2', '#6651D0', '#23A2EE'],
    playedSolid: '#B721FF',
    unplayed: '#FFFFFF',
    layout: { maxChars: 15, lineGap: 110, bottomMargin: 160 },
  },
];

/** 卡片预览示意：上行组内第一句（已唱完，整句渐变、偏左偏高）＋ 下行组内第二句（原位接唱中，左半渐变右半白字、偏右偏低） */
const TEMPLATE_PREVIEW_HTML =
  '<div class="tpl-preview">' +
    '<div class="tpl-preview-row up"><span class="sweep">双行</span><span class="sweep">KTV</span></div>' +
    '<div class="tpl-preview-row down"><span class="sweep">跟随</span><span class="plain">字幕</span></div>' +
  '</div>';

/** 已应用模板的记录：TemplateOptions 不保存模板 id，按工程记在本地 */
const TEMPLATE_STORE_KEY = 'ktv.appliedTemplateId';

/* ================= 工具函数 ================= */

function toast(message, kind) {
  const box = el('toast');
  if (!box) return;
  box.textContent = message;
  box.className = 'toast ' + (kind || '');
  setTimeout(() => box.classList.add('hidden'), 3200);
}

function fmtTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(1).padStart(4, '0');
}

function fmtClock(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function setProgress(ratio, message) {
  const bar = el('progressBar');
  if (bar) bar.style.width = Math.round(Math.max(0, Math.min(1, ratio)) * 100) + '%';
  if (message !== undefined) {
    const node = el('taskMessage');
    if (node) node.textContent = message;
  }
}

function setFlag(id, text, cls) {
  const node = el(id);
  if (!node) return;
  node.textContent = text;
  node.className = 'card-badge ' + (cls || '');
}

function on(id, event, handler) {
  const node = el(id);
  if (node) node.addEventListener(event, handler);
}

async function api(method, url, body) {
  const options = { method: method, headers: {} };
  if (body instanceof FormData) {
    options.body = body;
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(API + url, options);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (err) { data = text; }
  if (!res.ok) {
    throw new Error(data && data.error ? data.error : ('请求失败 ' + res.status));
  }
  return data;
}

const duration = () => (project && project.audio && project.audio.duration) || audio.duration || 0;

/* ================= 字幕模板（识别字幕 → 挑选并应用） ================= */

let recognizing = false;   // 识别任务进行中（本地标记，用于锁定模板）

/** 字幕是否已识别完成：未识别时不允许挑选 / 应用模板 */
function subtitlesReady() {
  return !!(project && project.subtitleStatus === 'READY' && cues.length);
}

function appliedTemplateId() {
  if (!project) return null;
  try {
    const all = JSON.parse(localStorage.getItem(TEMPLATE_STORE_KEY)) || {};
    return all[project.id] || null;
  } catch (err) {
    return null;
  }
}

function markAppliedTemplate(id) {
  if (!project) return;
  try {
    const all = JSON.parse(localStorage.getItem(TEMPLATE_STORE_KEY)) || {};
    if (id) all[project.id] = id;
    else delete all[project.id];
    localStorage.setItem(TEMPLATE_STORE_KEY, JSON.stringify(all));
  } catch (err) { /* 本地存储异常时忽略，不影响主流程 */ }
}

/** 步骤条 + 正在使用 + 提示文案：① 识别字幕 → ② 挑选并应用模板 */
function renderTemplateFlow() {
  const ready = subtitlesReady();
  const applied = ready && !!appliedTemplateId();
  const step1 = el('stepRecognize');
  const step2 = el('stepTemplate');
  if (step1) {
    step1.className = 'flow-step ' + (ready ? 'done' : 'active');
    const badge = step1.querySelector('i');
    if (badge) badge.textContent = ready ? '✓' : '1';
  }
  if (step2) {
    step2.className = 'flow-step ' + (applied ? 'done' : (ready ? 'active' : ''));
    const badge = step2.querySelector('i');
    if (badge) badge.textContent = applied ? '✓' : '2';
  }

  const using = el('usingTemplate');
  if (using) {
    if (!project) using.textContent = '—';
    else if (!ready) using.textContent = recognizing ? '识别中…' : '未识别';
    else using.textContent = applied ? SUBTITLE_TEMPLATES[0].name : '默认双行KTV样式';
  }

  const hint = el('templateHint');
  if (hint) {
    if (!project) hint.textContent = '请先新建工程并导入歌曲';
    else if (!project.audio) hint.textContent = '请先导入歌曲音频';
    else if (recognizing) hint.textContent = '正在识别字幕…识别完成后即可挑选并应用模板';
    else if (project.subtitleStatus === 'FAILED') hint.textContent = '字幕识别失败，请重新识别后再挑选模板';
    else if (!ready) hint.textContent = '先点左侧「一键识别双行字幕」，识别完成后即可挑选并应用模板';
    else if (applied) hint.textContent = '模板已生效：预览与导出使用同一套字幕设置';
    else hint.textContent = '字幕已就绪，点击下方模板即可应用（第 ② 步）';
  }
}

function renderTemplateGrid() {
  const grid = el('templateGrid');
  if (!grid) return;
  const ready = subtitlesReady();
  const activeId = ready ? appliedTemplateId() : null;
  grid.innerHTML = '';
  SUBTITLE_TEMPLATES.forEach((tpl) => {
    const card = document.createElement('div');
    card.className = 'tpl-card' + (ready ? '' : ' locked') + (activeId === tpl.id ? ' active' : '');
    card.title = ready ? '点击应用：' + tpl.name : '请先识别字幕';

    const thumb = document.createElement('div');
    thumb.className = 'tpl-thumb';
    thumb.innerHTML = TEMPLATE_PREVIEW_HTML;

    const name = document.createElement('div');
    name.className = 'tpl-name';
    name.textContent = tpl.name;

    const desc = document.createElement('div');
    desc.className = 'tpl-desc';
    desc.textContent = tpl.desc;

    if (activeId === tpl.id) {
      const state = document.createElement('span');
      state.className = 'tpl-state';
      state.textContent = '✓ 已应用';
      thumb.appendChild(state);
    }
    if (!ready) {
      const lock = document.createElement('span');
      lock.className = 'tpl-lock';
      lock.textContent = recognizing ? '识别中…' : '识别字幕后可应用';
      thumb.appendChild(lock);
    }

    card.appendChild(thumb);
    card.appendChild(name);
    card.appendChild(desc);
    card.onclick = () => applySubtitleTemplate(tpl);
    grid.appendChild(card);
  });
  renderTemplateFlow();
}

/** 应用字幕模板（必须先完成字幕识别） */
async function applySubtitleTemplate(tpl) {
  if (!project) {
    toast('请先新建工程', 'err');
    return;
  }
  if (!subtitlesReady()) {
    toast(recognizing ? '字幕识别中，请稍候…' : '请先识别字幕，再挑选并应用字幕模板', 'err');
    const step1 = el('stepRecognize');
    if (step1 && !recognizing) {
      step1.classList.add('nudge');
      setTimeout(() => step1.classList.remove('nudge'), 900);
    }
    return;
  }
  const template = Object.assign({}, project.template, {
    fontFamily: tpl.font,
    playedColorMode: tpl.mode,
    playedSolidColor: tpl.playedSolid,
    gradientStart: tpl.colors[0],
    gradientMiddle: tpl.colors[1],
    gradientEnd: tpl.colors[2],
    unplayedColor: tpl.unplayed,
    maxChars: tpl.layout.maxChars,
    lineGap: tpl.layout.lineGap,
    bottomMargin: tpl.layout.bottomMargin,
  });
  try {
    project = await api('PUT', '/api/projects/' + project.id + '/template', template);
    markAppliedTemplate(tpl.id);
    renderTemplateGrid();
    applyTemplateToPanel(project.template);
    pushStage();
    renderTimeline();
    updateStatusBar();
    toast('已应用字幕模板：' + tpl.name, 'ok');
  } catch (err) {
    toast('模板应用失败：' + err.message, 'err');
  }
}

/** 识别完成后切到「歌词模板」面板，引导挑选模板 */
function openTemplatePane() {
  const nav = document.querySelector('.navtab[data-view="template"]');
  if (nav) nav.click();
}

/* ================= 时间轴（标尺 / 歌词 / 素材 / 波形） ================= */

/** 让整首歌刚好铺满可视宽度（默认视图） */
function fitZoom() {
  const lanes = el('trackLanes');
  const total = duration();
  if (!lanes || total <= 0) return;
  const fit = (lanes.clientWidth - 6) / total;
  pxPerSecond = Math.max(2, Math.min(300, fit));
  const range = el('zoomRange');
  if (range) {
    range.value = Math.max(Number(range.min || 2), Math.min(Number(range.max || 300), pxPerSecond));
  }
  lanes.scrollLeft = 0;
}

function renderTimeline() {
  const total = duration();
  const lanes = el('trackLanes');
  const content = el('lanesContent');
  if (!lanes || !content) return;
  syncClipLayout();

  const viewW = Math.max(200, lanes.clientWidth);
  if (total <= 0) {
    content.style.width = '100%';
    ['ruler', 'laneSub', 'laneMedia'].forEach((id) => {
      const node = el(id);
      if (node) node.innerHTML = '';
    });
    renderAudioSegments();      // 无音频时清掉残留的分段块
    updateStatusBar();
    drawWaveform(0);
    return;
  }

  const perSec = Math.max(1, pxPerSecond);
  content.style.width = Math.max(viewW, Math.round(total * perSec)) + 'px';

  // 标尺：刻度间隔随缩放自适应
  const ruler = el('ruler');
  if (ruler) {
    ruler.innerHTML = '';
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300];
    let step = steps[steps.length - 1];
    for (const s of steps) {
      if (s * perSec >= 70) { step = s; break; }
    }
    const zh = el('zoomHint');
    if (zh) zh.textContent = step + ' 秒/格';
    for (let t = 0; t <= total + 0.0001; t += step) {
      const tick = document.createElement('div');
      tick.className = 'ruler-tick';
      tick.style.left = Math.round(t * perSec) + 'px';
      const label = document.createElement('span');
      label.textContent = fmtClock(t);
      tick.appendChild(label);
      ruler.appendChild(tick);
    }
  }

  // 歌词轨：单击选中 / 轨内空白处拖动框选多行 / 双击删除
  const laneSub = el('laneSub');
  if (laneSub) {
    laneSub.innerHTML = '';
    cueSnapHitIndex = -1;           // 歌词块全部重建：磁吸高亮缓存随之失效
    const keptCueSel = selectedCueIndexes.filter((i) => i >= 0 && i < cues.length);
    if (keptCueSel.length !== selectedCueIndexes.length) selectedCueIndexes = keptCueSel;
    cues.forEach((cue, index) => {
      const block = document.createElement('div');
      const active = selectedCueIndexes.includes(index);
      block.className = 'cue-block' + (cue.sweepMode === 'even' ? ' even' : '') + (active ? ' selected' : '');
      block.style.left = Math.round(cue.start * perSec) + 'px';
      block.style.width = Math.max(3, Math.round((cue.end - cue.start) * perSec) - 2) + 'px';
      block.textContent = cue.text || '';
      block.title = (cue.text || '') + '（单击选中 · Ctrl 追加 · 双击删除本行）';
      block.addEventListener('pointerdown', (ev) => onCuePointerDown(ev, index));
      block.ondblclick = (e) => { e.stopPropagation(); removeCue(index); };
      laneSub.appendChild(block);
    });
  }

  // 素材轨：胶片式片段（蓝标题栏 + 胶片条 + 分帧裁剪把手）
  const laneMedia = el('laneMedia');
  if (laneMedia) {
    laneMedia.innerHTML = '';
    const clips = clipList();                       // 同一素材分割后会出现多个片段
    const aliveIds = new Set(clips.map((c) => c.key));
    const keptIds = selectedMediaIds.filter((id) => aliveIds.has(id));
    if (keptIds.length !== selectedMediaIds.length) selectedMediaIds = keptIds;
    const placed = [];
    clips.forEach((item, index) => {
      const media = item.media;
      const key = item.key;
      const span = item.span;
      const length = Math.max(0, span.end - span.start);
      const segLabel = item.mediaCount > 1 ? ' · 第 ' + (item.mediaSeq + 1) + ' / ' + item.mediaCount + ' 段' : '';

      const clip = document.createElement('div');
      clip.className = 'clip' + (span.custom ? ' trimmed' : '');
      clip.style.left = Math.round(span.start * perSec) + 'px';
      // 不设 28px 最小宽度：极短片段按真实宽度渲染，否则会盖住邻段、看不出分割
      clip.style.width = Math.max(3, Math.round(length * perSec) - 3) + 'px';

      // 标题栏：文件名 + 片段时长（裁剪后实时更新）
      const head = document.createElement('div');
      head.className = 'clip-head';
      head.title = media.originalName + segLabel + ' · 时间轴 ' + fmtTimecode(span.start, FRAME_RATE)
        + ' → ' + fmtTimecode(span.end, FRAME_RATE)
        + ' · 源入点 ' + fmtTimecode(span.srcIn, FRAME_RATE);
      const name = document.createElement('span');
      name.className = 'clip-name';
      name.textContent = '（' + (index + 1) + '）' + media.originalName;
      const tc = document.createElement('span');
      tc.className = 'clip-tc';
      tc.textContent = fmtTimecode(length, FRAME_RATE);
      head.appendChild(name);
      head.appendChild(tc);

      // 胶片条：图片直接用原图，视频按裁剪区间抽 4 帧平铺
      const body = document.createElement('div');
      body.className = 'clip-body';
      const strip = document.createElement('div');
      strip.className = 'clip-strip';
      if (media.kind === 'image') {
        strip.style.backgroundImage =
          "url('" + API + '/api/projects/' + project.id + '/media/files/' + media.fileName + "')";
        strip.style.backgroundSize = 'auto 100%';
      } else {
        const marks = clipThumbTimes(media, span);
        const urls = marks.map((mark) =>
          "url('" + API + '/api/projects/' + project.id + '/media/thumb/' + media.fileName
          + '?t=' + mark + '&w=240' + "')");
        strip.style.backgroundImage = urls.join(', ');
        strip.style.backgroundSize = '25% 100%';
      }

      const pick = document.createElement('span');
      pick.className = 'clip-pick';
      pick.textContent = selectedMediaIds.includes(key) ? '已选中' : '选择片段';
      pick.title = '单击片段即可选中（退格键删除）';
      pick.onclick = (e) => { e.stopPropagation(); selectClip(key); };

      const splitBtn = document.createElement('span');
      splitBtn.className = 'clip-split';
      splitBtn.textContent = '✂';
      splitBtn.title = '在播放头处切开；播放头不在本片段内时从片段中点切开（Ctrl+B）';
      splitBtn.onclick = (e) => { e.stopPropagation(); splitSelectedClip(key); };

      const del = document.createElement('span');
      del.className = 'clip-del';
      del.textContent = '✕';
      del.title = '删除该片段（素材还有其它片段时只移除这一段）';
      del.onclick = (e) => { e.stopPropagation(); removeClip(key); };

      body.appendChild(strip);
      body.appendChild(pick);
      body.appendChild(splitBtn);
      body.appendChild(del);

      // 左右裁剪把手：拖动即按帧裁剪入点 / 出点
      const edgeL = document.createElement('div');
      edgeL.className = 'clip-edge left';
      edgeL.title = '拖动裁剪入点 · 1 帧精度（拖动中按住 Alt 临时关闭磁吸）';
      const edgeR = document.createElement('div');
      edgeR.className = 'clip-edge right';
      edgeR.title = '拖动裁剪出点 · 1 帧精度（拖动中按住 Alt 临时关闭磁吸）';

      clip.dataset.mediaId = key;
      if (selectedMediaIds.includes(key)) {
        clip.classList.add('selected');
      }
      bindClipPointerDown(clip, media, key);

      clip.appendChild(head);
      clip.appendChild(body);
      clip.appendChild(edgeL);
      clip.appendChild(edgeR);
      laneMedia.appendChild(clip);
      placed.push({ span: span, node: clip, mediaId: String(media.id) });
    });

    // 重叠提示：同一条素材轨上互相压住的片段描橙边
    placed.forEach((item, i) => {
      const clash = placed.some((other, j) => j !== i
        && other.span.start < item.span.end - 1e-4
        && other.span.end > item.span.start + 1e-4);
      item.node.classList.toggle('overlap', clash);
    });

    // 分割痕迹：同一素材相邻两段精确相接时，在接缝处画一条金色亮线；
    // 刚分割出的那条会闪光一下，确保一眼看到切开的位置
    const junctionEps = FRAME_SEC * 0.5;
    placed.forEach((left, i) => {
      placed.forEach((right, j) => {
        if (i === j || left.mediaId !== right.mediaId) return;
        if (Math.abs(left.span.end - right.span.start) > junctionEps) return;
        const mark = document.createElement('div');
        mark.className = 'cut-mark';
        if (lastSplitCut
          && Math.abs(lastSplitCut.time - left.span.end) < junctionEps
          && performance.now() - lastSplitCut.at < 1500) {
          mark.classList.add('fresh');
        }
        mark.style.left = Math.max(0, Math.round(left.span.end * perSec) - 3) + 'px';
        mark.title = '分割切痕 · ' + fmtTimecode(left.span.end, FRAME_RATE);
        laneMedia.appendChild(mark);
      });
    });
  }

  // 波形片段标签（胶囊样式）
  const label = el('waveClipLabel');
  if (label) {
    if (project && project.audio) {
      const tpl = project.template || {};
      const song = tpl.nameText || project.audio.originalName;
      const singer = tpl.singerText ? ' - ' + tpl.singerText : '';
      label.textContent = '1 ♪ ' + song + singer;
      label.style.display = 'block';
    } else {
      label.style.display = 'none';
    }
  }

  renderAudioSegments();        // 音频轨分段块与切痕（随缩放重建）
  updateStatusBar();
  drawWaveform(playRatio());
}

/** 时间码格式：时:分:秒:帧（素材片段上的显示方式） */
function fmtTimecode(seconds, fps) {
  const f = Math.max(1, fps || 30);
  const value = Math.max(0, seconds || 0);
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = Math.floor(value % 60);
  const frame = Math.floor((value % 1) * f);
  const pad = (n) => String(n).padStart(2, '0');
  return pad(h) + ':' + pad(m) + ':' + pad(s) + ':' + pad(frame);
}

/** 当前工程里的素材片段列表 */
function mediaList() {
  return project && project.backgrounds ? project.backgrounds : [];
}

/** 只刷新片段高亮与胶囊文案（框选拖动中实时调用，不写全局选中状态） */
function paintClipHighlight(ids) {
  const set = new Set(ids || []);
  document.querySelectorAll('#laneMedia .clip').forEach((node) => {
    const active = set.has(node.dataset.mediaId);
    node.classList.toggle('selected', active);
    const pick = node.querySelector('.clip-pick');
    if (pick) pick.textContent = active ? '已选中' : '选择片段';
  });
}

/** 提交选中集合：去重后刷新高亮与状态栏（集合不变时不动 DOM） */
function setMediaSelection(ids) {
  const next = [];
  (ids || []).forEach((id) => {
    const key = String(id);
    if (key && !next.includes(key)) next.push(key);
  });
  const same = next.length === selectedMediaIds.length
    && next.every((id, i) => id === selectedMediaIds[i]);
  if (same) return false;
  selectedMediaIds = next;
  if (next.length && selectedCueIndexes.length) {   // 素材与歌词选中互斥
    selectedCueIndexes = [];
    paintCueHighlight([]);
    paintCuePanelHighlight();
  }
  if (next.length && selectedAudioSeg) {            // 素材与音频段选中互斥
    selectedAudioSeg = null;
    paintAudioSegSelection();
  }
  paintClipHighlight(selectedMediaIds);
  updateStatusBar();
  return true;
}

function syncClipSelection() {
  paintClipHighlight(selectedMediaIds);
  updateStatusBar();
}

/** 左键按下 / 拖动片段即选中（剪映手感），无需长按或点小胶囊 */
function selectClipSilently(key) {
  setMediaSelection([key]);
}

function selectClip(key) {
  const item = clipList().find((c) => c.key === key);
  if (!item) return;
  setMediaSelection([key]);
  const seconds = Math.max(0, item.span.end - item.span.start);
  const segLabel = item.mediaCount > 1 ? ' · 第 ' + (item.mediaSeq + 1) + ' / ' + item.mediaCount + ' 段' : '';
  toast('已选中片段：' + item.media.originalName + segLabel
    + '（时长 ' + fmtTimecode(seconds, FRAME_RATE) + ' · 拖两端裁剪 · Ctrl+B 分割 · 退格删除）', 'ok');
}

function clearMediaSelection() {
  if (!selectedMediaIds.length) return;
  setMediaSelection([]);
}

/* ---------------- 歌词行选中（与素材选中互斥） ---------------- */

/** 只刷新歌词块高亮（框选拖动中实时调用） */
function paintCueHighlight(indexes) {
  const set = new Set(indexes || []);
  document.querySelectorAll('#laneSub .cue-block').forEach((node, index) => {
    node.classList.toggle('selected', set.has(index));
  });
}

/** 歌词面板行高亮联动 */
function paintCuePanelHighlight() {
  const set = new Set(selectedCueIndexes);
  document.querySelectorAll('#cueList .cue-item').forEach((node, index) => {
    node.classList.toggle('selected', set.has(index));
  });
}

/** 提交歌词行选中集合（索引越界自动剔除） */
function setCueSelection(indexes) {
  const next = [];
  (indexes || []).forEach((i) => {
    const n = Number(i);
    if (isFinite(n) && n >= 0 && n < cues.length && !next.includes(n)) next.push(n);
  });
  next.sort((a, b) => a - b);
  const same = next.length === selectedCueIndexes.length
    && next.every((v, i) => v === selectedCueIndexes[i]);
  if (same) return false;
  selectedCueIndexes = next;
  if (next.length && selectedMediaIds.length) {   // 素材与歌词选中互斥
    selectedMediaIds = [];
    paintClipHighlight([]);
  }
  paintCueHighlight(selectedCueIndexes);
  paintCuePanelHighlight();
  updateStatusBar();
  if (next.length === 1) {   // 单选时让面板对应行滚入视野
    const item = document.querySelectorAll('#cueList .cue-item')[next[0]];
    if (item && item.scrollIntoView) item.scrollIntoView({ block: 'nearest' });
  }
  return true;
}

function clearCueSelection() {
  if (!selectedCueIndexes.length) return;
  setCueSelection([]);
}

/** 焦点是否正落在「歌词与扫色」面板第 index 行的文本框上 */
function isEditingCueField(index) {
  const item = document.querySelectorAll('#cueList .cue-item')[index];
  const ta = item ? item.querySelector('.cue-text') : null;
  return !!ta && document.activeElement === ta;
}

/**
 * 选中歌词块后的编辑联动：右侧面板切到「歌词与扫色」→ 本行滚入视野
 * → 聚焦本行文本框，点完块就能直接改字
 */
function focusCueEditor(index) {
  // 期间选中可能已被改写（例如双击删除清空了选中），选中态不一致就不抢焦点
  if (selectedCueIndexes.length !== 1 || selectedCueIndexes[0] !== index) return;
  if (index < 0 || index >= cues.length) return;
  const tab = document.querySelector('.tab[data-tab="cues"]');
  if (tab && !tab.classList.contains('active')) tab.click();
  const item = document.querySelectorAll('#cueList .cue-item')[index];
  if (!item) return;
  if (item.scrollIntoView) item.scrollIntoView({ block: 'nearest' });
  const ta = item.querySelector('.cue-text');
  if (!ta || document.activeElement === ta) return;   // 已在编辑本行：保留光标与选区
  ta.focus({ preventScroll: true });
  try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (err) { /* 忽略 */ }
}

/** 歌词块按下：单击选中（Ctrl / Shift 追加或取消），并联动右侧编辑区 */
function onCuePointerDown(ev, index) {
  if (ev.button !== 0) return;
  const additive = !!(ev.ctrlKey || ev.metaKey || ev.shiftKey);
  if (additive) {
    const next = selectedCueIndexes.slice();
    const at = next.indexOf(index);
    if (at >= 0) next.splice(at, 1);
    else next.push(index);
    setCueSelection(next);
  } else {
    setCueSelection([index]);
    // 等这次按下的默认焦点处理结束后，再把焦点交给本行文本框
    window.setTimeout(() => focusCueEditor(index), 0);
  }
}

/** 退格 / 删除：删掉所有选中的歌词行（从后往前删，索引不串位） */
function deleteSelectedCues() {
  if (!selectedCueIndexes.length) return false;
  const indexes = selectedCueIndexes.slice().sort((a, b) => b - a);
  let removed = 0;
  indexes.forEach((i) => {
    if (i >= 0 && i < cues.length) { cues.splice(i, 1); removed++; }
  });
  selectedCueIndexes = [];
  renderCues();
  renderTimeline();
  pushStage();
  toast('已删除 ' + removed + ' 行歌词（点击“保存歌词”写入工程）', 'ok');
  return true;
}

/** Ctrl+C：复制选中歌词行（含逐字时间） */
function copySelectedCues() {
  if (!selectedCueIndexes.length) return false;
  const indexes = selectedCueIndexes.slice().sort((a, b) => a - b);
  clipboardCues = indexes.map((i) => {
    const cue = cues[i];
    if (!cue) return null;
    return {
      index: i,
      start: cue.start,
      end: cue.end,
      text: cue.text || '',
      sweepMode: cue.sweepMode || 'follow',
      words: Array.isArray(cue.words)
        ? cue.words.map((w) => ({ start: w.start, end: w.end, text: w.text }))
        : [],
    };
  }).filter(Boolean);
  clipboardMedia = [];          // 剪贴板同时只保留一类内容
  if (!clipboardCues.length) return false;
  toast('已复制 ' + clipboardCues.length + ' 行歌词（Ctrl+V 粘贴副本）', 'ok');
  return true;
}

/** 逐字时间整体平移 */
function shiftWords(words, delta) {
  return (words || []).map((w) => ({
    start: (w.start || 0) + delta,
    end: (w.end || 0) + delta,
    text: w.text || '',
  }));
}

/** Ctrl+V：把复制的歌词行粘贴为副本，接在源行之后（逐字时间同步平移） */
function pasteCueCopies() {
  if (!project || !clipboardCues.length) return false;
  const srcLast = clipboardCues[clipboardCues.length - 1];
  const insertAt = Math.min(cues.length, Math.max(0, (srcLast.index || 0) + 1));
  const total = duration();
  let cursor = srcLast.end;
  const made = [];
  clipboardCues.forEach((snap) => {
    const len = Math.max(0.2, (snap.end - snap.start) || 1);
    let start = cursor;
    let end = start + len;
    if (total > 0 && end > total) { end = total; start = Math.max(0, end - len); }
    const delta = start - snap.start;
    made.push({
      start: start,
      end: end,
      text: snap.text,
      sweepMode: snap.sweepMode,
      words: shiftWords(snap.words, delta),
    });
    cursor = end;
  });
  cues.splice(insertAt, 0, ...made);
  // 连续粘贴时，下一次接在本次副本之后
  clipboardCues = clipboardCues.map((snap, i) => ({
    index: insertAt + i,
    start: made[i].start,
    end: made[i].end,
    text: snap.text,
    sweepMode: snap.sweepMode,
    words: made[i].words,
  }));
  renderCues();
  setCueSelection(made.map((_, i) => insertAt + i));
  renderTimeline();
  pushStage();
  toast('已粘贴 ' + made.length + ' 行歌词副本（接在源行之后 · 点击“保存歌词”写入工程）', 'ok');
  return true;
}

function isTypingTarget(node) {
  if (!node || !node.tagName) return false;
  const tag = node.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || node.isContentEditable === true;
}

/**
 * 退格 / 删除：删掉所有选中的片段（框选多段可批量删除）。
 * 某素材的所有片段都被选中时连素材一起删除；否则只摘掉选中的分割片段。
 */
async function deleteSelectedMedia() {
  if (!project || !selectedMediaIds.length) return false;
  const clips = clipList();
  const picked = selectedMediaIds
    .map((key) => clips.find((c) => c.key === key))
    .filter(Boolean);
  if (!picked.length) {
    setMediaSelection([]);
    return false;
  }

  const groups = new Map();          // mediaId -> { media, total, keys }
  clips.forEach((item) => {
    const mediaId = String(item.media.id);
    if (!groups.has(mediaId)) groups.set(mediaId, { media: item.media, total: 0, keys: [] });
    groups.get(mediaId).total++;
    groups.get(mediaId).keys.push(item.key);
  });
  const removeMediaIds = [];         // 需要删除素材本身
  const removeClipKeys = [];         // 只移除片段（素材保留）
  const seenMedia = new Set();
  picked.forEach((item) => {
    const mediaId = String(item.media.id);
    if (seenMedia.has(mediaId)) return;
    seenMedia.add(mediaId);
    const group = groups.get(mediaId);
    const pickedOfMedia = picked.filter((p) => String(p.media.id) === mediaId).length;
    if (group && pickedOfMedia >= group.total) removeMediaIds.push(item.media.id);
    else removeClipKeys.push.apply(removeClipKeys, group ? group.keys.filter((k) => selectedMediaIds.includes(k)) : [item.key]);
  });

  try {
    for (const mediaId of removeMediaIds) {
      project = await api('DELETE', '/api/projects/' + project.id + '/media/background/' + mediaId);
    }
    if (removeClipKeys.length) {
      freezeLayout();                // 固化布局：直接删片段后不会被重新补齐
      pushUndo('删除片段');          // 仅移除片段可撤销；素材文件删除（后端）不在撤销范围
      removeClipKeys.forEach((key) => { delete clipLayout[key]; });
      saveClipLayout();
    }
    setMediaSelection([]);
    renderAll();
    renderTimeline();
    pushStage();
    const parts = [];
    if (removeMediaIds.length) parts.push('删除素材 ' + removeMediaIds.length + ' 个');
    if (removeClipKeys.length) parts.push('移除片段 ' + removeClipKeys.length + ' 段');
    toast(parts.length ? '已' + parts.join(' · ') : '没有可删除的片段', 'ok');
  } catch (err) {
    toast('删除失败：' + err.message, 'err');
    renderAll();
    renderTimeline();
  }
  return true;
}

/** Ctrl+C：记录选中片段的快照（含当前裁剪区间），供 Ctrl+V 粘贴副本 */
function copySelectedMedia() {
  if (!project || !selectedMediaIds.length) return false;
  const clips = clipList();
  const items = [];
  selectedMediaIds.forEach((key) => {
    const item = clips.find((c) => c.key === key);
    if (!item) return;
    const entry = { fileName: item.media.fileName, originalName: item.media.originalName };
    entry.span = { start: item.span.start, end: item.span.end, srcIn: item.span.srcIn || 0 };
    items.push(entry);
  });
  if (!items.length) return false;
  clipboardMedia = items;
  clipboardProjectId = project.id;
  toast('已复制 ' + items.length + ' 段素材（Ctrl+V 粘贴副本）', 'ok');
  return true;
}

/** 副本命名：xxx.mp4 → xxx（副本）.mp4 */
function copyNameOf(name) {
  const text = name || '素材';
  const dot = text.lastIndexOf('.');
  if (dot <= 0) return text + '（副本）';
  return text.slice(0, dot) + '（副本）' + text.slice(dot);
}

/** Ctrl+V：把复制的素材粘贴为副本（复制媒体文件，副本片段紧接源片段之后） */
async function pasteMediaCopies() {
  if (!project || !clipboardMedia.length || pasteBusy) return false;
  if (clipboardProjectId && clipboardProjectId !== project.id) {
    toast('素材副本仅支持在同一工程内粘贴', 'err');
    return false;
  }
  pasteBusy = true;
  const sources = clipboardMedia.slice();
  freezeLayout();          // 固化当前布局，副本不会挤动已有片段
  toast('正在粘贴 ' + sources.length + ' 段素材副本…');
  const seen = new Set(mediaList().map((m) => String(m.id)));
  const created = [];      // [{ id, span }]：实际粘贴成功的副本
  const failed = [];
  for (const item of sources) {
    try {
      const res = await fetch(API + '/api/projects/' + project.id + '/media/files/' + item.fileName);
      if (!res.ok) throw new Error('源素材不可读');
      const blob = await res.blob();
      const file = new File([blob], copyNameOf(item.originalName),
        { type: blob.type || 'application/octet-stream' });
      const form = new FormData();
      form.append('file', file);
      project = await api('POST', '/api/projects/' + project.id + '/media/background', form);
      mediaList().forEach((m) => {
        const key = String(m.id);
        if (!seen.has(key)) {
          seen.add(key);
          created.push({ id: key, span: item.span || null });
        }
      });
    } catch (err) {
      failed.push(item.originalName + '：' + err.message);
    }
  }

  // 副本片段：接在各自源片段之后，沿用源片段的长度与源入点；已占用则顺延到下一个空位
  const total = duration();
  created.forEach((rec) => {
    const span = rec.span;
    const length = span ? Math.max(MIN_CLIP_SEC, span.end - span.start) : DEFAULT_CLIP_SEC;
    const start = nextFreeStart(span ? span.end : 0, length, total);
    clipLayout[rec.id] = {
      start: start,
      end: start + length,
      srcIn: span ? span.srcIn : 0,
      custom: true,
      mediaId: rec.id,
    };
  });
  saveClipLayout();
  setMediaSelection(created.map((r) => r.id));
  renderAll();
  renderTimeline();
  pushStage();
  if (failed.length) {
    toast('已粘贴 ' + created.length + ' 段，' + failed.length + ' 段失败：' + failed[0], 'err');
  } else {
    toast('已粘贴 ' + created.length + ' 段素材副本（紧接原片段之后）', 'ok');
  }
  pasteBusy = false;
  return created.length > 0;
}

/** 从 start 起找一段长度 length 的空位：与已有片段冲突时顺延到冲突片段之后 */
function nextFreeStart(start, length, total) {
  const maxStart = Math.max(0, total - length);
  const spans = Object.keys(clipLayout).map((k) => clipLayout[k]).filter(Boolean);
  let candidate = clampTime(snapToFrame(start), 0, maxStart);
  for (let guard = 0; guard < 500; guard++) {
    const hit = spans.find((s) => s.start < candidate + length - 1e-4 && s.end > candidate + 1e-4);
    if (!hit) return candidate;
    // 顺延到冲突片段之后：向上对齐到帧，避免取整后原地踏步
    const next = Math.min(maxStart, Math.ceil(hit.end * FRAME_RATE) / FRAME_RATE);
    if (next <= candidate) return candidate;   // 已到歌尾或无法前进：接受当前位置
    candidate = next;
  }
  return candidate;
}

/**
 * 全局快捷键：
 * - Ctrl+B：分割——光标在素材轨分素材片段，光标在音频轨分音频（切点都取光标位置）
 * - Ctrl+Z：撤销上一步时间轴操作（菜单快捷键转发 + 这里兜底）
 * - Ctrl+C / Ctrl+V：复制选中素材 / 粘贴副本（输入框内保留原生复制粘贴）
 * - 退格 / Delete：删除选中素材 / 选中歌词行 / 选中音频段（音频段=物理裁剪，可撤销）
 * - ←/→：选中片段逐帧移动（Shift 10 帧）
 * - Alt+←/→：逐帧裁左边缘，Ctrl+←/→：逐帧裁右边缘
 */
function handleTimelineKeys(event) {
  if (!event) return;
  if (event.key === 'Escape') {
    clearMediaSelection();
    clearCueSelection();
    clearAudioSegSelection();
    return;
  }
  if (event.key === ' ' || event.key === 'Spacebar') {
    const target = event.target;
    if (isTypingTarget(target)) return;
    if (target && target.tagName && target.tagName.toLowerCase() === 'button') return;
    if (event.preventDefault) event.preventDefault();
    togglePlay();
    return;
  }
  if (event.ctrlKey || event.metaKey) {
    const combo = (event.key || '').toLowerCase();
    if (combo === 'b') {
      if (isTypingTarget(event.target)) return;
      if (event.preventDefault) event.preventDefault();
      // 光标在哪条轨就分哪条（切点优先取光标位置）；
      // 素材轨为空 / 选中了音频段时自动分音频，见 wouldSplitAudio()
      if (wouldSplitAudio()) splitAudioAt(hoverSplitTime);
      else splitSelectedClip();
      return;
    }
    if (combo === 'z') {
      if (isTypingTarget(event.target)) return;   // 输入框保留原生撤销
      if (event.preventDefault) event.preventDefault();
      undoLastAction();
      return;
    }
    if (combo === 'c' || combo === 'v') {
      if (isTypingTarget(event.target)) return;   // 输入框 / 歌词文本域保留原生复制粘贴
      if (combo === 'c') {
        const ok = selectedCueIndexes.length ? copySelectedCues() : copySelectedMedia();
        if (ok && event.preventDefault) event.preventDefault();
      } else if (clipboardCues.length) {
        if (event.preventDefault) event.preventDefault();
        pasteCueCopies();
      } else if (clipboardMedia.length) {
        if (event.preventDefault) event.preventDefault();
        pasteMediaCopies();
      }
      return;
    }
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    if (isTypingTarget(event.target)) return;
    if (!selectedMediaIds.length) return;
    if (event.preventDefault) event.preventDefault();
    nudgeSelectedClip(event);
    return;
  }
  if (event.key !== 'Backspace' && event.key !== 'Delete') return;
  if (isTypingTarget(event.target)) return;   // 输入框 / 歌词文本域里照常退格
  const hasMedia = selectedMediaIds.length > 0;
  const hasCue = selectedCueIndexes.length > 0;
  const hasAudioSeg = !!selectedAudioSeg;
  if (!hasMedia && !hasCue && !hasAudioSeg) return;
  if (event.preventDefault) event.preventDefault();
  if (hasCue) deleteSelectedCues();
  if (hasMedia) deleteSelectedMedia();
  if (hasAudioSeg) deleteSelectedAudioSeg();   // 选中音频段：物理裁剪（带二次确认）
}

/**
 * 片段上的 ✕：素材只有这一段时删除素材本身；
 * 已被分割成多段时只移除这一段，其它段与素材都保留。
 */
async function removeClip(key) {
  if (!project) return;
  const clips = clipList();
  const item = clips.find((c) => c.key === key);
  if (!item) return;
  const siblings = clips.filter((c) => String(c.media.id) === String(item.media.id));
  if (siblings.length > 1) {
    freezeLayout();                 // 固化布局：移除后不会被重新补齐
    pushUndo('移除片段');
    delete clipLayout[key];
    saveClipLayout();
    setMediaSelection(selectedMediaIds.filter((id) => id !== key));
    renderTimeline();
    pushStage();
    toast('已移除该片段（素材保留 · 其余 ' + (siblings.length - 1) + ' 段不受影响）', 'ok');
    return;
  }
  const mediaId = item.media.id;
  const label = item.media.originalName;
  try {
    project = await api('DELETE', '/api/projects/' + project.id + '/media/background/' + mediaId);
    setMediaSelection(selectedMediaIds.filter((id) => id !== key));
    renderAll();
    renderTimeline();
    pushStage();
    toast('素材片段已删除' + (label ? '：' + label : ''), 'ok');
  } catch (err) {
    toast('删除失败：' + err.message, 'err');
  }
}

function removeCue(index) {
  cues.splice(index, 1);
  selectedCueIndexes = [];
  renderCues();
  renderTimeline();
  pushStage();
  toast('已删除该行歌词', 'ok');
}

function updateStatusBar() {
  const left = el('statusLeft');
  const right = el('statusRight');
  const mediaCount = mediaList().length;
  const clips = clipList();
  const primaryId = selectedMediaIds.length ? selectedMediaIds[selectedMediaIds.length - 1] : null;
  const primary = primaryId ? clips.find((c) => c.key === primaryId) : null;
  const selected = primary ? primary.media : null;
  if (left) {
    if (selectedCueIndexes.length > 1) {
      left.textContent = '已选中 ' + selectedCueIndexes.length + ' 行歌词 · Ctrl+C 复制 / Ctrl+V 粘贴 · 退格批量删除 · Esc 取消';
    } else if (selectedCueIndexes.length === 1) {
      const cue = cues[selectedCueIndexes[0]];
      const range = cue ? ' · ' + fmtTime(cue.start) + '→' + fmtTime(cue.end) : '';
      if (isEditingCueField(selectedCueIndexes[0])) {
        left.textContent = '正在编辑第 #' + (selectedCueIndexes[0] + 1) + ' 行歌词' + range
          + ' · 输入即时生效 · Esc 取消选中';
      } else {
        left.textContent = '选中第 #' + (selectedCueIndexes[0] + 1) + ' 行歌词' + range
          + ' · Ctrl+C 复制 / Ctrl+V 粘贴 · 退格删除 · 双击块删除';
      }
    } else if (selected && selectedMediaIds.length > 1) {
      left.textContent = '已框选 ' + selectedMediaIds.length + ' 段素材 · 方向键整体移动 · Ctrl+B 分割主选中 · Ctrl+C 复制 · 退格批量删除 · Esc 取消';
    } else if (selected) {
      const span = primary.span;
      const range = span
        ? ' · ' + fmtTimecode(span.start, FRAME_RATE) + '→' + fmtTimecode(span.end, FRAME_RATE)
          + '（' + (span.end - span.start).toFixed(2) + 's）'
        : '';
      const segLabel = primary.mediaCount > 1 ? '（第 ' + (primary.mediaSeq + 1) + ' / ' + primary.mediaCount + ' 段）' : '';
      left.textContent = '选中「' + selected.originalName + '」' + segLabel + range
        + ' · 拖两端裁剪 · Ctrl+B 播放头处分割 · 方向键微调 · Ctrl+C/V 复制粘贴 · 退格删除';
    } else if (selectedAudioSeg) {
      const segIndex = audioSegments.findIndex((seg) => seg.key === selectedAudioSeg);
      const seg = segIndex >= 0 ? audioSegments[segIndex] : null;
      if (seg) {
        left.textContent = '选中音频第 ' + (segIndex + 1) + ' / ' + audioSegments.length + ' 段 · '
          + fmtTimecode(seg.start, FRAME_RATE) + '→' + fmtTimecode(seg.end, FRAME_RATE)
          + '（' + (seg.end - seg.start).toFixed(2) + 's）· Delete 删除该段（物理裁剪，可撤销）· Ctrl+B 音频轨分割 · Esc 取消';
      }
    } else {
      const tips = [];
      if (mediaCount) tips.push('素材 ' + mediaCount + ' 个 / 片段 ' + clips.length + ' 段（单击选中 · 空白处拖动框选 · Ctrl+B 分割）');
      if (cues.length) tips.push('歌词 ' + cues.length + ' 行（单击歌词块选中 · 字幕轨拖动框选）');
      if (tips.length) tips.push('Ctrl+Z 撤销');
      left.textContent = tips.length ? tips.join(' · ') : '等待导入歌曲与素材';
    }
  }
  if (right) {
    const chars = cues.reduce((sum, cue) => sum + (cue.text ? Array.from(cue.text).length : 0), 0);
    right.textContent = '字数: ' + chars + ' 字';
  }
}

/* ================= 波形 ================= */

function playRatio() {
  const total = duration();
  return total > 0 ? Math.min(1, audio.currentTime / total) : 0;
}

async function buildWaveform(url) {
  wavePeaks = null;
  lastWaveRatio = -1;
  if (!url) { drawWaveform(0); return; }
  try {
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtor();
    const decoded = await audioCtx.decodeAudioData(buffer);
    const data = decoded.getChannelData(0);
    // 高分辨率双层包络：峰值（外层蓝）+ 有效值（内层橙）
    const buckets = 4000;
    const step = Math.max(1, Math.floor(data.length / buckets));
    const peaks = new Float32Array(buckets);
    const rms = new Float32Array(buckets);
    for (let i = 0; i < buckets; i++) {
      let max = 0;
      let sum = 0;
      let count = 0;
      const start = i * step;
      for (let j = 0; j < step; j += 8) {
        const value = data[start + j] || 0;
        const abs = Math.abs(value);
        if (abs > max) max = abs;
        sum += value * value;
        count++;
      }
      peaks[i] = Math.min(1, max * 1.15);
      rms[i] = count ? Math.min(1, Math.sqrt(sum / count) * 2.7) : 0;
    }
    wavePeaks = peaks;
    waveRms = rms;
    if (audioCtx.close) audioCtx.close();
    drawWaveform(playRatio());
  } catch (err) {
    drawWaveform(0);
  }
}

/**
 * 音频裁剪后就地拼接旧波形峰值：省去重新下载 + 解码整首歌的数秒等待。
 * 返回被删区间的 bins 备份，供撤销时插回；无法复用时返回 null（调用方回退重建）。
 */
function spliceWaveformAfterCut(start, end, total) {
  if (!wavePeaks || !wavePeaks.length || !(total > 0)) return null;
  const n = wavePeaks.length;
  const n1 = Math.max(0, Math.min(n, Math.round((start / total) * n)));
  const n2 = Math.max(n1, Math.min(n, Math.round((end / total) * n)));
  if (n2 <= n1) return null;
  const backup = {
    start: start,
    end: end,
    total: total,
    peaks: wavePeaks.slice(n1, n2),
    rms: waveRms && waveRms.length === n ? waveRms.slice(n1, n2) : null,
  };
  const merged = new Float32Array(n - (n2 - n1));
  merged.set(wavePeaks.subarray(0, n1), 0);
  merged.set(wavePeaks.subarray(n2), n1);
  wavePeaks = merged;
  if (waveRms && waveRms.length === n) {
    const mergedRms = new Float32Array(merged.length);
    mergedRms.set(waveRms.subarray(0, n1), 0);
    mergedRms.set(waveRms.subarray(n2), n1);
    waveRms = mergedRms;
  }
  lastWaveRatio = -1;
  return backup;
}

/** 撤销裁剪后把备份 bins 插回原位（总时长恢复后调用）；对不上返回 false 走重建 */
function mergeWaveformBackAfterUndo(backup, totalAfter) {
  if (!backup || !backup.peaks || !backup.peaks.length) return false;
  if (!wavePeaks || !wavePeaks.length || !(totalAfter > 0)) return false;
  const nCur = wavePeaks.length;
  const nBack = nCur + backup.peaks.length;
  const n1 = Math.max(0, Math.min(nBack, Math.round((backup.start / (backup.total || totalAfter)) * nBack)));
  const merged = new Float32Array(nBack);
  merged.set(wavePeaks.subarray(0, n1), 0);
  merged.set(backup.peaks, n1);
  merged.set(wavePeaks.subarray(n1), n1 + backup.peaks.length);
  wavePeaks = merged;
  if (backup.rms && backup.rms.length === backup.peaks.length && waveRms && waveRms.length === nCur) {
    const mergedRms = new Float32Array(nBack);
    mergedRms.set(waveRms.subarray(0, n1), 0);
    mergedRms.set(backup.rms, n1);
    mergedRms.set(waveRms.subarray(n1), n1 + backup.rms.length);
    waveRms = mergedRms;
  }
  lastWaveRatio = -1;
  return true;
}

/**
 * 波形按视口绘制：canvas 宽度=可视区宽度，位置跟随 scrollLeft，
 * 每次滚动/缩放只重绘当前可见时间段的峰值，因此缩放不会像素化。
 */
function drawWaveform(ratio) {
  const lanes = el('trackLanes');
  const canvas = el('waveCanvas');
  const wrap = el('waveWrap');
  if (!lanes || !canvas || !wrap) return;

  const total = duration();
  const viewW = Math.max(60, lanes.clientWidth);
  const bandH = Math.max(16, wrap.parentElement ? wrap.parentElement.clientHeight : 56);
  const dpr = window.devicePixelRatio || 1;

  wrap.style.left = lanes.scrollLeft + 'px';
  wrap.style.width = viewW + 'px';
  canvas.width = Math.round(viewW * dpr);
  canvas.height = Math.round(bandH * dpr);
  canvas.style.width = viewW + 'px';
  canvas.style.height = bandH + 'px';

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, viewW, bandH);

  const mid = bandH / 2;
  if (!wavePeaks || total <= 0) {
    ctx.fillStyle = '#262833';
    ctx.fillRect(0, mid, viewW, 1);
    return;
  }

  const perSec = Math.max(1, pxPerSecond);
  const t0 = lanes.scrollLeft / perSec;
  const n = wavePeaks.length;
  const playT = audio.currentTime;
  const band = bandH - 4;
  const rmsArr = waveRms || wavePeaks;

  for (let x = 0; x < viewW; x++) {
    const t = t0 + x / perSec;
    if (t < 0 || t > total) continue;
    // 每像素覆盖的峰值区间取最大值（缩小时仍是完整包络）
    const idxStart = Math.max(0, Math.floor((t / total) * n));
    const idxEnd = Math.min(n, Math.max(idxStart + 1, Math.ceil(((t + 1 / perSec) / total) * n)));
    let peak = 0;
    let rmsVal = 0;
    for (let k = idxStart; k < idxEnd; k++) {
      if (wavePeaks[k] > peak) peak = wavePeaks[k];
      if (rmsArr[k] > rmsVal) rmsVal = rmsArr[k];
    }
    const played = t <= playT;

    // 外层：峰值包络（蓝）
    const hPeak = Math.max(1.5, peak * band);
    ctx.fillStyle = played ? '#3b82f6' : '#2d5bc4';
    ctx.fillRect(x, mid - hPeak / 2, 1, hPeak);

    // 内层：有效值包络（橙，主体）
    const hRms = Math.max(1, Math.min(peak, rmsVal) * band);
    ctx.fillStyle = played ? '#f08a3c' : '#c4682a';
    ctx.fillRect(x, mid - hRms / 2, 1, hRms);
  }

  // 贯穿中线
  ctx.fillStyle = 'rgba(232, 236, 255, .5)';
  ctx.fillRect(0, mid - 0.5, viewW, 1);
}

function updateWaveHead() {
  const head = el('waveHead');
  if (!head) return;
  head.style.transform = 'translateX(' + (audio.currentTime * Math.max(1, pxPerSecond)) + 'px)';
}

/* ================= 素材片段 · 分帧裁剪 ================= */

/** 本地布局存档键：裁剪数据只存本机，不动工程文件与后端 */
function layoutStoreKey(id) {
  return 'ktv:clip-layout:' + id;
}

/** 片段键 → 素材 id（旧存档没有 mediaId 字段时，片段键本身就是素材 id） */
function clipMediaId(key) {
  const span = clipLayout[key];
  return span && span.mediaId ? String(span.mediaId) : String(key);
}

/** 为分割出的新片段分配不与现有片段冲突的键 */
function uniqueClipKey(mediaId) {
  let key = '';
  do {
    key = String(mediaId) + ':' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  } while (clipLayout[key]);
  return key;
}

/**
 * 时间轴上的片段列表（有序）：同一素材可被分割成多段。
 * 排列规则：按素材顺序，同一素材的各段按开始时间先后。
 * 返回 [{ key, media, mediaIndex, mediaSeq, mediaCount, span }]
 */
function clipList() {
  const list = mediaList();
  const total = duration();
  const items = [];
  list.forEach((media, mediaIndex) => {
    const mediaId = String(media.id);
    const keys = Object.keys(clipLayout).filter((key) => clipMediaId(key) === mediaId);
    if (!keys.length) keys.push(mediaId);            // 尚未进入布局的素材：用主键占位
    keys.sort((a, b) => {
      const sa = clipLayout[a] || evenSpan(list, mediaIndex, total);
      const sb = clipLayout[b] || evenSpan(list, mediaIndex, total);
      return (sa.start - sb.start) || (a < b ? -1 : 1);
    });
    keys.forEach((key, seq) => {
      items.push({
        key: key,
        media: media,
        mediaIndex: mediaIndex,
        mediaSeq: seq,
        mediaCount: keys.length,
        span: clipLayout[key] || evenSpan(list, mediaIndex, total),
      });
    });
  });
  return items;
}

function loadClipLayout(id) {
  clipLayout = {};
  layoutFrozen = false;
  layoutProjectId = id || null;
  if (!id) return;
  let raw = null;
  try { raw = localStorage.getItem(layoutStoreKey(id)); } catch (err) { raw = null; }
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    const clips = (data && data.clips) || {};
    Object.keys(clips).forEach((key) => {
      const item = clips[key];
      if (item && isFinite(item.start) && isFinite(item.end) && item.end > item.start) {
        clipLayout[key] = {
          start: Number(item.start),
          end: Number(item.end),
          srcIn: isFinite(item.srcIn) ? Math.max(0, Number(item.srcIn)) : 0,
          custom: !!item.custom,
          mediaId: item.mediaId ? String(item.mediaId) : null,
        };
      }
    });
    layoutFrozen = !!(data && data.frozen);
  } catch (err) {
    clipLayout = {};
    layoutFrozen = false;
  }
}

function saveClipLayout() {
  if (!layoutProjectId) return;
  try {
    localStorage.setItem(layoutStoreKey(layoutProjectId), JSON.stringify({
      frozen: layoutFrozen,
      clips: clipLayout,
    }));
  } catch (err) { /* 存储不可用时静默，不影响操作 */ }
}

/** 默认布局：素材均匀铺满整首歌（未裁剪时的行为与旧版一致） */
function evenSpan(list, index, total) {
  const each = list.length ? total / list.length : 0;
  return { start: index * each, end: (index + 1) * each, srcIn: 0, custom: false };
}

function clipMedia(mediaId) {
  return mediaList().find((m) => String(m.id) === String(mediaId)) || null;
}

/** 素材增删后对齐布局：补齐新素材、丢弃已删除素材的记录（含它的分割片段） */
function syncClipLayout() {
  const id = project ? project.id : null;
  if (id !== layoutProjectId) loadClipLayout(id);
  if (!id) { clipLayout = {}; layoutFrozen = false; return; }

  const list = mediaList();
  const total = duration();
  if (!list.length) {
    if (Object.keys(clipLayout).length) { clipLayout = {}; saveClipLayout(); }
    layoutFrozen = false;
    return;
  }

  const aliveIds = new Set(list.map((m) => String(m.id)));
  const next = {};
  let tail = 0;
  Object.keys(clipLayout).forEach((key) => {
    if (!aliveIds.has(clipMediaId(key))) return;   // 素材已删除：连同它的分割片段一起丢弃
    next[key] = clipLayout[key];
    if (next[key].end > tail) tail = next[key].end;
  });

  const hasClipOf = (mediaId) => Object.keys(next).some((key) => clipMediaId(key) === mediaId);
  let changed = Object.keys(next).length !== Object.keys(clipLayout).length;
  list.forEach((media, index) => {
    const key = String(media.id);
    if (hasClipOf(key)) return;                    // 该素材已有片段（主片段或分割片段）
    changed = true;
    if (!layoutFrozen || total <= 0) {
      next[key] = Object.assign({ mediaId: key }, evenSpan(list, index, total));
      return;
    }
    // 冻结布局后新加入的素材：接在末尾，没有空间就贴着歌尾
    const length = Math.max(MIN_CLIP_SEC, Math.min(DEFAULT_CLIP_SEC, Math.max(0, total - tail)));
    const start = Math.max(0, Math.min(tail, Math.max(0, total - length)));
    const end = total > 0 ? Math.min(total, start + length) : start + length;
    next[key] = { start: start, end: Math.max(end, start + MIN_CLIP_SEC), srcIn: 0, custom: false, mediaId: key };
    if (next[key].end > tail) tail = next[key].end;
  });

  clipLayout = next;
  if (changed) saveClipLayout();
}

/** 首次裁剪 / 分割前把均匀布局固化为显式布局，此后各片段互不牵动（剪映式） */
function freezeLayout() {
  if (layoutFrozen) return;
  syncClipLayout();               // 保证分割片段已进入布局
  const next = {};
  clipList().forEach((item) => {
    const span = item.span;
    next[item.key] = {
      start: span.start,
      end: span.end,
      srcIn: span.srcIn || 0,
      custom: !!span.custom,
      mediaId: clipMediaId(item.key),
    };
  });
  clipLayout = next;
  layoutFrozen = true;
}

function snapToFrame(seconds) {
  return Math.round(seconds * FRAME_RATE) / FRAME_RATE;
}

function clampTime(value, min, max) {
  const hi = Math.max(min, max);
  return Math.min(hi, Math.max(min, value));
}

/**
 * 磁吸目标：歌曲首尾、播放头、其它片段端点、文案（歌词）首尾。
 * 每项带 kind（edge/head/clip/cue-start/cue-end）与 index，供参考线区分配色与提示。
 */
function snapTargets(excludeKey) {
  const targets = [
    { time: 0, kind: 'edge' },
    { time: duration(), kind: 'edge' },
  ];
  if (isFinite(audio.currentTime)) targets.push({ time: audio.currentTime, kind: 'head' });
  Object.keys(clipLayout).forEach((key) => {
    if (key === excludeKey) return;
    targets.push({ time: clipLayout[key].start, kind: 'clip' }, { time: clipLayout[key].end, kind: 'clip' });
  });
  cues.forEach((cue, index) => {
    if (isFinite(cue.start)) targets.push({ time: cue.start, kind: 'cue-start', index: index });
    if (isFinite(cue.end)) targets.push({ time: cue.end, kind: 'cue-end', index: index });
  });
  return targets.filter((t) => isFinite(t.time));
}

function bestSnapPoint(value, targets, threshold) {
  let best = null;
  for (const t of targets) {
    const d = Math.abs(t.time - value);
    if (d <= threshold && (!best || d < best.d)) best = { d: d, time: t.time, kind: t.kind, index: t.index };
  }
  return best;
}

function bestSnapMove(rawStart, rawEnd, targets, threshold) {
  let best = null;
  for (const t of targets) {
    const ds = Math.abs(rawStart - t.time);
    if (ds <= threshold && (!best || ds < best.d)) {
      best = { d: ds, delta: t.time - rawStart, guide: t.time, kind: t.kind, index: t.index };
    }
    const de = Math.abs(rawEnd - t.time);
    if (de <= threshold && (!best || de < best.d)) {
      best = { d: de, delta: t.time - rawEnd, guide: t.time, kind: t.kind, index: t.index };
    }
  }
  return best;
}

/** 视频胶片条的 4 个抽帧点：跟随裁剪区间（图片忽略） */
function clipThumbTimes(media, span) {
  const visible = Math.max(0.01, span.end - span.start);
  const srcDur = media.duration > 0 ? media.duration : visible;
  const times = [];
  for (let i = 0; i < 4; i++) {
    let t = (span.srcIn || 0) + ((i + 0.5) / 4) * visible;
    if (srcDur > 0) t = Math.min(srcDur - 0.05, t);
    times.push(Math.max(0, Math.round(t * 10) / 10));
  }
  return times;
}

/* ---------------- 拖动（指针） ---------------- */

function bindClipPointerDown(clip, media, key) {
  clip.addEventListener('pointerdown', (ev) => onClipPointerDown(ev, clip, media, key));
}

function onClipPointerDown(ev, clip, media, clipKey) {
  if (ev.button !== 0 || clipDrag) return;
  if (ev.target && ev.target.closest && ev.target.closest('.clip-pick, .clip-del, .clip-split')) return;
  if (!project || duration() <= 0) return;

  const key = clipKey || String(media.id);
  const span = clipLayout[key];
  if (!span) return;

  const edge = ev.target && ev.target.closest ? ev.target.closest('.clip-edge') : null;
  const inside = ev.target && ev.target.closest ? ev.target.closest('.clip-body, .clip-head') : null;
  let mode = null;
  let side = null;
  if (edge) {
    mode = 'trim';
    side = edge.classList.contains('left') ? 'left' : 'right';
  } else if (inside) {
    mode = 'move';
  }
  if (!mode) return;

  // 左键一按下就选中该片段：单击、拖动都能选中（不再需要长按 / 点小胶囊）
  selectClipSilently(key);
  clip.classList.add('pressing');

  clipDrag = {
    mode: mode,
    side: side,
    key: key,
    media: media,
    clip: clip,
    pointerId: ev.pointerId,
    startX: ev.clientX,
    startY: ev.clientY,
    clientX: ev.clientX,
    clientY: ev.clientY,
    altKey: !!ev.altKey,
    origin: { start: span.start, end: span.end, srcIn: span.srcIn || 0 },
    started: mode === 'trim',
    guide: null,
    hit: false,
    autoDir: 0,
    autoSpeed: 0,
    autoRaf: 0,
  };

  if (mode === 'trim') {
    // 把手按下即刻进入裁剪：阻止播放头定位
    ev.preventDefault();
    ev.stopPropagation();
    freezeLayout();     // 一旦开始裁剪，其它片段的当前位置就固定下来
    beginDragVisual(ev);
  }
}

function beginDragVisual(ev) {
  const drag = clipDrag;
  if (!drag) return;
  // 拖动把手同样视为选中该片段（便于接着用方向键逐帧微调）
  selectClipSilently(drag.key);
  drag.clip.classList.add('trimming');
  if (drag.side) {
    drag.clip.classList.add('edge-' + drag.side);
    const handle = drag.clip.querySelector('.clip-edge.' + drag.side);
    if (handle) handle.classList.add('active');
  }
  document.body.classList.add('clip-dragging-trim');
  try { drag.clip.setPointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
  updateTrimTip(drag);
}

function onClipPointerMove(ev) {
  const drag = clipDrag;
  if (!drag || ev.pointerId !== drag.pointerId) return;

  drag.clientX = ev.clientX;
  drag.clientY = ev.clientY;
  drag.altKey = !!ev.altKey;

  if (!drag.started) {
    const dx = ev.clientX - drag.startX;
    const dy = ev.clientY - drag.startY;
    if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    // 超过阈值才算拖动：此时固化布局并进入移动态（选中在按下时就完成了）
    drag.started = true;
    freezeLayout();
    selectClipSilently(drag.key);
    drag.clip.classList.add('moving');
    document.body.classList.add('clip-dragging-move');
    try { drag.clip.setPointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
  }

  if (drag.mode === 'move') ev.preventDefault();
  applyClipDrag();
  updateAutoScroll();
}

function applyClipDrag() {
  const drag = clipDrag;
  if (!drag || !drag.started) return;
  const span = clipLayout[drag.key];
  if (!span) return;
  if (!drag.undoPushed) {            // 首次真正改动前记快照：一次拖动 = 一步撤销
    drag.undoPushed = true;
    pushUndo(drag.mode === 'move' ? '移动片段' : '裁剪片段');
  }

  const total = duration();
  const perSec = Math.max(1, pxPerSecond);
  const freehand = drag.altKey;                     // Alt：临时关闭磁吸与帧对齐
  const threshold = SNAP_PX / perSec;
  const targets = freehand || !snapEnabled ? [] : snapTargets(drag.key);
  const dt = (drag.clientX - drag.startX) / perSec;

  let start = drag.origin.start;
  let end = drag.origin.end;
  let srcIn = drag.origin.srcIn;
  let guide = null;
  let guideKind = null;
  let guideIndex = -1;
  let hit = false;

  if (drag.mode === 'move') {
    const len = drag.origin.end - drag.origin.start;
    let nextStart = drag.origin.start + dt;
    if (targets.length) {
      const best = bestSnapMove(nextStart, nextStart + len, targets, threshold);
      if (best) { nextStart += best.delta; guide = best.guide; guideKind = best.kind; guideIndex = best.index; }
    } else if (!freehand) {
      nextStart = snapToFrame(nextStart);
    }
    const fitted = clampTime(nextStart, 0, Math.max(0, total - len));
    hit = Math.abs(fitted - nextStart) > 1e-6;
    start = fitted;
    end = fitted + len;
  } else if (drag.side === 'left') {
    // 视频受源入点限制（不能露出素材开头之前）；图片可自由延长
    const hasSource = !!(drag.media && drag.media.duration > 0);
    const minStart = hasSource ? Math.max(0, drag.origin.start - drag.origin.srcIn) : 0;
    const maxStart = drag.origin.end - MIN_CLIP_SEC;
    let nextStart = drag.origin.start + dt;
    let snapped = false;
    if (targets.length) {
      const best = bestSnapPoint(nextStart, targets, threshold);
      if (best) { nextStart = best.time; guide = best.time; guideKind = best.kind; guideIndex = best.index; snapped = true; }
    }
    if (!freehand && !snapped) nextStart = snapToFrame(nextStart);
    const fitted = clampTime(nextStart, minStart, maxStart);
    hit = Math.abs(fitted - nextStart) > 1e-6;
    start = fitted;
    srcIn = Math.max(0, drag.origin.srcIn + (start - drag.origin.start));
    end = drag.origin.end;
  } else {
    let maxEnd = total;
    if (drag.media && drag.media.duration > 0) {
      // 视频素材最多拉到源素材剩余长度（不做循环变速）
      maxEnd = Math.min(total, drag.origin.start + Math.max(MIN_CLIP_SEC, drag.media.duration - drag.origin.srcIn));
    }
    let nextEnd = drag.origin.end + dt;
    let snapped = false;
    if (targets.length) {
      const best = bestSnapPoint(nextEnd, targets, threshold);
      if (best) { nextEnd = best.time; guide = best.time; guideKind = best.kind; guideIndex = best.index; snapped = true; }
    }
    if (!freehand && !snapped) nextEnd = snapToFrame(nextEnd);
    const fitted = clampTime(nextEnd, drag.origin.start + MIN_CLIP_SEC, maxEnd);
    hit = Math.abs(fitted - nextEnd) > 1e-6;
    end = fitted;
  }

  span.start = start;
  span.end = end;
  span.srcIn = srcIn;
  span.custom = true;
  drag.dirty = true;

  paintClipSpan(drag.clip, span);
  drag.guide = guide;
  drag.guideKind = guideKind;
  drag.guideIndex = guideIndex;
  drag.hit = hit;
  drag.clip.classList.toggle('edge-hit', hit);
  showSnapLine(guide, guideKind, guideIndex);
  highlightCueSnap(guideKind, guideIndex);
  updateTrimTip(drag);
}

/** 拖动中只改样式，不重建 DOM —— 这是"跟手"的关键 */
function paintClipSpan(clip, span) {
  const perSec = Math.max(1, pxPerSecond);
  clip.style.left = Math.round(span.start * perSec) + 'px';
  clip.style.width = Math.max(3, Math.round((span.end - span.start) * perSec) - 3) + 'px';
  const tc = clip.querySelector('.clip-tc');
  if (tc) tc.textContent = fmtTimecode(span.end - span.start, FRAME_RATE);
}

function updateTrimTip(drag) {
  const tip = el('trimTip');
  if (!tip || !drag || !drag.started) {
    if (tip) tip.classList.remove('show');
    return;
  }
  const span = clipLayout[drag.key];
  if (!span) { tip.classList.remove('show'); return; }
  const head = drag.mode === 'move' ? '移动' : (drag.side === 'left' ? '入点' : '出点');
  const focus = drag.mode === 'move' ? span.start : (drag.side === 'left' ? span.start : span.end);
  let html = head + ' <b>' + fmtTimecode(focus, FRAME_RATE) + '</b>'
    + ' · 时长 <b>' + (span.end - span.start).toFixed(2) + 's</b>'
    + ' · 源入点 <b>' + fmtTimecode(span.srcIn, FRAME_RATE) + '</b>';
  if (drag.guide !== null && drag.guide !== undefined) {
    const cueKind = drag.guideKind === 'cue-start' ? '开头' : (drag.guideKind === 'cue-end' ? '结尾' : '');
    html += cueKind
      ? ' · <span class="cue-snap">对齐文案 #' + (drag.guideIndex + 1) + ' ' + cueKind + '</span>'
      : ' · <span>磁吸</span>';
  }
  if (drag.hit) html += ' · <span class="warn">已到边界</span>';
  tip.innerHTML = html;
  tip.style.left = Math.round(drag.clientX) + 'px';
  tip.style.top = Math.round(drag.clientY - 12) + 'px';
  tip.classList.add('show');
}

/** 参考线：文案对齐用青色 + 文案标签，其它磁吸保持金色 */
function showSnapLine(time, kind, index) {
  const line = el('snapLine');
  if (!line) return;
  if (time === null || time === undefined || !isFinite(time)) {
    line.classList.remove('show');
    return;
  }
  line.style.left = Math.round(time * Math.max(1, pxPerSecond)) + 'px';
  const isCue = kind === 'cue-start' || kind === 'cue-end';
  line.classList.toggle('cue', isCue);
  const tag = line.querySelector('.snap-tag');
  if (tag) {
    tag.textContent = isCue
      ? ('文案 #' + (index + 1) + (kind === 'cue-start' ? ' 开头' : ' 结尾'))
      : '';
  }
  line.classList.add('show');
}

/** 吸附到某句文案时，把字幕轨上对应的歌词块点亮，便于一眼确认对齐的是哪一句 */
function highlightCueSnap(kind, index) {
  const isCue = (kind === 'cue-start' || kind === 'cue-end') && index >= 0;
  const next = isCue ? index : -1;
  if (next === cueSnapHitIndex) return;
  const lane = el('laneSub');
  if (lane) {
    const prev = lane.children[cueSnapHitIndex];
    if (prev) prev.classList.remove('snap-hit');
    const now = lane.children[next];
    if (now) now.classList.add('snap-hit');
  }
  cueSnapHitIndex = next;
}

/** 拖到视口边缘时自动滚动时间轴（速度随靠近程度加快） */
function updateAutoScroll() {
  const drag = clipDrag;
  const lanes = el('trackLanes');
  if (!drag || !drag.started || !lanes) return;
  const rect = lanes.getBoundingClientRect();
  let dir = 0;
  let closeness = 0;
  if (drag.clientX < rect.left + AUTO_SCROLL_EDGE) {
    dir = -1;
    closeness = (rect.left + AUTO_SCROLL_EDGE - drag.clientX) / AUTO_SCROLL_EDGE;
  } else if (drag.clientX > rect.right - AUTO_SCROLL_EDGE) {
    dir = 1;
    closeness = (drag.clientX - (rect.right - AUTO_SCROLL_EDGE)) / AUTO_SCROLL_EDGE;
  }
  drag.autoDir = dir;
  drag.autoSpeed = 5 + 22 * Math.max(0, Math.min(1, closeness));
  if (dir && !drag.autoRaf) drag.autoRaf = requestAnimationFrame(autoScrollTick);
}

function autoScrollTick() {
  const drag = clipDrag;
  const lanes = el('trackLanes');
  if (!drag || !drag.started || !lanes) {
    if (drag) drag.autoRaf = 0;
    return;
  }
  drag.autoRaf = 0;
  if (!drag.autoDir) return;
  const before = lanes.scrollLeft;
  lanes.scrollLeft = before + drag.autoDir * drag.autoSpeed;
  const delta = lanes.scrollLeft - before;
  if (delta !== 0) {
    // 让指针相对内容的位置保持不变，片段才会稳稳跟着鼠标
    drag.startX -= delta;
    applyClipDrag();
    drawWaveform(playRatio());
    updateWaveHead();
  }
  drag.autoRaf = requestAnimationFrame(autoScrollTick);
}

function onClipPointerUp(ev) {
  const drag = clipDrag;
  if (!drag || ev.pointerId !== drag.pointerId) return;
  const started = drag.started;
  const mode = drag.mode;
  const key = drag.key;

  if (drag.autoRaf) cancelAnimationFrame(drag.autoRaf);
  drag.clip.classList.remove('trimming', 'moving', 'pressing', 'edge-hit', 'edge-left', 'edge-right');
  drag.clip.querySelectorAll('.clip-edge').forEach((node) => node.classList.remove('active'));
  document.body.classList.remove('clip-dragging-trim', 'clip-dragging-move');
  showSnapLine(null);
  highlightCueSnap(null, -1);
  const tip = el('trimTip');
  if (tip) tip.classList.remove('show');
  try { drag.clip.releasePointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
  clipDrag = null;
  if (!started) return;         // 纯点击：交给原有的播放头定位逻辑

  lastClipDragAt = performance.now();
  if (!drag.dirty) return;      // 按了把手但没真正拖动：不改数据也不提示
  saveClipLayout();
  const span = clipLayout[key];
  renderTimeline();
  pushStage();                  // 片段起止变了：预览里素材的出现区间同步更新
  if (mode === 'move') {
    toast('已移动片段到 ' + fmtTimecode(span ? span.start : 0, FRAME_RATE) + '（方向键可逐帧微调）', 'ok');
  } else {
    toast('已裁剪 · 时长 ' + (span ? (span.end - span.start).toFixed(2) : '0.00')
      + 's · 源入点 ' + fmtTimecode(span ? span.srcIn : 0, FRAME_RATE), 'ok');
  }
}

/* ---------------- 素材框选（在时间轴空白处按住左键拖动，选中扫过的素材片段） ---------------- */

function onLanesPointerDown(ev) {
  if (ev.button !== 0 || clipDrag || marquee) return;
  if (!project) return;
  if (ev.target && ev.target.closest && ev.target.closest('.clip, .cue-block, .audio-seg')) return;  // 片段 / 歌词块 / 音频段内按下走各自逻辑
  // 从歌词轨起手：框选歌词行；其它区域起手：框选素材片段
  const track = ev.target && ev.target.closest && ev.target.closest('.lane-sub') ? 'cue' : 'media';
  if (track === 'cue') {
    if (!cues.length) return;
  } else if (duration() <= 0 || !mediaList().length) {
    return;
  }
  const additive = !!(ev.ctrlKey || ev.metaKey || ev.shiftKey);
  marquee = {
    pointerId: ev.pointerId,
    track: track,
    startX: ev.clientX,
    startY: ev.clientY,
    clientX: ev.clientX,
    clientY: ev.clientY,
    base: additive ? (track === 'cue' ? selectedCueIndexes.slice() : selectedMediaIds.slice()) : [],
    started: false,
    hits: [],
    autoDir: 0,
    autoSpeed: 0,
    autoRaf: 0,
  };
}

function marqueeRect() {
  const m = marquee;
  const left = Math.min(m.startX, m.clientX);
  const top = Math.min(m.startY, m.clientY);
  const right = Math.max(m.startX, m.clientX);
  const bottom = Math.max(m.startY, m.clientY);
  return { left: left, top: top, right: right, bottom: bottom };
}

function onMarqueePointerMove(ev) {
  if (!marquee || ev.pointerId !== marquee.pointerId) return;
  marquee.clientX = ev.clientX;
  marquee.clientY = ev.clientY;
  if (!marquee.started) {
    const dx = ev.clientX - marquee.startX;
    const dy = ev.clientY - marquee.startY;
    if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    marquee.started = true;                 // 超过阈值才算框选，空白单击仍保留原有点击行为
    document.body.classList.add('marquee-active');
    const box = el('selectBox');
    if (box) box.classList.remove('hidden');
  }
  if (ev.preventDefault) ev.preventDefault();
  updateMarquee();
  updateMarqueeAutoScroll();
}

/** 实时绘制选择框，并把与框相交的片段高亮出来（松手后才提交选中） */
function updateMarquee() {
  if (!marquee || !marquee.started) return;
  const rect = marqueeRect();
  const box = el('selectBox');
  if (box) {
    box.style.left = Math.round(rect.left) + 'px';
    box.style.top = Math.round(rect.top) + 'px';
    box.style.width = Math.round(rect.right - rect.left) + 'px';
    box.style.height = Math.round(rect.bottom - rect.top) + 'px';
  }
  const merged = marquee.base.slice();
  const isCue = marquee.track === 'cue';
  const selector = isCue ? '#laneSub .cue-block' : '#laneMedia .clip';
  document.querySelectorAll(selector).forEach((node, index) => {
    const r = node.getBoundingClientRect();
    if (r.right < rect.left || r.left > rect.right || r.bottom < rect.top || r.top > rect.bottom) return;
    if (isCue) {
      if (!merged.includes(index)) merged.push(index);
    } else {
      const key = node.dataset.mediaId;
      if (key && !merged.includes(key)) merged.push(key);
    }
  });
  marquee.hits = merged;
  if (isCue) {
    paintCueHighlight(merged);
  } else {
    paintClipHighlight(merged);
  }
  const left = el('statusLeft');
  if (left) {
    const what = isCue ? '行歌词' : '段素材';
    left.textContent = merged.length
      ? '框选中：已扫过 ' + merged.length + ' ' + what + '（松开生效 · 按住 Ctrl 追加）'
      : '框选中：拖动扫过' + (isCue ? '歌词块' : '素材片段') + '即可多选';
  }
}

/** 结束框选会话：commit=true 提交选中（正常松手），false 只清理（窗口失焦 / 取消 / 异常残留） */
function endMarquee(commit) {
  const m = marquee;
  if (!m) return;
  marquee = null;
  if (m.autoRaf) cancelAnimationFrame(m.autoRaf);
  document.body.classList.remove('marquee-active');
  const box = el('selectBox');
  if (box) box.classList.add('hidden');
  if (!m.started) return;                   // 只是空白单击：交给原有 click 逻辑定位播放头
  if (!commit) {                            // 取消：把拖动中的预览高亮复原成已提交的选中状态
    paintClipHighlight(selectedMediaIds);
    paintCueHighlight(selectedCueIndexes);
    updateStatusBar();
    return;
  }
  lastMarqueeAt = performance.now();        // 吞掉框选结束的尾随 click
  if (m.track === 'cue') {
    setCueSelection(m.hits);
    paintCueHighlight(selectedCueIndexes);  // 与最终状态对齐（选中集合未变化时也能复原预览）
    updateStatusBar();
    if (m.hits.length > 1) toast('已选中 ' + m.hits.length + ' 行歌词（退格批量删除 · Ctrl+C 复制）', 'ok');
    return;
  }
  setMediaSelection(m.hits);
  paintClipHighlight(selectedMediaIds);     // 与最终状态对齐（选中集合未变化时也能复原预览）
  updateStatusBar();
  if (m.hits.length > 1) {
    toast('已框选 ' + m.hits.length + ' 段素材（方向键整体移动 · 退格批量删除）', 'ok');
  } else if (m.hits.length === 1) {
    toast('已选中 1 段素材（Ctrl 拖动可追加框选）', 'ok');
  }
}

function onMarqueePointerUp(ev) {
  if (!marquee) return;
  // pointerId 不一致（指针在窗口外释放等）时同样结束会话，避免残留导致后续框选失效
  endMarquee(!!ev && ev.pointerId === marquee.pointerId);
}

/** 框选拖到时间轴视口边缘时自动滚动 */
function updateMarqueeAutoScroll() {
  const lanes = el('trackLanes');
  if (!marquee || !marquee.started || !lanes) return;
  const rect = lanes.getBoundingClientRect();
  let dir = 0;
  let closeness = 0;
  if (marquee.clientX < rect.left + AUTO_SCROLL_EDGE) {
    dir = -1;
    closeness = (rect.left + AUTO_SCROLL_EDGE - marquee.clientX) / AUTO_SCROLL_EDGE;
  } else if (marquee.clientX > rect.right - AUTO_SCROLL_EDGE) {
    dir = 1;
    closeness = (marquee.clientX - (rect.right - AUTO_SCROLL_EDGE)) / AUTO_SCROLL_EDGE;
  }
  marquee.autoDir = dir;
  marquee.autoSpeed = 5 + 22 * Math.max(0, Math.min(1, closeness));
  if (dir && !marquee.autoRaf) marquee.autoRaf = requestAnimationFrame(marqueeScrollTick);
}

function marqueeScrollTick() {
  const lanes = el('trackLanes');
  if (!marquee || !marquee.started || !lanes) {
    if (marquee) marquee.autoRaf = 0;
    return;
  }
  marquee.autoRaf = 0;
  if (!marquee.autoDir) return;
  const before = lanes.scrollLeft;
  lanes.scrollLeft = before + marquee.autoDir * marquee.autoSpeed;
  if (lanes.scrollLeft !== before) {
    drawWaveform(playRatio());
    updateWaveHead();
    updateMarquee();                        // 内容滚动了：按片段最新位置重算命中
  }
  marquee.autoRaf = requestAnimationFrame(marqueeScrollTick);
}

/** 逐帧微调只重绘被改动的片段，连续按键才够顺；稍后再整体重排一次 */
let nudgeRefreshTimer = null;

function scheduleTimelineRefresh() {
  if (nudgeRefreshTimer) clearTimeout(nudgeRefreshTimer);
  nudgeRefreshTimer = setTimeout(() => {
    nudgeRefreshTimer = null;
    renderTimeline();
    pushStage();
  }, 200);
}

/** 微调后只重绘单个片段（保持跟手） */
function repaintClip(key, span) {
  const clip = document.querySelector('#laneMedia .clip[data-media-id="' + key + '"]');
  if (!clip || !span) return;
  if (span.custom) clip.classList.add('trimmed');
  paintClipSpan(clip, span);
}

/**
 * 选中片段的逐帧微调：←/→ 移动 1 帧（Shift 10 帧 · Alt 裁左 · Ctrl 裁右）
 * 框选多段时：整体平移并做整体边界约束（Alt/Ctrl 裁剪仅在单选时生效）
 */
function nudgeSelectedClip(ev) {
  const ids = selectedMediaIds.slice();
  if (!ids.length || duration() <= 0) return false;
  const total = duration();
  const step = (ev.shiftKey ? 10 : 1) * FRAME_SEC * (ev.key === 'ArrowRight' ? 1 : -1);
  freezeLayout();
  pushUndo('微调片段');              // 连续微调由 pushUndo 内部合并成一步

  // 单选 + Alt/Ctrl：逐帧裁剪入点 / 出点
  if (ids.length === 1 && (ev.altKey || ev.ctrlKey)) {
    const key = ids[0];
    const media = clipMedia(clipMediaId(key));   // 片段键可能是分割片段，需经素材 id 查找
    const span = clipLayout[key];
    if (!media || !span) return false;
    const srcDur = media.duration || 0;
    if (ev.altKey) {
      const minStart = srcDur > 0 ? Math.max(0, span.start - span.srcIn) : 0;
      const next = clampTime(snapToFrame(span.start + step), minStart, span.end - MIN_CLIP_SEC);
      span.srcIn = srcDur > 0 ? Math.max(0, span.srcIn + (next - span.start)) : 0;
      span.start = next;
    } else {
      let maxEnd = total;
      if (srcDur > 0) maxEnd = Math.min(total, span.start + Math.max(MIN_CLIP_SEC, srcDur - span.srcIn));
      span.end = clampTime(snapToFrame(span.end + step), span.start + MIN_CLIP_SEC, maxEnd);
    }
    span.custom = true;
    saveClipLayout();
    repaintClip(key, span);
    updateStatusBar();
    scheduleTimelineRefresh();
    return true;
  }

  // 移动：单选逐帧；多选保持相对位置整体平移
  const spans = ids.map((id) => clipLayout[id]).filter(Boolean);
  if (!spans.length) return false;
  const minStart = Math.min.apply(null, spans.map((s) => s.start));
  const maxEnd = Math.max.apply(null, spans.map((s) => s.end));
  const anchor = snapToFrame(minStart + step);
  const delta = Math.max(-minStart, Math.min(anchor - minStart, total - maxEnd));
  ids.forEach((id) => {
    const span = clipLayout[id];
    if (!span) return;
    span.start += delta;
    span.end += delta;
    span.custom = true;
    repaintClip(id, span);
  });
  saveClipLayout();
  updateStatusBar();
  scheduleTimelineRefresh();
  return true;
}

/* ---------------- 分割（把一段切成两段） ---------------- */

/** 客户端 X 坐标 → 时间轴上的时间（秒）；不在时间轴横向范围内返回 null */
function timeAtClientX(clientX) {
  const lanes = el('trackLanes');
  const total = duration();
  if (!lanes || total <= 0) return null;
  const rect = lanes.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right) return null;
  const x = clientX - rect.left + lanes.scrollLeft;
  return Math.max(0, Math.min(total, x / Math.max(1, pxPerSecond)));
}

/**
 * Ctrl+B 将会分割音频还是素材（切点预览线的颜色也用它）：
 * - 光标在音频轨 → 分音频；光标在素材轨 → 有素材分素材、没素材就分音频
 * - 光标不在轨道上：选中了音频段 → 分音频；素材轨为空 → 分音频；否则分素材
 */
function wouldSplitAudio() {
  if (hoverTrack === 'audio') return true;
  if (hoverTrack === 'media') return mediaList().length === 0;
  if (selectedAudioSeg) return true;
  return mediaList().length === 0;
}

/** 切点预览线：按住 Ctrl 时光标处显示竖向亮线（金色=将分素材，青色=将分音频） */
function refreshCutPreview() {
  const preview = el('cutPreview');
  if (!preview) return;
  const show = ctrlHeld && hoverSplitTime != null && !clipDrag && !marquee;
  preview.classList.toggle('show', show);
  preview.classList.toggle('audio', show && wouldSplitAudio());
  if (show) preview.style.left = Math.round(hoverSplitTime * Math.max(1, pxPerSecond)) + 'px';
}

/**
 * 把片段剪开成两段（Ctrl+B / 片段上的 ✂ / 工具栏「✂ 分割」）：
 * - 播放头可停在任意位置：片段内按播放头切；片段外不再要求先移动播放头，就近取合法切点
 * - 左段保留原键与原源入点；右段用新键，源入点顺延（视频接着往下播）
 * - 两段各自独立裁剪 / 移动 / 删除，导出与预览按同一套片段映射
 */
/** 距某时间点最近的片段（播放头不在任何片段内时，作为就近分割的目标） */
function nearestClip(clips, t) {
  let best = null;
  clips.forEach((c) => {
    if (c.span.end - c.span.start < MIN_CLIP_SEC * 2 - 1e-6) return;   // 不足 2 帧的碎片没法再分割，跳过
    const d = t < c.span.start ? c.span.start - t : (t > c.span.end ? t - c.span.end : 0);
    if (!best || d < best.d) best = { clip: c, d: d };
  });
  return best ? best.clip : null;
}

function splitSelectedClip(forceKey) {
  if (!project || duration() <= 0) return false;
  const clips = clipList();
  if (!clips.length) {
    toast('素材轨还没有片段可分割（先导入素材）· 要分割音频请点金色「✂ 分割音频」，或把鼠标移到音频轨（波形条）上按 Ctrl+B', 'err');
    return false;
  }

  let item = null;
  const key = forceKey || (selectedMediaIds.length ? selectedMediaIds[selectedMediaIds.length - 1] : null);
  if (key) item = clips.find((c) => c.key === key) || null;
  const headTime = Math.max(0, audio.currentTime || 0);
  // 分割点优先取光标所在位置（Ctrl+B 时鼠标通常停在想切的地方）；
  // 片段上的 ✂ 按钮除外——它在片段角上，不代表切点意图
  const t = (!forceKey && hoverSplitTime != null) ? hoverSplitTime : headTime;
  if (!item) {
    // 没有选中片段：优先光标/播放头所在的片段，都不在片段内时取离它最近的片段
    item = clips.find((c) => t > c.span.start && t < c.span.end) || nearestClip(clips, t);
  }
  if (!item) {
    toast('素材片段都太短了（不足 2 帧的碎片无法再分割）：可先用「↺ 重置裁剪」恢复，或重新导入素材', 'err');
    return false;
  }

  const before = item.span;
  if (before.end - before.start < MIN_CLIP_SEC * 2 - 1e-6) {
    toast('「' + item.media.originalName + '」这个片段只有 '
      + (before.end - before.start).toFixed(3) + 's（不足 2 帧），没法再分割'
      + ' · 想分割音频请点「✂ 分割音频」，或把鼠标移到音频轨（波形条）上按 Ctrl+B', 'err');
    return false;
  }
  const lo = before.start + MIN_CLIP_SEC;
  const hi = before.end - MIN_CLIP_SEC;
  // 任何位置的播放头都能分割：片段内按播放头切；片段外就近取合法切点
  // （点片段上的 ✂ 意图明确：播放头不在片段内时从片段中点切开）
  const outside = t < before.start - 1e-6 || t > before.end + 1e-6;
  const anchor = outside ? (forceKey ? (before.start + before.end) / 2 : clampTime(t, lo, hi)) : t;
  let cut = clampTime(snapToFrame(anchor), lo, hi);
  cut = clampTime(snapToFrame(cut), lo, hi);      // 边界非帧对齐时兜一次
  if (Math.abs(cut - t) > 1e-6) {
    // 切点被就近取点或被对齐到帧：播放头同步过去，预览与切割点保持一致
    audio.currentTime = cut;
    updateWaveHead();
    drawWaveform(playRatio());
    seekStage(cut);
  }

  freezeLayout();                    // 固化布局：两段从此互不牵动
  pushUndo('分割片段');
  const span = clipLayout[item.key];
  if (!span) return false;
  const mediaId = String(item.media.id);
  const rightKey = uniqueClipKey(mediaId);
  const leftLength = cut - span.start;
  const rightLength = span.end - cut;

  clipLayout[rightKey] = {
    start: cut,
    end: span.end,
    srcIn: Math.max(0, (span.srcIn || 0) + leftLength),   // 右段接着左段的源位置继续
    custom: true,
    mediaId: mediaId,
  };
  span.end = cut;
  span.srcIn = span.srcIn || 0;
  span.custom = true;
  span.mediaId = mediaId;

  saveClipLayout();
  setMediaSelection([rightKey]);     // 选中右半段，便于继续裁剪 / 移动
  lastSplitCut = { time: cut, at: performance.now() };   // 接缝闪光标记
  renderTimeline();
  pushStage();
  toast('已分割：左 ' + leftLength.toFixed(2) + 's / 右 ' + rightLength.toFixed(2) + 's'
    + '（切点 ' + fmtTimecode(cut, FRAME_RATE) + ' · 两段可分别裁剪移动'
    + (outside ? ' · 播放头不在片段内，已就近取切点' : '') + '）', 'ok');
  return true;
}

/** 重置本工程的裁剪：恢复"均匀铺满" */
function resetClipLayout() {
  pushUndo('重置裁剪');
  clipLayout = {};
  layoutFrozen = false;
  if (layoutProjectId) {
    try { localStorage.removeItem(layoutStoreKey(layoutProjectId)); } catch (err) { /* ignore */ }
  }
  selectedMediaIds = [];
  renderTimeline();
  pushStage();
  showSnapLine(null);
  toast('已重置素材裁剪（恢复均匀铺满）', 'ok');
}

/* ================= 时间轴撤销（Ctrl+Z） ================= */

/**
 * 撤销栈：每次可撤销操作前记录一份快照（素材片段布局 + 音频分段）。
 * 覆盖范围：素材的分割 / 裁剪 / 移动 / 微调 / 移除片段 / 重置裁剪，
 * 音频的分割、音频段删除（物理裁剪，撤销时自动调后端 undo-cut 换回音频与歌词）。
 * 素材上传、素材文件删除、歌词编辑不在范围内（涉及后端数据）。
 * 栈上限 40 步，切换工程自动清空。
 */

function pushUndo(label) {
  if (!project) return;
  if (undoStackProjectId !== project.id) {
    undoStack = [];
    undoStackProjectId = project.id;
  }
  const top = undoStack[undoStack.length - 1];
  // 连续同类操作（如按住方向键逐帧微调）合并为一步，避免刷爆栈
  if (top && top.label === label && !top.audioCut && performance.now() - top.at < 1200) return;
  undoStack.push({
    label: label,
    at: performance.now(),
    audioCut: false,
    clipLayout: JSON.parse(JSON.stringify(clipLayout)),
    layoutFrozen: layoutFrozen,
    audioSegments: JSON.parse(JSON.stringify(audioSegments)),
  });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

/** 音频段删除（物理裁剪）成功后压入特殊快照：撤销时要先让后端换回音频文件 */
function pushUndoAudioCut(prevClips, prevSegments) {
  if (!project) return;
  if (undoStackProjectId !== project.id) {
    undoStack = [];
    undoStackProjectId = project.id;
  }
  undoStack.push({
    label: '删除音频段',
    at: performance.now(),
    audioCut: true,
    clipLayout: prevClips,
    layoutFrozen: layoutFrozen,
    audioSegments: prevSegments,
  });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

async function undoLastAction() {
  if (!project) return false;
  if (audioBusy) { toast('上一次音频处理还在进行，请稍候…', 'err'); return false; }
  if (undoStackProjectId !== project.id || !undoStack.length) {
    toast('没有可撤销的操作（支持：分割 / 裁剪 / 移动 / 移除片段、音频分割与删除段）', 'err');
    return false;
  }
  const item = undoStack.pop();
  try {
    if (item.audioCut) {
      audioBusy = true;
      setProgress(0.04, '正在还原音频（Ctrl+Z）：后端 ffmpeg 重新编码整首歌，请稍候…');
    }
    clipLayout = JSON.parse(JSON.stringify(item.clipLayout || {}));
    layoutFrozen = !!item.layoutFrozen;
    audioSegments = JSON.parse(JSON.stringify(item.audioSegments || []));
    selectedMediaIds = [];
    selectedAudioSeg = null;
    saveClipLayout();
    saveAudioSegments();                     // 先落盘：audioCut 时 selectProject 会从 localStorage 读回
    if (item.audioCut) {
      await revertAudioCut();                // 换回音频文件；波形能复用则拼接
      setProgress(1, '音频已还原');
    } else {
      renderTimeline();
      pushStage();
      updateStatusBar();
    }
    showSnapLine(null);
    toast('已撤销：' + item.label + '（可继续 Ctrl+Z）', 'ok');
    return true;
  } catch (err) {
    toast('撤销失败：' + err.message, 'err');
    return false;
  } finally {
    audioBusy = false;
  }
}

/* ================= 音频片段（分割 / 删除 / 撤销） ================= */

/**
 * 音频分段：把整首歌切成若干段，用来删掉不要的部分（前奏、口白、重复段…）。
 * - 分割只标记切点（波形轨上可见），不动音频文件；不删除则导出不变
 * - 「删除选中段」才真正裁剪：调用既有后端接口 /media/audio/cut（物理裁剪 + 歌词平移，可撤销一步）
 * - 分段数据只存本机 localStorage，与素材片段一样不进工程文件
 */
function audioSegStoreKey(id) {
  return 'ktv:audio-segments:' + id;
}

function loadAudioSegments(id) {
  audioSegments = [];
  selectedAudioSeg = null;
  audioSegBackup = null;
  audioSegProjectId = id || null;
  if (!id) return;
  let raw = null;
  try { raw = localStorage.getItem(audioSegStoreKey(id)); } catch (err) { raw = null; }
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    const list = data && Array.isArray(data.segments) ? data.segments : [];
    list.forEach((item, index) => {
      if (item && isFinite(item.start) && isFinite(item.end) && item.end > item.start) {
        audioSegments.push({
          key: item.key ? String(item.key) : 'a' + index,
          start: Number(item.start),
          end: Number(item.end),
        });
      }
    });
    audioSegments.sort((a, b) => a.start - b.start);
    if (data && Array.isArray(data.backup)) {
      audioSegBackup = data.backup
        .filter((item) => item && isFinite(item.start) && isFinite(item.end) && item.end > item.start)
        .map((item) => ({ key: String(item.key || ''), start: Number(item.start), end: Number(item.end) }));
    }
  } catch (err) {
    audioSegments = [];
    audioSegBackup = null;
  }
}

function saveAudioSegments() {
  if (!audioSegProjectId) return;
  try {
    localStorage.setItem(audioSegStoreKey(audioSegProjectId), JSON.stringify({
      segments: audioSegments,
      backup: audioSegBackup,
    }));
  } catch (err) { /* 存储不可用时静默，不影响操作 */ }
}

/** 分段缺省：整首歌一段；音频时长变化（裁剪 / 撤销）后把首尾对齐到有效范围 */
function ensureAudioSegments() {
  const total = duration();
  if (!total) { audioSegments = []; selectedAudioSeg = null; return; }
  if (!audioSegments.length) {
    audioSegments = [{ key: 'a-full', start: 0, end: total }];
    saveAudioSegments();
    return;
  }
  audioSegments.sort((a, b) => a.start - b.start);
  audioSegments[0].start = 0;
  audioSegments[audioSegments.length - 1].end = total;
}

function uniqueAudioSegKey() {
  let key = '';
  do {
    key = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  } while (audioSegments.some((seg) => seg.key === key));
  return key;
}

/** 只刷新段块高亮（不重建 DOM） */
function paintAudioSegSelection() {
  const lane = el('laneWave');
  if (!lane) return;
  lane.querySelectorAll('.audio-seg').forEach((box) => {
    box.classList.toggle('selected', box.dataset.segKey === selectedAudioSeg);
  });
}

function selectAudioSeg(key) {
  selectedAudioSeg = key === selectedAudioSeg ? null : key;   // 再点一次取消
  if (selectedAudioSeg) {
    if (selectedMediaIds.length) setMediaSelection([]);       // 与素材 / 歌词选中互斥
    if (selectedCueIndexes.length) {
      selectedCueIndexes = [];
      paintCueHighlight([]);
      paintCuePanelHighlight();
    }
  }
  paintAudioSegSelection();
  updateStatusBar();
}

function clearAudioSegSelection() {
  if (!selectedAudioSeg) return;
  selectedAudioSeg = null;
  paintAudioSegSelection();
  updateStatusBar();
}

/** 音频轨分段块 + 切痕：内容坐标渲染，随缩放重建（与素材片段一致） */
function renderAudioSegments() {
  const lane = el('laneWave');
  if (!lane) return;
  lane.querySelectorAll('.audio-seg, .cut-mark').forEach((node) => node.remove());
  if (!project || !project.audio) { audioSegments = []; selectedAudioSeg = null; return; }
  ensureAudioSegments();
  const perSec = Math.max(1, pxPerSecond);
  const label = el('waveClipLabel');            // 歌曲信息胶囊保持在最上层（段块插到它前面）
  const anchor = label || null;
  audioSegments.forEach((seg, index) => {
    const widthPx = Math.round((seg.end - seg.start) * perSec);
    const box = document.createElement('div');
    box.className = 'audio-seg' + (seg.key === selectedAudioSeg ? ' selected' : '');
    box.dataset.segKey = seg.key;
    box.style.left = Math.round(seg.start * perSec) + 'px';
    box.style.width = Math.max(2, widthPx - 4) + 'px';   // 段间留 4px 断开缝隙
    box.title = '音频第 ' + (index + 1) + ' / ' + audioSegments.length + ' 段 · '
      + fmtTimecode(seg.start, FRAME_RATE) + ' → ' + fmtTimecode(seg.end, FRAME_RATE)
      + '（' + (seg.end - seg.start).toFixed(2) + 's）· 单击选中 · Delete 删除（物理裁剪，可撤销）';
    if (widthPx >= 40) {                        // 够宽才显示段号
      const name = document.createElement('span');
      name.className = 'audio-seg-name';
      name.textContent = String(index + 1);
      box.appendChild(name);
    }
    const del = document.createElement('span');
    del.className = 'audio-seg-del';
    del.textContent = '✕';
    del.title = '删除这一段音频（物理裁剪音频文件并平移歌词，可用「↶ 音频撤销」恢复）';
    del.onclick = (e) => {
      e.stopPropagation();
      selectedAudioSeg = seg.key;
      paintAudioSegSelection();
      deleteSelectedAudioSeg();
    };
    box.appendChild(del);
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      selectAudioSeg(seg.key);
    });
    if (anchor) lane.insertBefore(box, anchor); else lane.appendChild(box);

    // 段之间的分割切痕：青色加粗亮线（橙色波形上比金色醒目得多），刚切开的会闪一下
    if (index > 0) {
      const mark = document.createElement('div');
      mark.className = 'cut-mark audio';
      if (lastAudioCut
        && Math.abs(lastAudioCut.time - seg.start) < FRAME_SEC * 0.5
        && performance.now() - lastAudioCut.at < 1500) {
        mark.classList.add('fresh');
      }
      mark.style.left = Math.max(0, Math.round(seg.start * perSec) - 4) + 'px';
      mark.title = '音频分割切痕 · ' + fmtTimecode(seg.start, FRAME_RATE);
      if (anchor) lane.insertBefore(mark, anchor); else lane.appendChild(mark);
    }
  });
}

/**
 * 在切点处把音频切开成两段：
 * - 音频轨上按 Ctrl+B：以光标位置为切点（与素材分割同一套“光标在哪就从哪切”的规则）
 * - 工具栏「✂ 分割音频」：t 传 null，按播放头位置切
 */
function splitAudioAt(t) {
  if (!project || !project.audio) { toast('请先导入歌曲音频', 'err'); return false; }
  const total = duration();
  if (total <= 0) return false;
  ensureAudioSegments();
  const headTime = Math.max(0, audio.currentTime || 0);
  const cutTime = (t == null) ? headTime : Math.max(0, Math.min(total, t));
  let index = audioSegments.findIndex((seg) => cutTime > seg.start + 1e-6 && cutTime < seg.end - 1e-6);
  if (index < 0) {
    // 切点不在任何段内（音频轨铺满整曲，一般不会发生）：取最近的段
    let bestD = Infinity;
    audioSegments.forEach((seg, i) => {
      const d = cutTime < seg.start ? seg.start - cutTime : (cutTime > seg.end ? cutTime - seg.end : 0);
      if (d < bestD) { bestD = d; index = i; }
    });
  }
  const seg = audioSegments[index];
  if (!seg) return false;
  const lo = seg.start + MIN_CLIP_SEC;
  const hi = seg.end - MIN_CLIP_SEC;
  if (hi < lo - 1e-9) {
    toast('音频第 ' + (index + 1) + ' 段太短（' + (seg.end - seg.start).toFixed(3)
      + 's），没法再分割（每段至少 1 帧）', 'err');
    return false;
  }
  let cut = clampTime(snapToFrame(cutTime), lo, hi);
  cut = clampTime(snapToFrame(cut), lo, hi);      // 边界非帧对齐时兜一次
  if (cut <= seg.start + 1e-9 || cut >= seg.end - 1e-9) {
    toast('切点太靠近段边界（每段至少 1 帧）', 'err');
    return false;
  }
  pushUndo('分割音频');
  audioSegments.splice(index + 1, 0, { key: uniqueAudioSegKey(), start: cut, end: seg.end });
  seg.end = cut;
  selectedAudioSeg = null;
  lastAudioCut = { time: cut, at: performance.now() };   // 接缝闪光标记
  saveAudioSegments();
  if (Math.abs(cut - headTime) > 1e-6) {          // 按光标切时把播放头同步过去
    audio.currentTime = cut;
    updateWaveHead();
    drawWaveform(playRatio());
    seekStage(cut);
  }
  renderTimeline();
  toast('已分割音频：切点 ' + fmtTimecode(cut, FRAME_RATE)
    + ' · 共 ' + audioSegments.length + ' 段（单击段选中，Delete 可真正删掉）', 'ok');
  return true;
}

/**
 * 删除选中音频段：调用既有后端接口做物理裁剪（音轨变短 + 歌词平移），可撤销一步。
 * 走 window.confirm 明确二次确认，避免误删。
 */
async function deleteSelectedAudioSeg() {
  if (!project || !project.audio) return false;
  if (audioBusy) { toast('上一次音频处理还在进行，请稍候…', 'err'); return false; }
  ensureAudioSegments();
  const index = audioSegments.findIndex((seg) => seg.key === selectedAudioSeg);
  if (index < 0) {
    toast('先单击音频段选中它，再按 Delete 删除', 'err');
    return false;
  }
  if (audioSegments.length < 2) {
    toast('整首歌只有一段：先用「✂ 分割音频」（或音频轨上 Ctrl+B）切开，再删除不要的段', 'err');
    return false;
  }
  const seg = audioSegments[index];
  const len = seg.end - seg.start;
  if (len < 0.2) { toast('要删除的区间太短（后端至少 0.2 秒）', 'err'); return false; }
  if (duration() - len < 0.5) { toast('删除后剩余音频不足 0.5 秒，已取消', 'err'); return false; }

  const name = '第 ' + (index + 1) + ' 段 ' + fmtTime(seg.start) + ' → ' + fmtTime(seg.end)
    + '（' + len.toFixed(2) + 's）';
  if (!window.confirm('删除音频 ' + name + '？\n\n'
    + '· 将物理裁剪音频文件，并同步平移歌词（落在区间内的歌词行整行删除）\n'
    + '· 后端需要重新编码整首歌，通常需要十几秒，期间请勿重复操作\n'
    + '· 完成后可用 Ctrl+Z 或工具栏「↶ 音频撤销」恢复一步\n\n确认删除？')) {
    return false;
  }
  audioBusy = true;
  setProgress(0.04, '正在裁剪音频：后端 ffmpeg 重新编码整首歌，请稍候（通常十几秒）…');
  try {
    const prevTotal = duration();
    await api('POST', '/api/projects/' + project.id + '/media/audio/cut', { start: seg.start, end: seg.end });
    // 波形就地拼接（省去重新下载 + 解码整首歌），失败则回退重建
    audioCutWaveBackup = spliceWaveformAfterCut(seg.start, seg.end, prevTotal);
    // Ctrl+Z 快照（删除前的素材布局与音频分段）：撤销时先调后端 undo-cut 换回音频再恢复这份状态
    pushUndoAudioCut(
      JSON.parse(JSON.stringify(clipLayout)),
      audioSegments.map((item) => ({ key: item.key, start: item.start, end: item.end }))
    );
    audioSegBackup = audioSegments.map((item) => ({ key: item.key, start: item.start, end: item.end }));
    audioSegments.splice(index, 1);
    audioSegments.forEach((item, i) => {
      if (i >= index) { item.start = Math.max(0, item.start - len); item.end = Math.max(0, item.end - len); }
    });
    selectedAudioSeg = null;
    saveAudioSegments();
    await selectProject(project.id, { keepWaveform: !!audioCutWaveBackup });   // 跳过重建波形
    clampClipLayoutToDuration();              // 素材片段不越过新的歌尾
    setProgress(1, '音频裁剪完成');
    toast('已删除音频 ' + name + '（可用 Ctrl+Z 或「↶ 音频撤销」恢复）', 'ok');
    return true;
  } catch (err) {
    setProgress(0, '音频裁剪失败');
    toast('删除音频失败：' + err.message, 'err');
    return false;
  } finally {
    audioBusy = false;
  }
}

/** 撤销音频物理裁剪：换回上一份音频与歌词；波形能复用则就地拼接，否则回退重建 */
async function revertAudioCut() {
  const res = await api('POST', '/api/projects/' + project.id + '/media/audio/undo-cut');
  const restored = res && res.project ? res.project.audio : null;
  let totalAfter = restored && restored.duration ? restored.duration : 0;
  if (!totalAfter && audioCutWaveBackup) {
    totalAfter = duration() + (audioCutWaveBackup.end - audioCutWaveBackup.start);
  }
  const reused = audioCutWaveBackup ? mergeWaveformBackAfterUndo(audioCutWaveBackup, totalAfter) : false;
  if (reused) audioCutWaveBackup = null;
  await selectProject(project.id, { keepWaveform: reused });
  return true;
}

/** 撤销上一步音频裁剪：恢复音频文件与歌词（分段快照一并还原） */
async function undoAudioCut() {
  if (!project) return false;
  if (audioBusy) { toast('上一次音频处理还在进行，请稍候…', 'err'); return false; }
  if (!window.confirm('撤销上一步音频裁剪？\n\n音频文件与歌词将恢复到裁剪前，音频分段标记也会一并还原。')) {
    return false;
  }
  if (audioSegBackup) {
    audioSegments = audioSegBackup.map((item) => ({ key: item.key, start: item.start, end: item.end }));
    audioSegBackup = null;
  } else {
    audioSegments = [];
  }
  selectedAudioSeg = null;
  saveAudioSegments();                       // 先落盘：selectProject 会从 localStorage 读回
  audioBusy = true;
  setProgress(0.04, '正在还原音频：后端 ffmpeg 重新编码整首歌，请稍候…');
  try {
    await revertAudioCut();
    setProgress(1, '音频已还原');
    toast('已撤销音频裁剪：音频与歌词已恢复', 'ok');
    return true;
  } catch (err) {
    setProgress(0, '撤销失败');
    toast('撤销失败：' + err.message, 'err');
    return false;
  } finally {
    audioBusy = false;
  }
}

/** 音频裁剪后总时长变短：素材片段越界的部分压回歌尾，放不下的直接丢弃 */
function clampClipLayoutToDuration() {
  const total = duration();
  if (!total) return;
  let changed = false;
  Object.keys(clipLayout).forEach((key) => {
    const span = clipLayout[key];
    if (!span) return;
    if (span.start >= total - 1e-6) {
      delete clipLayout[key];
      changed = true;
      return;
    }
    if (span.end > total) {
      if (total - span.start < MIN_CLIP_SEC) delete clipLayout[key];
      else span.end = total;
      changed = true;
    }
  });
  if (changed) {
    saveClipLayout();
    renderTimeline();
    pushStage();
  }
}

/* ================= 语音识别模型（首次使用下载，模型不进安装包） ================= */

let modelGateDismissed = false;      // 点过「稍后再说」后，本次启动不再自动弹

/** 顶部「识别器」徽标：实时反映 ffmpeg / 识别器（含模型）状态 */
async function refreshToolBadge() {
  const badge = el('toolStatus');
  try {
    const tools = await api('GET', '/api/system/tools');
    if (!badge) return;
    if (tools.ffmpegReady && tools.whisperReady) {
      badge.textContent = '本机识别器就绪 · ' + (tools.whisperBackend || '');
      badge.className = 'badge badge-ok';
    } else {
      badge.textContent = '缺少：' + (!tools.ffmpegReady ? 'ffmpeg ' : '') + (!tools.whisperReady ? '识别器' : '');
      badge.className = 'badge badge-err';
    }
  } catch (err) {
    if (badge) { badge.textContent = '后端未启动'; badge.className = 'badge badge-err'; }
  }
}

function fmtMB(bytes) {
  return (bytes / 1048576).toFixed(0) + ' MB';
}

/** 模型状态 → 面板（文案 / 进度条 / 按钮） */
function renderModelGate(st) {
  if (!st) return;
  const bar = el('modelProgressBar');
  const meta = el('modelGateMeta');
  const start = el('btnModelStart');
  const hint = el('modelGateHint');
  if (st.ready) {
    if (bar) bar.style.width = '100%';
    if (meta) meta.textContent = '模型已就绪（' + fmtMB(st.size) + '）';
    if (start) { start.textContent = '已完成'; start.disabled = true; }
    if (hint) hint.textContent = '';
    return;
  }
  if (st.downloading) {
    const pct = st.total ? Math.min(100, (st.downloaded / st.total) * 100) : 0;
    if (bar) bar.style.width = pct.toFixed(1) + '%';
    if (meta) {
      meta.textContent = '正在下载 ' + fmtMB(st.downloaded)
        + (st.total ? ' / ' + fmtMB(st.total) + '（' + pct.toFixed(0) + '%）' : '…');
    }
    if (start) { start.textContent = '下载中…'; start.disabled = true; }
    if (hint) hint.textContent = '下载中断也没关系：已下载部分会保留，重试时自动续传。';
    return;
  }
  if (bar) bar.style.width = (!st.error && st.size > 0) ? Math.min(99, (st.size / 1.55e9) * 100).toFixed(1) + '%' : '0%';
  if (start) {
    start.textContent = st.error ? '重试下载' : (st.size > 0 ? '继续下载' : '开始下载');
    start.disabled = false;
  }
  if (meta) {
    meta.textContent = st.error ? st.error
      : (st.size > 0 ? '已下载 ' + fmtMB(st.size) + '（未完成，可继续）' : '等待开始 · 约 1.5GB');
  }
  if (hint) hint.textContent = '下载一次即可，之后永久离线可用；也可「稍后再说」，先编辑视频。';
}

function showModelGate() {
  const gate = el('modelGate');
  if (gate) gate.classList.remove('hidden');
}

function hideModelGate() {
  const gate = el('modelGate');
  if (gate) gate.classList.add('hidden');
}

/** 查询模型状态；auto=true 且未就绪时自动弹出下载引导（开发模式不引导） */
async function refreshModelGate(auto) {
  if (!(window.ktv && window.ktv.modelStatus)) return null;
  let st = null;
  try { st = await window.ktv.modelStatus(); } catch (err) { return null; }
  if (!st || !st.packaged) return st;
  renderModelGate(st);
  if (st.ready) { hideModelGate(); return st; }
  if (auto && !modelGateDismissed) {
    // 不自动遮挡界面：模型未下载时只在顶部徽标高亮 + 提示一次，
    // 用户点「识别器」徽标再打开下载面板（避免整屏被遮罩盖住、看起来像按钮全是灰的）
    const badge = el('toolStatus');
    if (badge) badge.classList.add('attention');
    toast('语音识别模型未下载（约 1.5GB）：点顶部「识别器」徽标即可下载，也可先编辑视频', 'err');
  }
  return st;
}

function bindModelGate() {
  if (!(window.ktv && window.ktv.modelStatus)) return;
  on('btnModelStart', 'click', async () => {
    const r = await window.ktv.modelDownload();
    if (r && !r.started && r.reason && r.reason !== '模型已就绪') toast(r.reason, 'err');
  });
  on('btnModelLater', 'click', () => { modelGateDismissed = true; hideModelGate(); });
  if (window.ktv.onModelProgress) {
    window.ktv.onModelProgress((st) => {
      renderModelGate(st);
      if (st.done || st.ready) {
        toast('语音识别模型已就绪 ✓', 'ok');
        modelGateDismissed = false;
        setTimeout(hideModelGate, 1200);
        refreshToolBadge();
      }
    });
  }
  // Esc 关闭下载面板（防止遮罩盖住界面时无处可退）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideModelGate();
  });
}

/* ================= 初始化 ================= */

async function init() {
  // 打包运行时后端端口由主进程动态分配：先取真实地址，再发第一个请求
  if (window.ktv && window.ktv.appInfo) {
    try {
      const info = await window.ktv.appInfo();
      if (info && typeof info.backend === 'string' && info.backend) {
        API = info.backend.replace(/\/+$/, '');
      }
    } catch (err) { /* 桥接不可用时沿用默认地址 */ }
  }
  await refreshToolBadge();
  bindModelGate();
  await refreshModelGate(true);       // 打包模式：模型未下载时弹出首次下载引导
  const toolBadge = el('toolStatus');
  if (toolBadge) {
    toolBadge.title = '点击查看语音识别模型状态 / 下载';
    toolBadge.style.cursor = 'pointer';
    toolBadge.addEventListener('click', () => {
      toolBadge.classList.remove('attention');
      refreshModelGate(false);
      showModelGate();
    });
  }

  await loadProjects();
  renderTemplateGrid();
  bindEvents();
  bindStageMessages();
  syncAudioTime();

  // 菜单「撤销上一步」(Ctrl+Z)：主进程转发过来（默认菜单的 Undo 会拦截按键且对页面无效）
  if (window.ktv && window.ktv.onUndo) window.ktv.onUndo(() => { undoLastAction(); });
}

async function loadProjects() {
  const list = await api('GET', '/api/projects');
  if (list.length) {
    await selectProject(project && list.some((p) => p.id === project.id) ? project.id : list[0].id);
  } else {
    project = null;
    cues = [];
    renderAll();
    renderTemplateGrid();
    renderTimeline();
    await buildWaveform(null);
  }
}

async function selectProject(id, options) {
  const keepWaveform = !!(options && options.keepWaveform);
  project = await api('GET', '/api/projects/' + id);
  cues = await api('GET', '/api/projects/' + id + '/subtitles');
  selectedCueIndexes = [];                  // 切工程：歌词行选中作废
  cueOffsetAccum = 0;                       // 口型校正偏移按工程独立，切工程归零
  updateCueOffsetLabel();
  loadClipLayout(id);                       // 切工程时换上对应的裁剪布局
  loadAudioSegments(id);                    // 音频分段也跟着切工程

  const url = project.audio
    ? API + '/api/projects/' + project.id + '/media/files/' + project.audio.fileName
    : null;
  if (url) {
    audio.src = url;
    await new Promise((resolve) => {
      const done = () => resolve();
      audio.addEventListener('loadedmetadata', done, { once: true });
      audio.addEventListener('error', done, { once: true });
      setTimeout(done, 4000);
    });
    if (keepWaveform && wavePeaks && wavePeaks.length) {
      // 音频裁剪 / 撤销：峰值已就地拼接，跳过重新下载与解码整首歌
      lastWaveRatio = -1;
      drawWaveform(playRatio());
    } else {
      buildWaveform(url);
    }
  } else {
    audio.removeAttribute('src');
    buildWaveform(null);
  }
  renderAll();
  renderTemplateGrid();
  fitZoom();
  renderTimeline();
  pushStage();
}

/* ================= 界面渲染 ================= */

function renderAll() {
  const hasProject = !!project;
  const pickAudio = el('btnPickAudio');
  const pickBg = el('btnPickBg');
  const recog = el('btnRecognize');
  if (pickAudio) pickAudio.disabled = !hasProject;
  if (pickBg) pickBg.disabled = !hasProject;
  if (recog) recog.disabled = !hasProject || !project.audio;

  // 歌曲卡片
  const songName = el('songName');
  const songSub = el('songSub');
  const songTag = el('songTag');
  if (project && project.audio) {
    if (songName) songName.textContent = project.audio.originalName;
    if (songSub) songSub.textContent = '时长 ' + (project.audio.duration || 0).toFixed(1) + 's · ' + Math.round(project.audio.size / 1024) + ' KB';
    if (songTag) songTag.textContent = '就绪';
  } else {
    if (songName) songName.textContent = '未导入歌曲';
    if (songSub) songSub.textContent = '主旋律 · 音频概述';
    if (songTag) songTag.textContent = '--';
  }

  // 素材缩略图
  const thumbs = el('mediaThumbs');
  const list = project && project.backgrounds ? project.backgrounds : [];
  if (thumbs) {
    thumbs.innerHTML = '';
    list.slice(0, 6).forEach((media) => {
      const t = document.createElement('div');
      t.className = 'media-thumb';
      const url = API + '/api/projects/' + project.id + '/media/files/' + media.fileName;
      if (media.kind === 'image') {
        t.style.backgroundImage = "url('" + url + "')";
      } else if (media.kind === 'video') {
        const video = document.createElement('video');
        video.src = url;
        video.muted = true;
        video.preload = 'metadata';
        video.style.width = '100%';
        video.style.height = '100%';
        video.style.objectFit = 'cover';
        t.appendChild(video);
      }
      const badge = document.createElement('span');
      badge.className = 'badge-mini';
      badge.textContent = media.kind === 'video' ? '视频' : (media.kind === 'image' ? '图片' : '音频');
      t.appendChild(badge);
      t.title = media.originalName;
      thumbs.appendChild(t);
    });
  }
  setFlag('bgFlag', list.length ? '已导入 ' + list.length + ' 个素材 · 点击预览' : '未导入素材', list.length ? 'done' : '');

  // 字幕状态
  const subReady = project && project.subtitleStatus === 'READY';
  const subFailed = project && project.subtitleStatus === 'FAILED';
  setFlag('flagSub', subReady ? cues.length + ' 行' : (subFailed ? '失败' : '未识别'),
    subReady ? 'done' : (subFailed ? 'err' : ''));
  const countNode = el('cueCount');
  if (countNode) countNode.textContent = cues.length + ' 行';

  // 空状态
  const empty = el('stageEmpty');
  if (empty) {
    const hasContent = cues.length > 0 || list.length > 0 || (project && project.template && project.template.backgroundPreset);
    empty.classList.toggle('hidden', !!hasContent);
  }

  renderCues();
  updateStatusBar();
  drawWaveform(playRatio());
}

function renderCues() {
  const box = el('cueList');
  if (!box) return;
  // 歌词行增删后剔除失效的选中索引
  const kept = selectedCueIndexes.filter((i) => i >= 0 && i < cues.length);
  if (kept.length !== selectedCueIndexes.length) selectedCueIndexes = kept;
  box.innerHTML = '';
  cues.forEach((cue, index) => {
    const item = document.createElement('div');
    item.className = 'cue-item';

    const time = document.createElement('div');
    time.className = 'cue-time';

    const stamp = document.createElement('span');
    stamp.className = 'stamp';
    stamp.textContent = '#' + (index + 1) + ' ' + fmtTime(cue.start) + ' → ' + fmtTime(cue.end);
    stamp.title = '点击重播本句';
    stamp.onclick = () => {
      audio.currentTime = Math.max(0, cue.start - 0.1);
      seekStage(audio.currentTime);
      if (!playing) {
        playing = true;
        const btn = el('btnPlay');
        if (btn) btn.textContent = '❚❚';
        audio.play().catch(() => {});
      }
    };

    const sweep = document.createElement('select');
    sweep.className = 'cue-sweep';
    sweep.title = '扫色方式';
    sweep.innerHTML = '<option value="follow">跟唱</option><option value="even">均匀扫色</option>';
    sweep.value = cue.sweepMode || 'follow';
    sweep.onchange = () => {
      cues[index].sweepMode = sweep.value;
      renderTimeline();
      pushStage();
    };

    time.appendChild(stamp);
    time.appendChild(sweep);

    const remove = document.createElement('span');
    remove.className = 'cue-del';
    remove.textContent = '✕';
    remove.title = '删除本行';
    remove.onclick = (e) => { e.stopPropagation(); removeCue(index); };
    time.appendChild(remove);

    const text = document.createElement('textarea');
    text.className = 'cue-text';
    text.value = cue.text || '';
    text.rows = 1;
    text.oninput = () => {
      cues[index].text = text.value;
      renderTimeline();
      pushStage();
    };
    text.onfocus = () => {
      audio.currentTime = Math.max(0, cue.start - 0.05);
      seekStage(audio.currentTime);
      updateStatusBar();               // 状态栏切成「正在编辑本行」
    };
    text.onblur = () => updateStatusBar();

    item.appendChild(time);
    item.appendChild(text);
    box.appendChild(item);
  });
  paintCuePanelHighlight();
}

/* ---------------- 字幕整体偏移（口型校正） ---------------- */

/** 全部字幕（含逐字时间）整体平移 delta 秒：即时预览，点「保存偏移」才写入工程 */
function shiftAllCues(delta) {
  if (!cues.length) { toast('还没有歌词可偏移', 'err'); return false; }
  const minStart = Math.min.apply(null, cues.map((c) => (isFinite(c.start) ? c.start : 0)));
  if (minStart + delta < -1e-6) {
    toast('偏移会让第一句越过歌曲开头（第一句在 ' + fmtTime(minStart) + '），请先减小偏移量', 'err');
    return false;
  }
  const r3 = (v) => Math.round(v * 1000) / 1000;
  cues.forEach((cue) => {
    cue.start = r3(cue.start + delta);
    cue.end = r3(cue.end + delta);
    (cue.words || []).forEach((word) => {
      word.start = r3(word.start + delta);
      word.end = r3(word.end + delta);
    });
  });
  cueOffsetAccum = r3(cueOffsetAccum + delta);
  updateCueOffsetLabel();
  renderCues();
  renderTimeline();
  pushStage();
  return true;
}

function updateCueOffsetLabel() {
  const label = el('cueOffsetLabel');
  if (label) {
    label.textContent = (cueOffsetAccum >= 0 ? '+' : '') + cueOffsetAccum.toFixed(2) + 's';
  }
}

/* ================= 事件绑定 ================= */

function bindEvents() {
  // 顶部工具条
  on('btnImportSub', 'click', () => toast('提示：识别完成后歌词自动导入编辑区', 'ok'));
  on('btnSaveProject', 'click', async () => {
    if (!project) return;
    await api('PUT', '/api/projects/' + project.id + '/subtitles', cues);
    toast('工程已保存（含逐字扫色）', 'ok');
  });
  on('btnImportProject', 'click', () => toast('工程文件位于 server/data/projects/ 下', 'ok'));
  on('btnRefCorrect', 'click', () => toast('参考纠错：可粘贴参考歌词后对比修正', 'ok'));
  on('btnUtils', 'click', () => toast('实用工具：波形/缓存清理等', 'ok'));
  on('btnSerato', 'click', () => toast('链接 Serato：本机未检测到 Serato 数据库', 'ok'));
  on('btnRekordbox', 'click', () => toast('链接 rekordbox：本机未检测到 rekordbox 数据库', 'ok'));
  on('btnTraktor', 'click', () => toast('链接 Traktor：本机未检测到 Traktor 数据库', 'ok'));
  on('btnKey', 'click', () => toast('Key 密钥配置：本地版无需密钥', 'ok'));
  on('btnWebsite', 'click', () => toast('songshu57.com（仅作界面参考）', 'ok'));
  on('btnExportTop', 'click', startExport);

  // 选项卡（切换提示，主流程不打断）
  document.querySelectorAll('.navtab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.navtab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const view = tab.dataset.view;
      if (view === 'template') {
        const t = document.querySelector('.tab[data-tab="template"]');
        if (t) t.click();
      } else if (view === 'subtitle' || view === 'fontText') {
        const t = document.querySelector('.tab[data-tab="style"]');
        if (t) t.click();
      } else if (view === 'songName') {
        const t = document.querySelector('.tab[data-tab="style"]');
        if (t) t.click();
      } else if (view !== 'recognize') {
        toast('“' + tab.textContent.trim() + '”面板开发中', 'ok');
      }
    });
  });

  // 内部 tabs
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      const pane = el(tab.dataset.tab === 'template' ? 'paneTemplate' : (tab.dataset.tab === 'style' ? 'paneStyle' : 'paneCues'));
      if (pane) pane.classList.add('active');
    });
  });

  // 步骤 ①：未识别时点这里直接开始识别，已识别则回到模板列表
  on('stepRecognize', 'click', () => {
    if (subtitlesReady()) {
      toast('字幕已识别：' + cues.length + ' 行，可直接挑选模板', 'ok');
      return;
    }
    if (recognizing) {
      toast('字幕识别中，请稍候…', 'ok');
      return;
    }
    startRecognize();
  });

  on('btnResetTemplate', 'click', async () => {
    if (!project) return;
    project = await api('PUT', '/api/projects/' + project.id + '/template', {});
    markAppliedTemplate(null);
    renderTemplateGrid();
    applyTemplateToPanel(project.template);
    pushStage();
    renderTimeline();
    toast('已恢复默认字幕样式', 'ok');
  });

  // 歌曲/素材
  on('btnPickAudio', 'click', () => uploadMedia('audio'));
  on('btnPickBg', 'click', () => uploadMedia('background'));
  on('btnAddClip', 'click', () => uploadMedia('background'));
  on('btnRecognize', 'click', startRecognize);

  // 播放器
  on('btnPlay', 'click', togglePlay);
  on('btnPrev', 'click', () => jumpCue(-1));
  on('btnNext', 'click', () => jumpCue(1));

  // 时间轴交互
  /** 缩放：anchorClientX 传入时以鼠标位置为锚点（剪映的 Ctrl+滚轮手感） */
  function applyZoom(value, anchorClientX) {
    const lanes = el('trackLanes');
    const oldPerSec = Math.max(1, pxPerSecond);
    const rect = lanes ? lanes.getBoundingClientRect() : null;
    const hasAnchor = !!(rect && isFinite(anchorClientX));
    const anchorOffset = hasAnchor ? (anchorClientX - rect.left) : (lanes ? lanes.clientWidth / 2 : 0);
    const anchorTime = lanes ? (lanes.scrollLeft + anchorOffset) / oldPerSec : 0;
    pxPerSecond = Math.max(2, Math.min(300, Math.round(value)));
    const range = el('zoomRange');
    if (range) range.value = Math.min(Number(range.max || 300), pxPerSecond);
    renderTimeline();
    if (lanes) {
      lanes.scrollLeft = Math.max(0, anchorTime * pxPerSecond - anchorOffset);
      drawWaveform(playRatio());
      updateWaveHead();
    }
    refreshCutPreview();
  }

  // 滚轮：上下滚动横向移动时间轴，Ctrl/⌘ + 滚轮按鼠标位置缩放
  const lanesNode = el('trackLanes');
  if (lanesNode) {
    lanesNode.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        applyZoom(pxPerSecond * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX);
        return;
      }
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const before = lanesNode.scrollLeft;
      lanesNode.scrollLeft = before + delta;
      if (lanesNode.scrollLeft !== before) {
        e.preventDefault();
        drawWaveform(playRatio());
        updateWaveHead();
      }
    }, { passive: false });

    // 左键在空白处按下：开始素材框选（超过阈值才算拖动，空白单击仍定位播放头）
    lanesNode.addEventListener('pointerdown', onLanesPointerDown);

    // 切点光标：跟踪光标在时间轴上的位置（分割优先用它），按住 Ctrl 显示切点预览线
    const cutPreview = document.createElement('div');
    cutPreview.id = 'cutPreview';
    cutPreview.className = 'cut-preview';
    const lanesContent = el('lanesContent');
    if (lanesContent) lanesContent.appendChild(cutPreview);
    lanesNode.addEventListener('mousemove', (e) => {
      hoverSplitTime = timeAtClientX(e.clientX);
      hoverTrack = (e.target && e.target.closest)
        ? (e.target.closest('.lane-wave') ? 'audio' : (e.target.closest('.lane-media') ? 'media' : null))
        : null;
      refreshCutPreview();
    });
    lanesNode.addEventListener('mouseleave', () => {
      hoverSplitTime = null;
      hoverTrack = null;
      refreshCutPreview();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Control' || e.key === 'Meta') { ctrlHeld = true; refreshCutPreview(); }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Control' || e.key === 'Meta') { ctrlHeld = false; refreshCutPreview(); }
    });
    window.addEventListener('blur', () => { ctrlHeld = false; refreshCutPreview(); });
  }

  // 片段拖动（裁剪 / 移动）走 window 级事件，指针移出片段也不会断
  window.addEventListener('pointermove', onClipPointerMove);
  window.addEventListener('pointerup', onClipPointerUp);
  window.addEventListener('pointercancel', onClipPointerUp);

  // 素材框选：move/up 走 window 级事件，指针移出轨道也不会断（按下在下方 trackLanes 上绑定）
  // 任何新的按下（捕获阶段）都先清理可能残留的旧会话，避免"指针在窗口外释放"后框选失效
  window.addEventListener('pointerdown', () => { if (marquee) endMarquee(false); }, true);
  window.addEventListener('pointermove', onMarqueePointerMove);
  window.addEventListener('pointerup', onMarqueePointerUp);
  window.addEventListener('pointercancel', () => endMarquee(false));
  window.addEventListener('blur', () => endMarquee(false));

  on('btnSnapToggle', 'click', () => {
    snapEnabled = !snapEnabled;
    const btn = el('btnSnapToggle');
    if (btn) btn.textContent = '⛓ 吸附：' + (snapEnabled ? '开' : '关');
    if (btn) btn.classList.toggle('gold', snapEnabled);
    toast(snapEnabled ? '磁吸已开启（拖动中按住 Alt 可临时关闭）' : '磁吸已关闭（仍按 1 帧对齐）', 'ok');
  });
  on('btnSplitClip', 'click', () => splitSelectedClip());
  on('btnResetClips', 'click', resetClipLayout);
  on('btnSplitAudio', 'click', () => splitAudioAt(null));   // 按播放头位置分割音频
  on('btnAudioUndo', 'click', () => undoAudioCut());

  on('trackLanes', 'click', (e) => {
    // 刚结束拖动时吞掉尾随的 click，避免播放头被带走
    if (performance.now() - lastClipDragAt < 250) return;
    if (performance.now() - lastMarqueeAt < 250) return;   // 框选结束的尾随 click 同样吞掉
    // 点空白处取消素材选中（点片段本身不取消）
    const onClip = e.target && e.target.closest && e.target.closest('.clip');
    if (!onClip) clearMediaSelection();

    const lanes = el('trackLanes');
    const total = duration();
    if (!lanes || total <= 0) return;
    const rect = lanes.getBoundingClientRect();
    const x = e.clientX - rect.left + lanes.scrollLeft;
    const t = Math.max(0, Math.min(total, x / Math.max(1, pxPerSecond)));
    audio.currentTime = t;
    seekStage(t);
    updateWaveHead();
    drawWaveform(playRatio());
  });

  on('trackLanes', 'scroll', () => {
    drawWaveform(playRatio());
    updateWaveHead();
  });

  on('zoomRange', 'input', (e) => applyZoom(Number(e.target.value)));
  on('btnZoomIn', 'click', () => applyZoom(pxPerSecond + Math.max(6, Math.round(pxPerSecond * 0.3))));
  on('btnZoomOut', 'click', () => applyZoom(pxPerSecond - Math.max(6, Math.round(pxPerSecond * 0.3))));
  on('btnCopyTiming', 'click', async () => {
    const text = cues.map((c) => fmtTime(c.start) + ' - ' + fmtTime(c.end) + '  ' + (c.text || '')).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('时间码已复制到剪贴板', 'ok');
    } catch (err) {
      toast('复制失败', 'err');
    }
  });

  // 歌词编辑
  on('btnSaveCues', 'click', async () => {
    if (!project) return;
    cues = await api('PUT', '/api/projects/' + project.id + '/subtitles', cues);
    selectedCueIndexes = [];
    toast('歌词已保存（逐字扫色已更新）', 'ok');
    pushStage();
    renderTimeline();
  });

  // 口型校正：字幕整体偏移（即时预览，点「保存偏移」才写入工程）
  on('btnCueOffM2', 'click', () => shiftAllCues(-0.10));
  on('btnCueOffM1', 'click', () => shiftAllCues(-0.02));
  on('btnCueOffP1', 'click', () => shiftAllCues(0.02));
  on('btnCueOffP2', 'click', () => shiftAllCues(0.10));
  on('btnCueOffReset', 'click', () => {
    if (Math.abs(cueOffsetAccum) < 1e-6) { toast('当前没有未保存的偏移', 'ok'); return; }
    shiftAllCues(-cueOffsetAccum);
  });
  on('btnCueOffSave', 'click', async () => {
    if (!project) return;
    if (Math.abs(cueOffsetAccum) < 1e-6) { toast('当前偏移为 0，无需保存', 'ok'); return; }
    const applied = cueOffsetAccum;
    await api('PUT', '/api/projects/' + project.id + '/subtitles', cues);
    cueOffsetAccum = 0;
    updateCueOffsetLabel();
    toast('已保存字幕偏移 ' + (applied > 0 ? '+' : '') + applied.toFixed(2) + 's（含逐字时间）', 'ok');
  });
  on('btnAddCue', 'click', () => {
    const last = cues.length ? cues[cues.length - 1] : { end: 0 };
    cues.push({ start: last.end, end: last.end + 3, text: '新歌词', words: [], sweepMode: 'follow' });
    selectedCueIndexes = [];
    renderCues();
    renderTimeline();
    pushStage();
  });

  // 样式
  on('btnStyleReset', 'click', async () => {
    if (!project) return;
    project = await api('PUT', '/api/projects/' + project.id + '/template', {});
    markAppliedTemplate(null);
    renderTemplateGrid();
    applyTemplateToPanel(project.template);
    pushStage();
    toast('已恢复 KFC Music 默认样式', 'ok');
  });
  on('btnApplyStyle', 'click', async () => {
    if (!project) return;
    const template = readTemplateFromPanel();
    project = await api('PUT', '/api/projects/' + project.id + '/template', template);
    pushStage();
    toast('样式已应用', 'ok');
  });

  document.querySelectorAll('#paneStyle select, #paneStyle input').forEach((node) => {
    node.addEventListener('change', async () => {
      if (!project) return;
      try {
        const template = readTemplateFromPanel();
        project = await api('PUT', '/api/projects/' + project.id + '/template', template);
        pushStage();
        renderTimeline();
      } catch (err) {
        toast('样式保存失败：' + err.message, 'err');
      }
    });
  });

  on('btnExportMain', 'click', startExport);

  // 键盘快捷键：退格 / Delete 删除选中素材
  window.addEventListener('keydown', handleTimelineKeys);

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      drawWaveform(playRatio());
      updateWaveHead();
      renderTimeline();
    }, 250);
  });
}

/* ================= 上传 ================= */

async function uploadMedia(kind) {
  if (!project) {
    toast('请先新建工程', 'err');
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = kind === 'background';
  input.accept = kind === 'audio'
    ? 'audio/*,.mp3,.wav,.flac,.m4a,.aac,.ogg'
    : 'video/*,image/*';

  input.onchange = async () => {
    const files = Array.from(input.files || []);
    if (!files.length) return;
    try {
      for (const file of files) {
        setProgress(0.1, '导入中：' + file.name);
        const form = new FormData();
        form.append('file', file);
        project = await api('POST', '/api/projects/' + project.id + '/media/' + kind, form);
      }
      setProgress(1, '导入完成');
      await selectProject(project.id);
      toast('已导入 ' + files.length + ' 个文件', 'ok');
    } catch (err) {
      toast('导入失败：' + err.message, 'err');
      setProgress(0, '导入失败');
    }
  };
  input.click();
}

/* ================= 识别 ================= */

async function startRecognize() {
  if (!project) return;
  if (!project.audio) {
    toast('请先导入歌曲音频', 'err');
    return;
  }
  try {
    recognizing = true;
    setFlag('flagSub', '识别中', 'busy');
    renderTemplateGrid();   // 步骤 ①进行中：模板保持锁定
    const res = await api('POST', '/api/projects/' + project.id + '/recognize');
    pollTask(res.taskId, async () => {
      recognizing = false;
      cues = await api('GET', '/api/projects/' + project.id + '/subtitles');
      selectedCueIndexes = [];
      project = await api('GET', '/api/projects/' + project.id);
      renderAll();
      renderTemplateGrid();   // 步骤 ①完成：解锁模板卡片
      renderTimeline();
      pushStage();
      openTemplatePane();     // 直接切到「歌词模板」，进入步骤 ②
      toast('识别完成：' + cues.length + ' 行 · 请挑选并应用字幕模板', 'ok');
      setProgress(1, '识别完成');
    });
  } catch (err) {
    recognizing = false;
    renderTemplateGrid();
    toast('识别失败：' + err.message, 'err');
    setFlag('flagSub', '失败', 'err');
  }
}

function pollTask(taskId, onDone) {
  if (pollingTimer) clearInterval(pollingTimer);
  const started = Date.now();
  pollingTimer = setInterval(async () => {
    try {
      const task = await api('GET', '/api/tasks/' + taskId);
      if (task.status === 'RUNNING' || task.status === 'PENDING') {
        setProgress((task.progress || 0) / 100, task.message || '处理中…');
        return;
      }
      clearInterval(pollingTimer);
      pollingTimer = null;
      if (task.status === 'DONE') {
        await onDone(task);
      } else {
        toast('任务失败：' + (task.message || ''), 'err');
        setProgress(0, '失败');
        setFlag('flagSub', '失败', 'err');
      }
    } catch (err) {
      if (Date.now() - started > 30 * 60 * 1000) {
        clearInterval(pollingTimer);
        pollingTimer = null;
      }
    }
  }, 1000);
}

/* ================= 预览 ================= */

function pushStage() {
  const stageWindow = stageFrame && stageFrame.contentWindow;
  if (!stageWindow) return;
  const config = {
    width: 1920,
    height: 1080,
    fps: Number((el('fpsSelect') && el('fpsSelect').value) || 30),
    duration: duration(),
    cues: cues,
    template: project ? project.template : undefined,
    background: backgroundConfig(),
    mediaPlaying: playing,
  };
  stageWindow.postMessage({ type: 'stage:setup', config: config }, '*');
  if (project) applyTemplateToPanel(project.template);
}

/** 素材片段 → 时间段映射：播放头越过片段末尾后就不再显示该素材（分割片段各自成段） */
function backgroundSegments() {
  if (!project || !mediaList().length) return [];
  const segments = [];
  clipList().forEach((item) => {
    const span = item.span;
    const start = Math.max(0, Number(span.start) || 0);
    const end = Number(span.end) || 0;
    if (!(end > start)) return;              // 长度为 0 的片段不显示
    segments.push({
      mediaId: String(item.media.id),
      start: start,
      end: end,
      srcIn: Math.max(0, Number(span.srcIn) || 0),   // 源入点：裁剪左端后的素材起点
      kind: item.media.kind === 'video' ? 'video' : 'image',
      url: API + '/api/projects/' + project.id + '/media/files/' + item.media.fileName,
    });
  });
  return segments.sort((a, b) => a.start - b.start);
}

function backgroundConfig() {
  const preset = project && project.template && project.template.backgroundPreset;
  if (preset) {
    return { kind: 'image', imageUrl: '../../assets/backgrounds/' + preset };
  }
  const segments = backgroundSegments();
  if (!segments.length) return { kind: 'none' };
  return { kind: 'segments', segments: segments };
}

/** 导出用背景：沿用同一套片段时间段；首个素材优先复用后端已备好的帧序列 */
function exportBackgroundConfig(planBackground) {
  const preset = project && project.template && project.template.backgroundPreset;
  if (preset) return { kind: 'image', imageUrl: '../../assets/backgrounds/' + preset };
  const segments = backgroundSegments();
  if (!segments.length) return { kind: 'none' };
  const plan = planBackground && planBackground.kind && planBackground.kind !== 'none' ? planBackground : null;
  if (!plan) return { kind: 'segments', segments: segments };
  const first = mediaList()[0];
  return {
    kind: 'segments',
    segments: segments.map((seg) => {
      if (!first || String(first.id) !== seg.mediaId) return seg;
      if (plan.kind === 'frames') {
        return Object.assign({}, seg, { kind: 'frames', framesDir: plan.framesDir, frameCount: plan.frameCount });
      }
      if (plan.kind === 'image') {
        return Object.assign({}, seg, { kind: 'image', url: plan.imageUrl });
      }
      return seg;
    }),
  };
}

function seekStage(time, isPlaying) {
  const stageWindow = stageFrame && stageFrame.contentWindow;
  if (!stageWindow) return;
  const flag = typeof isPlaying === 'boolean' ? isPlaying : playing;
  stageWindow.postMessage({ type: 'stage:seek', time: time, playing: flag }, '*');
}

function normalizeBackground(bg) {
  if (!bg || !bg.kind || bg.kind === 'none') return { kind: 'none' };
  if (bg.kind === 'frames' && bg.framesDir) {
    return { kind: 'frames', framesDir: API + bg.framesDir, frameCount: bg.frameCount || 0 };
  }
  if (bg.kind === 'image' && bg.imageUrl) {
    return { kind: 'image', imageUrl: API + bg.imageUrl };
  }
  return { kind: 'none' };
}

function togglePlay() {
  playing = !playing;
  const btn = el('btnPlay');
  if (btn) btn.textContent = playing ? '❚❚' : '▶';
  if (playing) audio.play().catch(() => {});
  else audio.pause();
  // 同步舞台播放状态：未播放时背景视频等保持静止
  seekStage(audio.currentTime, playing);
}

function jumpCue(direction) {
  if (!cues.length) return;
  const now = audio.currentTime;
  let target = null;
  if (direction > 0) {
    target = cues.find((c) => c.start > now + 0.05);
  } else {
    for (let i = cues.length - 1; i >= 0; i--) {
      if (cues[i].start < now - 0.3) { target = cues[i]; break; }
    }
    if (!target) target = cues[0];
  }
  if (target) {
    audio.currentTime = Math.max(0, target.start - 0.05);
    seekStage(audio.currentTime);
    updateWaveHead();
  }
}

function syncAudioTime() {
  let lastStagePush = 0;
  const loop = () => {
    const total = duration();
    if (total > 0) {
      const label = el('timeLabel');
      if (label) label.textContent = fmtTime(audio.currentTime) + ' / ' + fmtTime(total);
      const cursor = el('timeCursor');
      if (cursor) cursor.textContent = fmtClock(audio.currentTime).slice(3) + '.' + String(Math.floor((audio.currentTime % 1) * 100)).padStart(2, '0');
    }
    // 仅在真正播放时刷新舞台（逐字扫色 / 视频背景需要），按帧推送（约 60fps）；
    // 未播放时不再推送，避免背景视频 / 动画未播放就自行运动
    const now = performance.now();
    if (playing && now - lastStagePush > 15) {
      lastStagePush = now;
      seekStage(audio.currentTime, true);
    }
    updateWaveHead();

    const ratio = playRatio();
    if (Math.abs(ratio - lastWaveRatio) > 0.003) {
      lastWaveRatio = ratio;
      drawWaveform(ratio);
    }
    requestAnimationFrame(loop);
  };
  loop();

  audio.onended = () => {
    playing = false;
    const btn = el('btnPlay');
    if (btn) btn.textContent = '▶';
    seekStage(audio.currentTime, false);
  };
}

function bindStageMessages() {
  window.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.source !== 'ktv-stage') return;
    if (data.type === 'ended') {
      playing = false;
      const btn = el('btnPlay');
      if (btn) btn.textContent = '▶';
    } else if (data.type === 'key') {
      // 预览区获得焦点时按下的退格 / Delete / Esc
      handleTimelineKeys({ key: data.key, target: null });
    }
  });
}

/* ================= 样式面板 ================= */

const STYLE_FIELDS = {
  optFontFamily: 'fontFamily',
  optBackgroundPreset: 'backgroundPreset',
  optPlayedMode: 'playedColorMode',
  optPlayedSolid: 'playedSolidColor',
  optGradStart: 'gradientStart',
  optGradMid: 'gradientMiddle',
  optGradEnd: 'gradientEnd',
  optUnplayed: 'unplayedColor',
  optFontSize: 'fontSize',
  optLetterSpacing: 'letterSpacing',
  optStrokeWidth: 'strokeWidth',
  optStrokeColor: 'strokeColor',
  optShadowBlur: 'shadowBlur',
  optBottomMargin: 'bottomMargin',
  optMaxChars: 'maxChars',
  optNameText: 'nameText',
  optSingerText: 'singerText',
  optDjText: 'djText',
};

const NUMERIC_FIELDS = ['fontSize', 'letterSpacing', 'strokeWidth', 'shadowBlur', 'bottomMargin', 'maxChars'];

function applyTemplateToPanel(template) {
  if (!template) return;
  Object.keys(STYLE_FIELDS).forEach((id) => {
    const key = STYLE_FIELDS[id];
    const node = el(id);
    if (node && template[key] !== undefined && template[key] !== null) {
      node.value = template[key];
    }
  });
}

function readTemplateFromPanel() {
  const base = (project && project.template) || {};
  const template = Object.assign({}, base);
  Object.keys(STYLE_FIELDS).forEach((id) => {
    const key = STYLE_FIELDS[id];
    const node = el(id);
    if (!node) return;
    template[key] = NUMERIC_FIELDS.indexOf(key) >= 0 ? Number(node.value) : node.value;
  });
  return template;
}

/* ================= 导出 ================= */

async function startExport() {
  if (!project) return;
  if (!cues.length) {
    toast('请先识别或添加歌词', 'err');
    return;
  }
  const fps = 30;
  const width = 1920;
  const height = 1080;

  try {
    setProgress(0.01, '准备导出（素材自动匹配歌曲长度）…');
    const plan = await api('POST', '/api/projects/' + project.id + '/export/plan', {
      fps: fps, width: width, height: height,
    });

    // 导出与预览一致：素材只在各自片段的时间段内出现，越过后留空背景
    const background = exportBackgroundConfig(normalizeBackground(plan.background));

    const config = {
      width: width, height: height, fps: fps,
      duration: plan.duration,
      cues: cues,
      template: project.template,
      background: background,
      mediaPlaying: false,        // 逐帧导出：素材停在目标时间点，不跟随播放推进
    };
    const stageWindow = stageFrame && stageFrame.contentWindow;
    if (stageWindow) stageWindow.postMessage({ type: 'stage:setup', config: config }, '*');

    if (!window.ktv || !window.ktv.onRenderProgress) {
      toast('渲染通道未就绪', 'err');
      return;
    }
    window.ktv.onRenderProgress((info) => {
      setProgress(info.done / info.total, '渲染帧 ' + info.done + ' / ' + info.total);
    });

    setProgress(0, '开始逐帧渲染…');
    await window.ktv.renderFrames({
      config: config,
      framesDir: plan.framesDir,
      fps: fps,
      width: width,
      height: height,
      duration: plan.duration,
    });

    setProgress(0.99, '合成中（帧序列 + 原音轨）…');
    const res = await api('POST', '/api/projects/' + project.id + '/export/render', { fps: fps });
    pollTask(res.taskId, async (task) => {
      project = await api('GET', '/api/projects/' + project.id);
      renderAll();
      const output = task.result && task.result.output ? task.result.output : '';
      toast('导出完成：' + output, 'ok');
      setProgress(1, '导出完成');
    });
  } catch (err) {
    toast('导出失败：' + err.message, 'err');
    setProgress(0, '导出失败');
  }
}

/* ================= 启动 ================= */

init().catch((err) => {
  toast('初始化失败：' + err.message, 'err');
});
