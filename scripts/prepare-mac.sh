#!/usr/bin/env bash
# macOS 打包准备 + 出包
# 用法：
#   bash scripts/prepare-mac.sh          # 本机全流程：准备依赖 + 构建 dmg
#   bash scripts/prepare-mac.sh deps     # 只准备依赖（GitHub Actions 等 CI 用）
# 前置：Node.js + npm、Homebrew
#      后端 jar 已放在 dist-resources/backend/ktv-server.jar（由 mvn package 构建，跨平台通用）
set -euo pipefail
cd "$(dirname "$0")/.."                 # → ktv-maker/
MODE="${1:-all}"
RES="dist-resources"
ARCH="$(uname -m)"                      # arm64（Apple Silicon）/ x86_64（Intel）

echo "== 1/5 目录准备 =="
mkdir -p "$RES/backend" "$RES/bin/models"

if [ ! -f "$RES/backend/ktv-server.jar" ]; then
  echo "!! 缺少后端 jar：$RES/backend/ktv-server.jar"
  echo "   本项目根执行：mvn -f server/pom.xml -q -DskipTests package"
  echo "   再执行：cp server/target/ktv-server-0.1.0.jar $RES/backend/ktv-server.jar"
  exit 1
fi

echo "== 2/5 内置 JRE 17（Adoptium Temurin，$ARCH） =="
# 说明：macOS arm64 没有官方 Java 8 运行时；后端 jar 编译目标为 Java 8，
#       在 JRE 17 上运行完全兼容（Spring Boot 2.7 官方支持 JDK 17）。
if [ ! -x "$RES/backend/jre/bin/java" ]; then
  if [ "$ARCH" = "arm64" ]; then JARCH="aarch64"; else JARCH="x64"; fi
  JURL="https://api.adoptium.net/v3/binary/latest/17/ga/mac/${JARCH}/jre/hotspot/normal/eclipse"
  TMP="$(mktemp -d)"
  echo "下载 Temurin JRE 17 …"
  if ! curl -fL "$JURL" -o "$TMP/jre.tar.gz"; then
    echo "!! JRE 下载失败：请到 https://adoptium.net/temurin/releases/?version=17"
    echo "   手动下载 macOS ${JARCH} 的 JRE，解压后把 Contents/Home 放到 $RES/backend/jre"
    exit 1
  fi
  tar -xzf "$TMP/jre.tar.gz" -C "$TMP"
  JHOME="$(find "$TMP" -type d -path '*Contents/Home' -maxdepth 4 | head -1)"
  if [ -n "$JHOME" ]; then mv "$JHOME" "$RES/backend/jre"; else mv "$TMP"/* "$RES/backend/jre"; fi
  rm -rf "$TMP"
fi
chmod +x "$RES/backend/jre/bin/java"

echo "== 3/5 ffmpeg / ffprobe（npm 静态二进制，自动匹配架构） =="
if [ ! -x "$RES/bin/ffmpeg" ] || [ ! -x "$RES/bin/ffprobe" ]; then
  ( cd desktop && npm i --no-save ffmpeg-static ffprobe-static )
  cp desktop/node_modules/ffmpeg-static/ffmpeg "$RES/bin/ffmpeg"
  FFPROBE="$(find desktop/node_modules/ffprobe-static -type f -name ffprobe -path '*darwin*' | head -1)"
  [ -n "$FFPROBE" ] || { echo "!! 未找到 darwin 版 ffprobe"; exit 1; }
  cp "$FFPROBE" "$RES/bin/ffprobe"
fi
chmod +x "$RES/bin/ffmpeg" "$RES/bin/ffprobe"

echo "== 4/5 whisper-cli（whisper.cpp） =="
if [ ! -x "$RES/bin/whisper-cli" ]; then
  if ! command -v whisper-cli >/dev/null 2>&1; then
    brew install whisper-cpp
  fi
  cp "$(command -v whisper-cli)" "$RES/bin/whisper-cli"
fi
chmod +x "$RES/bin/whisper-cli"

echo "== 5/5 medium 模型（约 1.5GB，只需下载一次） =="
if [ ! -f "$RES/bin/models/ggml-medium.bin" ]; then
  OK=""
  for URL in \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin" \
    "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin"; do
    echo "下载 ggml-medium.bin ← $URL"
    if curl -fL --retry 2 -o "$RES/bin/models/ggml-medium.bin" "$URL"; then OK=1; break; fi
  done
  if [ -z "$OK" ]; then
    echo "!! 模型下载失败：请手动下载 ggml-medium.bin 放到 $RES/bin/models/"
    exit 1
  fi
fi

if [ "$MODE" = "deps" ]; then
  echo "== 依赖准备完成（deps 模式，跳过打包） =="
  exit 0
fi

echo "== 构建 dmg =="
cd desktop
npm i
npm run dist:mac
echo
echo "完成！安装包在 ktv-maker/dist/ 下（KFC Music-0.1.0-*.dmg）"
