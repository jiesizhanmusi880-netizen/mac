package com.songmu.ktv.api;

import com.songmu.ktv.config.AppPaths;
import com.songmu.ktv.model.MediaInfo;
import com.songmu.ktv.model.Project;
import com.songmu.ktv.model.TaskInfo;
import com.songmu.ktv.service.FfmpegService;
import com.songmu.ktv.service.ProjectStore;
import com.songmu.ktv.service.TaskManager;
import com.songmu.ktv.service.ToolLocator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/**
 * 导出流程（Electron 渲染帧 + 后端 ffmpeg 合成）：
 *
 * 1) POST /export/plan    准备背景（视频转帧序列 / 图片转 1080p JPEG）、清空帧目录、返回参数
 * 2) Electron 逐帧写 JPEG 到 framesDir：000001.jpg ...
 * 3) POST /export/render  ffmpeg 合成 MP4（异步任务）
 * 4) GET  /bg/{file}      背景帧文件（前端 <img> 直接加载）
 */
@RestController
@RequestMapping("/api/projects/{id}")
public class ExportController {

    private static final Logger log = LoggerFactory.getLogger(ExportController.class);

    private final ProjectStore store;
    private final AppPaths paths;
    private final FfmpegService ffmpeg;
    private final TaskManager tasks;
    private final ToolLocator tools;
    private final int crf;
    private final String preset;

    public ExportController(ProjectStore store, AppPaths paths, FfmpegService ffmpeg, TaskManager tasks,
                            ToolLocator tools,
                            @Value("${ktv.ffmpeg.crf:18}") int crf,
                            @Value("${ktv.ffmpeg.preset:medium}") String preset) {
        this.store = store;
        this.paths = paths;
        this.ffmpeg = ffmpeg;
        this.tasks = tasks;
        this.tools = tools;
        this.crf = crf;
        this.preset = preset;
    }

    @PostMapping("/export/plan")
    public Map<String, Object> plan(@PathVariable String id, @RequestBody(required = false) Map<String, Object> body)
            throws IOException, InterruptedException {
        Project project = require(id);
        if (project.getAudio() == null) {
            throw new IllegalStateException("请先上传歌曲音频");
        }

        int fps = body != null && body.get("fps") != null ? ((Number) body.get("fps")).intValue() : 30;
        int width = body != null && body.get("width") != null ? ((Number) body.get("width")).intValue() : 1920;
        int height = body != null && body.get("height") != null ? ((Number) body.get("height")).intValue() : 1080;
        double duration = project.getAudio().getDuration() > 0 ? project.getAudio().getDuration() : 180;

        Path frames = paths.framesDir(id);
        cleanDirectory(frames);
        Files.createDirectories(frames);
        Files.createDirectories(paths.exportDir(id));

        Map<String, Object> background = prepareBackground(id, project, width, height, fps, duration);

        Map<String, Object> result = new LinkedHashMap<String, Object>();
        result.put("framesDir", frames.toAbsolutePath().toString());
        result.put("framePattern", "%06d.jpg");
        result.put("fps", fps);
        result.put("width", width);
        result.put("height", height);
        result.put("duration", duration);
        result.put("audioFile", paths.mediaDir(id).resolve(project.getAudio().getFileName()).toAbsolutePath().toString());
        result.put("audioUrl", "/api/projects/" + id + "/media/files/" + project.getAudio().getFileName());
        result.put("background", background);
        return result;
    }

    @GetMapping("/bg/{fileName}")
    public ResponseEntity<Resource> backgroundFile(@PathVariable String id, @PathVariable String fileName)
            throws IOException {
        Path dir = paths.projectDir(id).resolve("bg").normalize();
        Path target = dir.resolve(fileName).normalize();
        if (!target.startsWith(dir) || !Files.exists(target)) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok()
                .contentType(MediaType.IMAGE_JPEG)
                .body(new FileSystemResource(target.toFile()));
    }

