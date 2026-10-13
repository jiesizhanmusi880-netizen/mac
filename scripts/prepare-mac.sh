#!/usr/bin/env bash
# macOS 打包准备 + 出包
# 用法：
#   bash scripts/prepare-mac.sh all              # 本机全流程：依赖 + 构建 dmg（默认）
#   bash scripts/prepare-mac.sh deps             # 准备全部依赖（JRE + ffmpeg + whisper + 模型）
#   bash scripts/prepare-mac.sh jre|ffmpeg|whisper|model|build   # 单独一步（CI 分步执行）
# 前置：Node.js + npm；首次会在本地编译 whisper.cpp（需要 Xcode 命令行工具 / cmake）
#      后端 jar 已放在 dist-resources/backend/ktv-server.jar（mvn package 构建，跨平台通用）
set -euo pipefail
cd "$(dirname "$0")/.."                 # → ktv-maker/
MODE="${1:-all}"
RES="dist-resources"
ARCH="$(uname -m)"                      # arm64（Apple Silicon）/ x86_64（Intel）
JARCH="x64"
if [ "$ARCH" = "arm64" ]; then JARCH="aarch64"; fi

step_dirs() {
  echo "== 目录准备 =="
  mkdir -p "$RES/backend" "$RES/bin/models"
  if [ ! -f "$RES/backend/ktv-server.jar" ]; then
    echo "!! 缺少后端 jar：$RES/backend/ktv-server.jar"
    echo "   在项目根执行：mvn -f server/pom.xml -q -DskipTests package"
    echo "   再执行：cp server/target/ktv-server-0.1.0.jar $RES/backend/ktv-server.jar"
    exit 1
  fi
}

