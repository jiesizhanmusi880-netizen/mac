'use strict';

/**
 * 启动桌面应用内嵌的 Web 界面并截图（还原真实 UI 组件外观）。
 * 用法：npx electron tools/capture-app-pages.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const RES = 'e:\\学习研究\\音乐\\_extract\\安装 歌暮 · 一键识别双行字幕\\歌暮.app\\Contents\\Resources';
const OUT = path.join(__dirname, 'app');

const pages = [
  { name: 'jizura-index', file: path.join(RES, 'Jizura', 'index.html'), w: 1280, h: 720 },
  { name: 'jizura-editor', file: path.join(RES, 'Jizura', 'editor.html'), w: 430, h: 940 },
  { name: 'lyric-stage', file: path.join(RES, 'LyricTemplates', 'index.html'), w: 1280, h: 720 },
  { name: 'waveform', file: path.join(RES, 'DJLayeredWaveformV02', 'index.html'), w: 900, h: 260 },
];

async function shoot(page) {
  const win = new BrowserWindow({
    width: page.w,
    height: page.h,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: '#16171d',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message.slice(0, 160));
  });

  try {
    await win.loadFile(page.file);
    await new Promise((r) => setTimeout(r, 3000));
    const image = await win.webContents.capturePage();
    const out = path.join(OUT, page.name + '.png');
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(out, image.toPNG());
    console.log('OK ' + page.name + ' -> ' + out + ' ' + JSON.stringify(image.getSize()));
    if (errors.length) {
      console.log('   页面提示: ' + errors.slice(0, 2).join(' | '));
    }
  } catch (err) {
    console.log('FAIL ' + page.name + ': ' + err.message);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

app.whenReady().then(async () => {
  for (const page of pages) {
    await shoot(page);
  }
  app.quit();
});