    @PostMapping("/export/render")
    public Map<String, Object> render(@PathVariable final String id,
                                      @RequestBody(required = false) Map<String, Object> body) {
        final Project project = require(id);
        final int fps = body != null && body.get("fps") != null ? ((Number) body.get("fps")).intValue() : 30;
        final double duration = project.getAudio() == null ? 0 : project.getAudio().getDuration();

        final TaskInfo task = tasks.create(id, "export");
        project.setExportStatus("RUNNING");
        project.setExportMessage("合成中");
        try {
            store.save(project);
        } catch (IOException ignored) {
            // 忽略
        }

        tasks.submit(task, new TaskManager.TaskBody() {
            @Override
            public void run(TaskInfo t) throws Exception {
                try {
                    Path frames = paths.framesDir(id);
                    Path audio = paths.mediaDir(id).resolve(project.getAudio().getFileName());
                    Path out = paths.exportDir(id).resolve(safeName(project.getName()) + "-ktv.mp4");

                    tasks.progress(t, 1, "合成视频（帧序列 + 音轨）");
                    ffmpeg.encodeFrames(frames, fps, audio, out, crf, preset, duration,
                            new FfmpegService.ProgressSink() {
                                @Override
                                public void onProgress(double ratio, String rawLine) {
                                    if (ratio >= 0) {
                                        t.setProgress((int) Math.round(ratio * 100));
                                        t.setUpdatedAt(System.currentTimeMillis());
                                    }
                                }
                            });

                    Project fresh = store.get(id);
                    fresh.setExportStatus("DONE");
                    fresh.setExportPath(out.toAbsolutePath().toString());
                    fresh.setExportMessage(null);
                    store.save(fresh);

                    t.getResult().put("output", out.toAbsolutePath().toString());
                    log.info("导出完成 {} -> {}", id, out);
                } catch (Exception ex) {
                    Project fresh = store.get(id);
                    if (fresh != null) {
                        fresh.setExportStatus("FAILED");
                        fresh.setExportMessage(ex.getMessage());
                        store.save(fresh);
                    }
                    throw ex;
                }
            }
        });

        Map<String, Object> response = new LinkedHashMap<String, Object>();
        response.put("taskId", task.getId());
        return response;
    }

    /* ---------------- 背景准备 ---------------- */

    private Map<String, Object> prepareBackground(String id, Project project, int width, int height,
                                                  int fps, double duration)
            throws IOException, InterruptedException {
        Map<String, Object> background = new LinkedHashMap<String, Object>();
        List<MediaInfo> list = project.getBackgrounds();
        if (list == null || list.isEmpty()) {
            background.put("kind", "none");
            return background;
        }

        MediaInfo media = list.get(0);
        Path source = paths.mediaDir(id).resolve(media.getFileName());
        Path bgDir = paths.projectDir(id).resolve("bg");
        String bgUrlBase = "/api/projects/" + id + "/bg/";

        if ("image".equals(media.getKind())) {
            Path target = bgDir.resolve("000001.jpg");
            if (!Files.exists(target) || Files.size(target) == 0) {
                Files.createDirectories(bgDir);
                log.info("转换背景图片 → {}x{}", width, height);
                List<String> cmd = Arrays.asList(
                        tools.ffmpeg().toString(), "-y",
                        "-i", source.toString(),
                        "-vf", "scale=" + width + ":" + height + ":force_original_aspect_ratio=increase,"
                                + "crop=" + width + ":" + height,
                        "-frames:v", "1",
                        "-q:v", "3",
                        target.toString());
                runQuiet(cmd);
            }
            background.put("kind", "image");
            background.put("imageUrl", bgUrlBase + "000001.jpg");
            return background;
        }

        int expected = (int) Math.ceil(duration * fps);
        boolean cached = countFiles(bgDir) >= expected - 2;
        if (!cached) {
            log.info("生成背景帧序列：{} 帧（{}x{} @{}fps，{:.1f}s）",
                    expected, width, height, fps, duration);
            cleanDirectory(bgDir);
            Files.createDirectories(bgDir);
            ffmpeg.extractBackgroundFrames(source, bgDir, width, height, fps, duration);
        } else {
            log.info("复用已有背景帧序列 {} 帧", countFiles(bgDir));
        }
        background.put("kind", "frames");
        background.put("framesDir", bgUrlBase);
        background.put("frameCount", countFiles(bgDir));
        return background;
    }

    private void runQuiet(List<String> cmd) throws IOException, InterruptedException {
        Process process = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        try (InputStream in = process.getInputStream()) {
            byte[] buffer = new byte[4096];
            while (in.read(buffer) != -1) {
                // 丢弃输出
            }
        }
        if (!process.waitFor(600, java.util.concurrent.TimeUnit.SECONDS)) {
            process.destroyForcibly();
            throw new IOException("背景处理超时");
        }
        if (process.exitValue() != 0) {
            throw new IOException("背景处理失败(" + process.exitValue() + ")");
        }
    }

    private static int countFiles(Path dir) throws IOException {
        if (!Files.exists(dir)) {
            return 0;
        }
        try (Stream<Path> stream = Files.list(dir)) {
            return (int) stream.filter(Files::isRegularFile).count();
        }
    }

    private Project require(String id) {
        Project project = store.get(id);
        if (project == null) {
            throw new IllegalArgumentException("项目不存在: " + id);
        }
        return project;
    }

    private static void cleanDirectory(Path dir) throws IOException {
        if (!Files.exists(dir)) {
            return;
        }
        Files.walk(dir).sorted(Comparator.reverseOrder()).forEach(p -> {
            try {
                if (!p.equals(dir)) {
                    Files.deleteIfExists(p);
                }
            } catch (IOException ignored) {
                // 尽力清理
            }
        });
    }

    private static String safeName(String name) {
        if (name == null || name.trim().isEmpty()) {
            return "output";
        }
        return name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
    }
}
