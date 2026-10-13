#!/usr/bin/env bash
# macOS 打包准备 + 出包
# 用法：
#   bash scripts/prepare-mac.sh all          # 本机全流程：依赖 + 构建 dmg（默认）
#   bash scripts/prepare-mac.sh deps         # 准备全部依赖（jar + JRE + 工具 + 模型）
#   bash scripts/prepare-mac.sh jre|tools|model|build   # 单独一步（CI 分步执行，失败可精确定位）
# 前置：Node.js + npm、Homebrew
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
  echo "== 内置 JRE 17（Adoptium Temurin，$ARCH） =="
  # 说明：macOS arm64 没有官方 Java 8 运行时；后端 jar 编译目标为 Java 8，
  #       在 JRE 17 上运行完全兼容（Spring Boot 2.7 官方支持 JDK 17）。
  if [ -x "$RES/backend/jre/bin/java" ]; then
    echo "已存在，跳过"
    return
  fi
  local url="https://api.adoptium.net/v3/binary/latest/17/ga/mac/${JARCH}/jre/hotspot/normal/eclipse"
  local tmp
  tmp="$(mktemp -d)"
  echo "下载：$url"
  if ! curl -fL --retry 3 --retry-delay 3 --connect-timeout 30 --max-time 900 -o "$tmp/jre.tar.gz" "$url"; then
    echo "JRE 下载失败，回退尝试 JDK …"
    url="https://api.adoptium.net/v3/binary/latest/17/ga/mac/${JARCH}/jdk/hotspot/normal/eclipse"
    if ! curl -fL --retry 3 --retry-delay 3 --connect-timeout 30 --max-time 1200 -o "$tmp/jre.tar.gz" "$url"; then
      echo "!! JRE 下载失败：请到 https://adoptium.net/temurin/releases/?version=17"
      echo "   手动下载 macOS ${JARCH} 的 JRE/JDK，解压后把 Contents/Home 放到 $RES/backend/jre"
      exit 1
    fi
  fi
  tar -xzf "$tmp/jre.tar.gz" -C "$tmp"
  local jhome
  # 注意：-maxdepth 必须在路径之后、其它条件之前（BSD find 的硬性要求，macOS 适用）
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

step_tools() {
  echo "== ffmpeg / ffprobe（npm 静态二进制，匹配 $ARCH） =="
  if [ ! -x "$RES/bin/ffmpeg" ] || [ ! -x "$RES/bin/ffprobe" ]; then
    ( cd desktop && npm i --no-save ffmpeg-static ffprobe-static )
    cp desktop/node_modules/ffmpeg-static/ffmpeg "$RES/bin/ffmpeg"
    local fp="desktop/node_modules/ffprobe-static/bin/darwin/${ARCH}/ffprobe"
    if [ ! -f "$fp" ]; then
      fp="$(find desktop/node_modules/ffprobe-static -type f -name ffprobe -print -quit)"
    fi
    if [ -z "$fp" ] || [ ! -f "$fp" ]; then
      echo "!! 未找到 ffprobe 二进制（ffprobe-static 安装可能失败）"
      exit 1
    fi
    cp "$fp" "$RES/bin/ffprobe"
  fi
  chmod +x "$RES/bin/ffmpeg" "$RES/bin/ffprobe"
  "$RES/bin/ffmpeg" -version 2>&1 | head -1 || true

  echo "== whisper-cli（whisper.cpp） =="
  if [ ! -x "$RES/bin/whisper-cli" ]; then
    if ! command -v whisper-cli >/dev/null 2>&1; then
      export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1
      if ! brew install whisper-cpp; then
        echo "首次安装失败，重试一次 …"
        brew install whisper-cpp
      fi
    fi
    cp "$(command -v whisper-cli)" "$RES/bin/whisper-cli"
  fi
  chmod +x "$RES/bin/whisper-cli"
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
  jre)   step_jre ;;
  tools) step_tools ;;
  model) step_model ;;
  deps)  step_jre; step_tools; step_model ;;
  all)   step_jre; step_tools; step_model; step_build ;;
  *)     echo "未知模式: $MODE（可用：all | deps | jre | tools | model | build）"; exit 1 ;;
esac
