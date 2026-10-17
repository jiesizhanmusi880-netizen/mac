'use strict';
/**
 * 无开发者证书时的 ad-hoc 签名（electron-builder afterPack 钩子）。
 *
 * 背景：Apple Silicon（arm64）要求 app bundle 及其内部所有可执行文件都带代码签名，
 * 否则 macOS 会报「"KFC Music" 已损坏，无法打开」。CI 没有开发者证书，
 * electron-builder 默认跳过签名，因此这里补一次 ad-hoc 签名。
 *
 * 注意：extraResources 里的 jre/bin/java、ffmpeg、ffprobe、whisper-cli 都是可执行文件，
 * 必须一并签名，所以使用 --deep 递归处理整个 app bundle。
 *
 * 若配置了正式证书（CSC_LINK / CSC_NAME），这里不处理，交给 electron-builder 正常签名。
 */
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log('[afterPack] 检测到开发者证书，跳过 ad-hoc 签名（交给 electron-builder）');
    return;
  }
  const product = context.packager.appInfo.productFilename;
  const appPath = `${context.appOutDir}/${product}.app`;
  console.log('[afterPack] ad-hoc 签名：' + appPath);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--verbose=2', appPath], { stdio: 'inherit' });
  console.log('[afterPack] ad-hoc 签名完成并通过校验');
};
