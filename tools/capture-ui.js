'use strict';

/**
 * 截取主界面（用于自检 UI）。用法：
 *   npx electron tools/capture-ui.js [输出png]
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const outPath = process.argv[2] || path.join(__dirname, 'ui-preview.png');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500,
    height: 940,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: '#16171d',
    webPreferences: {
      preload: path.join(__dirname, '..', 'desktop', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: false,
    },
  });

  const errors = [];
  const logs = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push('[' + level + '] ' + message);
    else logs.push(message);
  });

  try {
    await win.loadFile(path.join(__dirname, '..', 'desktop', 'renderer', 'index.html'));
    await new Promise((r) => setTimeout(r, 3500));

    // 可选：截图前注入一段交互脚本（用于验证缩放等）
    const preScript = process.argv[3];
    if (preScript) {
      await win.webContents.executeJavaScript(preScript);
      await new Promise((r) => setTimeout(r, 2000));
    }
    const image = await win.webContents.capturePage();
    fs.writeFileSync(outPath, image.toPNG());
    console.log('UI 截图: ' + outPath + ' ' + JSON.stringify(image.getSize()));
    if (logs.length) {
      console.log('页面日志:');
      logs.slice(-6).forEach((l) => console.log('  ' + l));
    }
    if (errors.length) {
      console.log('页面错误:');
      errors.slice(-4).forEach((e) => console.log('  ' + e));
    } else {
      console.log('页面无 console 错误');
    }
  } catch (err) {
    console.error('截图失败: ' + err.message);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
