# KTV 歌词字幕制作器（ktv-maker）

功能目标：导入歌曲音频 + 背景素材 → Whisper 识别字幕 → KTV 逐字高亮字幕 → 导出 MP4。
技术栈：**Spring Boot 3（后端，Java 21） + Electron（前端） + whisper.cpp（识别） + ffmpeg（合成）**。

## 目录结构

```
ktv-maker/
├─ server/            Spring Boot 后端（Java 21）
│  ├─ pom.xml
│  └─ src/main/java/com/songmu/ktv/
│     ├─ KtvServerApplication.java
│     ├─ api/          REST 接口（项目、上传、识别、导出、系统）
│     ├─ service/      业务：Whisper / Ffmpeg / 项目存储 / 任务调度
│     ├─ model/        DTO / 实体
│     └─ config/       路径、CORS、静态资源
├─ desktop/           Electron 前端
│  ├─ package.json
│  ├─ main.js         主进程（窗口、IPC、逐帧渲染、调用后端）
│  ├─ preload.js
│  └─ renderer/       界面（HTML/CSS/JS）+ KTV 字幕舞台模板
└─ bin/               ffmpeg.exe / whisper-cli.exe / models/（首次运行自动下载）
```

## 数据存储

MVP 阶段**不使用数据库**：每个项目一个目录（`server/data/projects/<id>/`），元数据存 `project.json`，
音频/素材/字幕/导出产物都放项目目录内。后续如需数据库再单独确认。

## REST 接口（MVP）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/system/tools` | 探测 ffmpeg / whisper / 模型是否就绪 |
| GET | `/api/projects` | 项目列表 |
| POST | `/api/projects` | 新建项目 |
| GET | `/api/projects/{id}` | 项目详情（含媒体、字幕状态） |
| DELETE | `/api/projects/{id}` | 删除项目 |
| POST | `/api/projects/{id}/media/audio` | 上传歌曲音频（multipart） |
| POST | `/api/projects/{id}/media/background` | 上传背景素材：视频或图片（multipart，可多个） |
| POST | `/api/projects/{id}/recognize` | 启动识别 → 返回 taskId |
| GET | `/api/tasks/{taskId}` | 任务进度 / 结果（轮询） |
| GET | `/api/projects/{id}/subtitles` | 读取字幕时间轴 JSON |
| PUT | `/api/projects/{id}/subtitles` | 保存编辑后的字幕 |
| POST | `/api/projects/{id}/export` | 启动导出（Electron 送帧 → 后端 ffmpeg 合成） |
| POST | `/api/projects/{id}/export/frames` | 逐帧渲染上传（由 Electron 调用） |
| GET | `/api/projects/{id}/files/{name}` | 读取项目媒体文件（预览用） |

## 渲染分工

- **Electron**：加载 KTV 字幕舞台（HTML/CSS/Canvas 动画），按时间轴用 `capturePage()` 逐帧截图 → 交给后端
- **Spring Boot**：编排 whisper 识别、调用 ffmpeg 转码/合成（帧序列 + 音轨 → MP4）
- **whisper.cpp**：本地识别，`--output-json` + DTW 词级时间戳；后处理移植歌暮抗幻觉思路

## 运行方式（开发）

```powershell
# 后端（使用 _tools 下的 JDK21 + Maven）
$env:JAVA_HOME='e:\学习研究\音乐\_tools\jdk21'
e:\学习研究\音乐\_tools\maven\bin\mvn.cmd -f server/pom.xml spring-boot:run

# 前端
cd desktop
npm install
npm start
```

## 分阶段

- 阶段一（MVP）：音频+背景素材导入 → 识别 → KTV 双行逐字高亮 → 导出 1080p/30fps
- 阶段二：歌暮式时间轴修正与抗幻觉、多图轮播、模板/字体/颜色面板、波形装饰
