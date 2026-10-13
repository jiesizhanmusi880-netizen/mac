'use strict';

/**
 * 滚动截取网页（用于抓取产品页里的界面截图）。
 * 用法：npx electron tools/capture-web.js <url> <输出前缀> [屏数]
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const url = process.argv[2];
const prefix = process.argv[3] || path.join(__dirname, 'web');
const maxShots = Number(process.argv[4] || 6);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1600,
    height: 1100,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: '#0b0b12',
    webPreferences: { backgroundThrottling: false, webSecurity: true },
  });

  try {
    await win.loadURL(url);
    await new Promise((r) => setTimeout(r, 7000));

    const height = await win.webContents.executeJavaScript('Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)');
    const shots = Math.min(maxShots, Math.max(1, Math.ceil(height / 1000)));
    console.log('页面高度 ' + height + ' px，截 ' + shots + ' 屏');

    for (let i = 0; i < shots; i++) {
      await win.webContents.executeJavaScript('window.scrollTo(0, ' + (i * 1000) + ')');
      await new Promise((r) => setTimeout(r, 1500));
      const image = await win.webContents.capturePage();
      fs.writeFileSync(prefix + '-' + (i + 1) + '.png', image.toPNG());
      console.log('  已保存 ' + prefix + '-' + (i + 1) + '.png');
    }
  } catch (err) {
    console.error('抓取失败: ' + err.message);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