step_jre() {
  echo "== 内置 JRE 17 =="
  # 说明：macOS arm64 没有官方 Java 8；后端 jar 编译目标为 Java 8，在 JRE 17 上运行完全兼容。
  if [ -x "$RES/backend/jre/bin/java" ]; then
    echo "已存在，跳过"
    return
  fi
  # 优先：使用本机已安装的 JDK（CI 里由 setup-java 提供 JAVA_HOME），零网络风险
  if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
    echo "使用已安装的 JDK 作为内置运行时：$JAVA_HOME"
    mkdir -p "$RES/backend/jre"
    cp -R "$JAVA_HOME"/. "$RES/backend/jre"/
    # 精简：删掉编译/开发组件（运行时不需要，省 ~100MB）
    rm -rf "$RES/backend/jre/jmods" "$RES/backend/jre/include" "$RES/backend/jre/man" \
           "$RES/backend/jre/lib/src.zip" 2>/dev/null || true
    chmod +x "$RES/backend/jre/bin/java"
    "$RES/backend/jre/bin/java" -version 2>&1 | head -1 || true
    return
  fi
  # 回退：联网下载 Temurin（本机模式且未装 JDK 时）
  local url="https://api.adoptium.net/v3/binary/latest/17/ga/mac/${JARCH}/jre/hotspot/normal/eclipse"
  local tmp
  tmp="$(mktemp -d)"
  echo "未检测到 JAVA_HOME，联网下载：$url"
  if ! curl -fL --retry 3 --retry-delay 3 --connect-timeout 30 --max-time 900 -o "$tmp/jre.tar.gz" "$url"; then
    url="https://api.adoptium.net/v3/binary/latest/17/ga/mac/${JARCH}/jdk/hotspot/normal/eclipse"
    echo "JRE 下载失败，回退 JDK 包：$url"
    if ! curl -fL --retry 3 --retry-delay 3 --connect-timeout 30 --max-time 1200 -o "$tmp/jre.tar.gz" "$url"; then
      echo "!! 下载失败：请到 https://adoptium.net/temurin/releases/?version=17 手动下载"
      echo "   macOS ${JARCH} 的 JRE/JDK，解压后把 Contents/Home 放到 $RES/backend/jre"
      exit 1
    fi
  fi
  tar -xzf "$tmp/jre.tar.gz" -C "$tmp"
  local jhome
  jhome="$(find "$tmp" -maxdepth 4 -type d -path '*Contents/Home' -print -quit)"
  if [ -n "$jhome" ]; then
    mv "$jhome" "$RES/backend/jre"
  else
    mv "$tmp"/* "$RES/backend/jre"
  fi
  rm -rf "$tmp"
  chmod +x "$RES/backend/jre/bin/java"
  "$RES/backend/jre/bin/java" -version 2>&1 | head -1 || true
}

step_ffmpeg() {
  echo "== ffmpeg / ffprobe（官方静态二进制，匹配 $ARCH） =="
  # 二进制来源：ffmpeg-static 的官方 release（与 npm 包 ffmpeg-static@5.3.0 同源，tag b6.1.1）。
  # 直接 curl 下载，不再经 npm——避免连带安装 desktop 的 electron 依赖树（上百 MB），失败面最小。
  local barch="x64"
  if [ "$ARCH" = "arm64" ]; then barch="arm64"; fi
  local tag="b6.1.1"
  local base="https://github.com/eugeneware/ffmpeg-static/releases/download/$tag"
  local mirror="https://registry.npmmirror.com/-/binary/ffmpeg-static/$tag"
  local tmp
  tmp="$(mktemp -d)"
  local name url ok
  for name in ffmpeg ffprobe; do
    if [ -x "$RES/bin/$name" ]; then
      echo "$name 已存在，跳过"
      continue
    fi
    ok=""
    for url in "$base/$name-darwin-$barch.gz" "$mirror/$name-darwin-$barch.gz"; do
      echo "下载 $name ← $url"
      if curl -fL --retry 3 --retry-delay 3 --connect-timeout 30 --max-time 900 -o "$tmp/$name.gz" "$url" \
         && gunzip -c "$tmp/$name.gz" > "$tmp/$name"; then
        cp "$tmp/$name" "$RES/bin/$name"
        ok=1
        break
      fi
    done
    if [ -z "$ok" ]; then
      echo "!! $name 下载失败：请手动下载 $name-darwin-$barch.gz，解压后放到 $RES/bin/$name"
      rm -rf "$tmp"
      exit 1
    fi
  done
  rm -rf "$tmp"
  chmod +x "$RES/bin/ffmpeg" "$RES/bin/ffprobe"
  "$RES/bin/ffmpeg" -version 2>&1 | head -1 || true
  "$RES/bin/ffprobe" -version 2>&1 | head -1 || true
}

step_whisper() {
  echo "== whisper-cli（whisper.cpp 静态编译，保证拷进 app 后可直接运行） =="
  if [ -x "$RES/bin/whisper-cli" ]; then
    echo "已存在，跳过"
    return
  fi
  local wdir
  wdir="$(mktemp -d)"
  echo "克隆 whisper.cpp …"
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$wdir/src"
  echo "编译 whisper-cli（静态链接，约 2~4 分钟）…"
  cmake -B "$wdir/src/build" -S "$wdir/src" \
    -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF \
    -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON
  cmake --build "$wdir/src/build" --config Release -j 4 --target whisper-cli \
    || cmake --build "$wdir/src/build" --config Release -j 4 --target main
  local bin="$wdir/src/build/bin/whisper-cli"
  if [ ! -f "$bin" ]; then bin="$wdir/src/build/bin/main"; fi
  if [ ! -f "$bin" ]; then
    echo "!! 未找到编译产物（whisper-cli / main）"
    exit 1
  fi
  cp "$bin" "$RES/bin/whisper-cli"
  rm -rf "$wdir"
  chmod +x "$RES/bin/whisper-cli"
  "$RES/bin/whisper-cli" --help 2>&1 | head -1 || true
}

step_model() {
  echo "== medium 模型（约 1.5GB） =="
  if [ -f "$RES/bin/models/ggml-medium.bin" ]; then
    echo "已存在，跳过"
    return
  fi
  local ok=""
  for url in \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin" \
    "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin"; do
    echo "下载 ggml-medium.bin ← $url"
    if curl -fL --retry 3 --retry-delay 3 --connect-timeout 30 --max-time 1800 \
        -o "$RES/bin/models/ggml-medium.bin" "$url"; then
      ok=1
      break
    fi
  done
  if [ -z "$ok" ]; then
    echo "!! 模型下载失败：请手动下载 ggml-medium.bin 放到 $RES/bin/models/"
    exit 1
  fi
  ls -lh "$RES/bin/models/ggml-medium.bin"
}

step_build() {
  echo "== 构建 dmg =="
  cd desktop
  npm i
  npm run dist:mac
  echo
  echo "完成！安装包在 ktv-maker/dist/ 下（KFC Music-0.1.0-*.dmg）"
}

step_dirs
case "$MODE" in
  jre)     step_jre ;;
  ffmpeg)  step_ffmpeg ;;
  whisper) step_whisper ;;
  tools)   step_ffmpeg; step_whisper ;;
  model)   step_model ;;
  deps)    step_jre; step_ffmpeg; step_whisper; step_model ;;
  all)     step_jre; step_ffmpeg; step_whisper; step_model; step_build ;;
  build)   step_build ;;
  *)       echo "未知模式: $MODE（可用：all | deps | jre | ffmpeg | whisper | model | build）"; exit 1 ;;
esac
