'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const isPackaged = app.isPackaged;
const DEV_BACKEND_BASE = process.env.KTV_BACKEND || 'http://127.0.0.1:8787';

let mainWindow = null;
let renderCancelled = false;
let backendPort = 8787;      // 打包运行时由主进程分配（默认从 8787 起找空闲口）
let backendProc = null;      // 内置后端进程（仅打包模式）

/* ---------------- 内置后端（打包模式） ---------------- */

/** 打包后资源根目录：…/Resources；开发模式指向 dist-resources（与打包结构一致） */
function resourcesRoot() {
  return isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'dist-resources');
}

/** 从 start 起找一个空闲端口 */
function findFreePort(start) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(findFreePort(start + 1)));
    server.listen(start, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

/** 轮询后端 /api/system/tools 直到就绪 */
function waitBackendReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const probe = () => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: port, path: '/api/system/tools', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
  return (async () => {
    while (Date.now() < deadline) {
      if (await probe()) return true;
      await new Promise((r) => setTimeout(r, 600));
    }
    return false;
  })();
}

/** 打包模式：拉起内置 JRE + 后端 jar（数据目录在用户可写位置，端口自动分配） */
async function startBackend() {
  if (!isPackaged) {
    // 开发模式：后端由开发者手动启动（mvn spring-boot:run），沿用 8787
    try { backendPort = new URL(DEV_BACKEND_BASE).port ? Number(new URL(DEV_BACKEND_BASE).port) : 8787; }
    catch (err) { backendPort = 8787; }
    return;
  }
  const res = resourcesRoot();
  const javaBin = path.join(res, 'backend', 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const jar = path.join(res, 'backend', 'ktv-server.jar');
  const dataDir = path.join(app.getPath('userData'), 'data');
  const binDir = path.join(res, 'bin');
  backendPort = await findFreePort(8787);
  backendProc = spawn(javaBin, [
    '-Dfile.encoding=UTF-8',
    '-jar', jar,
    '--server.address=127.0.0.1',
    '--server.port=' + backendPort,
    '--ktv.data-dir=' + dataDir,
    '--ktv.bin-dir=' + binDir,
  ], {
    cwd: app.getPath('userData'),        // 日志等相对路径落在用户目录
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  backendProc.stdout.on('data', (d) => process.stdout.write('[backend] ' + d));
  backendProc.stderr.on('data', (d) => process.stderr.write('[backend] ' + d));
  backendProc.on('exit', () => { backendProc = null; });
  const ready = await waitBackendReady(backendPort, 90000);
  if (!ready) console.error('[backend] 启动超时（90s），界面仍会打开但功能可能不可用');
}

function stopBackend() {
  if (backendProc) {
    try { backendProc.kill(); } catch (err) { /* ignore */ }
    backendProc = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#0a0a0f',
    title: '歌暮 KTV · 歌词字幕制作',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 允许加载本地字体/图片资源（file:// 同源限制）
      webSecurity: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return mainWindow;
}

/**
 * 应用菜单（隐藏显示，Alt 可唤出）：
 * 默认菜单的 Edit>Undo 会拦截 Ctrl+Z 且对页面无效，
 * 这里改为把 Ctrl+Z 转发给渲染进程执行时间轴撤销栈。
 */
function buildMenu() {
  const template = [
    {
      label: '编辑',
      submenu: [
        {
          label: '撤销上一步',
          accelerator: 'CommandOrControl+Z',
          click: (_item, win) => {
            if (win && !win.isDestroyed()) win.webContents.send('app:undo');
          },
        },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  buildMenu();
  await startBackend();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  stopBackend();
});

/* ---------------- 基础 IPC ---------------- */

ipcMain.handle('app:info', () => ({
  backend: backendPort ? 'http://127.0.0.1:' + backendPort : DEV_BACKEND_BASE,
  packaged: isPackaged,
  version: app.getVersion(),
}));

ipcMain.handle('dialog:openFile', async (_event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, options || {});
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths;
});

ipcMain.handle('dialog:saveFile', async (_event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, options || {});
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('shell:showItem', async (_event, filePath) => {
  const { shell } = require('electron');
  shell.showItemInFolder(filePath);
  return true;
});

/* ---------------- 逐帧渲染 ---------------- */

ipcMain.handle('render:cancel', () => {
  renderCancelled = true;
  return true;
});

/**
 * 逐帧渲染字幕舞台并写出 JPEG 序列。
 * options: { config, framesDir, fps, width, height, duration }
 */
ipcMain.handle('render:frames', async (event, options) => {
  renderCancelled = false;
  const { config, framesDir, fps, width, height, duration } = options;
  const total = Math.max(1, Math.ceil(duration * fps));

  const win = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: '#000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: false,
      offscreen: false,
    },
  });

  try {
    await win.loadFile(path.join(__dirname, 'renderer', 'stage', 'ktv-stage.html'));
    win.webContents.setZoomFactor(1);
    await win.webContents.executeJavaScript('Stage.setup(' + JSON.stringify(config) + ')');
    await new Promise((r) => setTimeout(r, 120));

    await fsp.mkdir(framesDir, { recursive: true });

    // 写盘与渲染流水线化：最多 8 个写盘并发，不与下一帧渲染互相等待
    const pending = new Set();
    let writeError = null;
    const trackWrite = (file, buffer) => {
      const task = fsp.writeFile(file, buffer)
        .catch((err) => { if (!writeError) writeError = err; })
        .then(() => { pending.delete(task); });
      pending.add(task);
    };

    for (let i = 0; i < total; i++) {
      if (renderCancelled) {
        await Promise.all(pending);
        throw new Error('已取消渲染');
      }
      const time = i / fps;
      // 一次 IPC 内完成「渲染该时刻 + 等一帧合成提交」：省一次往返，双 rAF 降为单 rAF
      await win.webContents.executeJavaScript(
        'Stage.renderAt(' + time + ').then(function () {'
        + '  return new Promise(function (resolve) { requestAnimationFrame(resolve); });'
        + '})');

      let image = await win.webContents.capturePage();
      const size = image.getSize();
      if (size.width !== width || size.height !== height) {
        image = image.resize({ width, height });
      }
      const jpeg = image.toJPEG(84);
      const name = String(i + 1).padStart(6, '0') + '.jpg';
      trackWrite(path.join(framesDir, name), jpeg);

      if (pending.size >= 8) {
        await Promise.race(pending);
      }
      if (i % 5 === 0 || i === total - 1) {
        event.sender.send('render:progress', { done: i + 1, total: total });
      }
    }
    await Promise.all(pending);
    if (writeError) throw writeError;
    return { frames: total };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
});

/* ---------------- 本地文件读取（备用） ---------------- */

ipcMain.handle('media:readLocal', async (_event, filePath) => {
  const stat = await fsp.stat(filePath);
  if (stat.size > 512 * 1024 * 1024) throw new Error('文件过大，超过 512MB');
  const data = await fsp.readFile(filePath);
  return { name: path.basename(filePath), data: data.buffer, size: stat.size };
});

ipcMain.handle('fs:ensureDir', async (_event, dir) => {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
});
