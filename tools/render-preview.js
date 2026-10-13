'use strict';

/**
 * 离线预览：用 Electron 渲染 KTV 舞台的一帧并保存 PNG，用于校验字体/配色/逐字高亮。
 *
 * 用法：
 *   npx electron tools/render-preview.js [时间秒] [输出png路径]
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const timeSeconds = Number(process.argv[2] || 2.4);
const outPath = process.argv[3] || path.join(__dirname, 'preview.png');

function buildWords(text, start, end) {
  const chars = Array.from(text);
  const span = (end - start) / chars.length;
  return chars.map((ch, i) => ({
    text: ch,
    start: +(start + span * i).toFixed(3),
    end: +(start + span * (i + 1)).toFixed(3),
  }));
}

const lines = [
  { start: 0.6, end: 4.2, text: '如果全世界我也可以放弃' },
  { start: 4.4, end: 8.6, text: '至少还有你值得我去珍惜' },
  { start: 8.8, end: 13.0, text: '而你在这里就是生命的奇迹' },
];

const config = {
  width: 1920,
  height: 1080,
  fps: 30,
  duration: 180,
  template: {
    fontFamily: '抖音美好体',
    fontSize: 95,
    letterSpacing: 10,
    playedColorMode: 'gradient',
    playedSolidColor: '#B721FF',
    gradientStart: '#A900B2',
    gradientMiddle: '#6651D0',
    gradientEnd: '#23A2EE',
    unplayedColor: '#FFFFFF',
    strokeEnabled: true,
    strokeColor: '#000000',
    strokeWidth: 5,
    shadowEnabled: true,
    shadowColor: '#000000',
    shadowOpacity: 0.7,
    shadowBlur: 8,
    shadowDistance: 6,
    fadeEnabled: false,
    maxChars: 15,
    lineGap: 110,
    bottomMargin: 170,
  },
  background: { kind: 'image', imageUrl: '../../assets/backgrounds/background-halo.png' },
  cues: lines.map((line) => ({
    start: line.start,
    end: line.end,
    text: line.text,
    words: buildWords(line.text, line.start, line.end),
  })),
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: config.width,
    height: config.height,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: '#000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: false,
    },
  });

  try {
    await win.loadFile(path.join(__dirname, '..', 'desktop', 'renderer', 'stage', 'ktv-stage.html'));
    win.webContents.setZoomFactor(1);
    await win.webContents.executeJavaScript('Stage.setup(' + JSON.stringify(config) + ')');
    await new Promise((r) => setTimeout(r, 400));
    await win.webContents.executeJavaScript('Stage.renderAt(' + timeSeconds + ')');
    await win.webContents.executeJavaScript(
      'new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(resolve); }); })');

    let image = await win.webContents.capturePage();
    const size = image.getSize();
    if (size.width !== config.width || size.height !== config.height) {
      image = image.resize({ width: config.width, height: config.height });
    }
    fs.writeFileSync(outPath, image.toPNG());
    console.log('已输出预览帧: ' + outPath + ' (' + size.width + 'x' + size.height + ')');
  } catch (err) {
    console.error('预览渲染失败: ' + err.message);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
