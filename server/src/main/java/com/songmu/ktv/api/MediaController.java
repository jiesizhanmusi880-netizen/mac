package com.songmu.ktv.api;

import com.songmu.ktv.config.AppPaths;
import com.songmu.ktv.model.MediaInfo;
import com.songmu.ktv.model.Project;
import com.songmu.ktv.model.SubtitleCue;
import com.songmu.ktv.model.WordTiming;
import com.songmu.ktv.service.FfmpegService;
import com.songmu.ktv.service.ProjectStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 媒体上传与预览：
 * - 音频（歌曲）
 * - 背景素材（视频 / 图片，可多个）
 */
@RestController
@RequestMapping("/api/projects/{id}/media")
public class MediaController {

    private static final Logger log = LoggerFactory.getLogger(MediaController.class);

    private final ProjectStore store;
    private final FfmpegService ffmpeg;
    private final AppPaths paths;

    public MediaController(ProjectStore store, FfmpegService ffmpeg, AppPaths paths) {
        this.store = store;
        this.ffmpeg = ffmpeg;
        this.paths = paths;
    }

    @PostMapping("/audio")
    public Project uploadAudio(@PathVariable String id, @RequestParam("file") MultipartFile file) throws Exception {
        Project project = require(id);
        MediaInfo info = storeMedia(id, file, "audio");
        project.setAudio(info);
        project.setSubtitleStatus("EMPTY");
        project.setCueCount(0);
        store.save(project);
        return project;
    }

    @PostMapping("/background")
    public Project uploadBackground(@PathVariable String id, @RequestParam("file") MultipartFile file) throws Exception {
        Project project = require(id);
        MediaInfo info = storeMedia(id, file, null);
        project.getBackgrounds().add(info);
        store.save(project);
        return project;
    }

    @DeleteMapping("/background/{mediaId}")
    public Project removeBackground(@PathVariable String id, @PathVariable String mediaId) throws Exception {
        Project project = require(id);
        Iterator<MediaInfo> it = project.getBackgrounds().iterator();
        while (it.hasNext()) {
            MediaInfo info = it.next();
            if (mediaId.equals(info.getId())) {
                Path file = paths.mediaDir(id).resolve(info.getFileName());
                Files.deleteIfExists(file);
                it.remove();
            }
        }
        store.save(project);
        return project;
    }

    /* ---------------- 音频裁剪（先在播放头处分割，再删掉不要的片段） ---------------- */

    /**
     * 删除音频区间 [start, end)：生成新的音频文件（原文件保留在 media 目录）、更新工程音频，
     * 并同步平移歌词时间（落在区间内的行整行删除）。可通过 /audio/undo-cut 撤销一步。
     */
    @PostMapping("/audio/cut")
    public Map<String, Object> cutAudio(@PathVariable String id,
                                        @RequestBody(required = false) Map<String, Object> body)
            throws Exception {
        Project project = require(id);
        MediaInfo audio = project.getAudio();
        if (audio == null) {
            throw new IllegalStateException("请先上传歌曲音频");
        }
        if (body == null || body.get("start") == null || body.get("end") == null) {
            throw new IllegalArgumentException("缺少 start / end 参数");
        }
        double duration = audio.getDuration();
        double start = Math.max(0, Math.min(((Number) body.get("start")).doubleValue(), duration));
        double end = Math.max(0, Math.min(((Number) body.get("end")).doubleValue(), duration));
        double len = end - start;
        if (len < 0.2) {
            throw new IllegalArgumentException("要删除的区间太短（至少 0.2 秒）");
        }
        if (duration - len < 0.5) {
            throw new IllegalArgumentException("删除后剩余音频不足 0.5 秒，已取消");
        }

        Path dir = paths.mediaDir(id);
        Path source = dir.resolve(audio.getFileName());
        if (!Files.exists(source)) {
            throw new IllegalStateException("音频文件不存在: " + audio.getFileName());
        }
        String ext = extensionOf(audio.getFileName());
        String fileName = UUID.randomUUID().toString().replace("-", "").substring(0, 10)
                + (ext.isEmpty() ? "" : "." + ext);
        Path target = dir.resolve(fileName);

        log.info("裁剪音频 [{}] {}", id, audio.getFileName()
                + " 删除 " + String.format("%.3f", start) + " → " + String.format("%.3f", end)
                + "s（共 " + String.format("%.2f", len) + "s）");
        ffmpeg.cutAudio(source, target, start, end);

        // 歌词同步：区间之后的行整体前移，落入 / 跨越区间的行删除
        List<SubtitleCue> cues = store.loadSubtitles(id);
        List<SubtitleCue> kept = new ArrayList<SubtitleCue>();
        int removed = 0;
        int shifted = 0;
        for (SubtitleCue cue : cues) {
            if (cue.getEnd() <= start + 1e-6) {
                kept.add(cue);
            } else if (cue.getStart() >= end - 1e-6) {
                shiftCue(cue, -len);
                shifted++;
                kept.add(cue);
            } else {
                removed++;
            }
        }
        store.saveSubtitlesBackup(id, cues);      // 备份：供「撤销裁剪」
        store.saveSubtitles(id, kept);

        // 音频信息：保留原 id / 原始文件名 / mimeType，只替换文件与时长
        MediaInfo next = ffmpeg.probe(target, "audio");
        next.setId(audio.getId());
        next.setFileName(fileName);
        next.setOriginalName(audio.getOriginalName());
        next.setMimeType(audio.getMimeType());
        next.setUploadedAt(System.currentTimeMillis());
        project.setAudioPrev(audio);
        project.setAudio(next);
        project.setCueCount(kept.size());
        store.save(project);
        log.info("裁剪完成 [{}] {}", id, fileName + " 新时长 " + String.format("%.2f", next.getDuration())
                + "s，删除歌词 " + removed + " 行，平移 " + shifted + " 行");

        Map<String, Object> result = new LinkedHashMap<String, Object>();
        result.put("project", project);
        result.put("removedCues", removed);
        result.put("shiftedCues", shifted);
        result.put("newDuration", next.getDuration());
        return result;
    }

    /** 撤销上一步音频裁剪：换回上一份音频（文件仍在磁盘上）与歌词备份。 */
    @PostMapping("/audio/undo-cut")
    public Map<String, Object> undoCutAudio(@PathVariable String id) throws Exception {
        Project project = require(id);
        MediaInfo prev = project.getAudioPrev();
        if (prev == null) {
            throw new IllegalStateException("没有可撤销的音频裁剪");
        }
        project.setAudio(prev);
        project.setAudioPrev(null);
        List<SubtitleCue> backup = store.loadSubtitlesBackup(id);
        if (backup != null) {
            store.saveSubtitles(id, backup);
            project.setCueCount(backup.size());
        }
        store.save(project);
        log.info("撤销音频裁剪 [{}] 恢复为 {}", id, prev.getFileName());

        Map<String, Object> result = new LinkedHashMap<String, Object>();
        result.put("project", project);
        result.put("cueCount", project.getCueCount());
        return result;
    }

    /** 整行平移歌词（行级时间 + 逐字时间）。 */
    private static void shiftCue(SubtitleCue cue, double delta) {
        cue.setStart(Math.max(0, cue.getStart() + delta));
        cue.setEnd(Math.max(0, cue.getEnd() + delta));
        List<WordTiming> words = cue.getWords();
        if (words != null) {
            for (WordTiming word : words) {
                word.setStart(Math.max(0, word.getStart() + delta));
                word.setEnd(Math.max(0, word.getEnd() + delta));
            }
        }
    }

    /** 项目内媒体文件预览（音频/视频/图片直接给 <audio>/<video>/<img> 用）。 */
    @GetMapping("/files/{fileName}")
    public ResponseEntity<Resource> file(@PathVariable String id, @PathVariable String fileName) throws IOException {
        Path target = paths.mediaDir(id).resolve(fileName).normalize();
        if (!target.startsWith(paths.mediaDir(id)) || !Files.exists(target)) {
            return ResponseEntity.notFound().build();
        }
        Resource resource = new FileSystemResource(target.toFile());
        String probe = Files.probeContentType(target);
        MediaType type = probe == null ? MediaType.APPLICATION_OCTET_STREAM : MediaType.parseMediaType(probe);
        return ResponseEntity.ok()
                .header(HttpHeaders.ACCEPT_RANGES, "bytes")
                .contentType(type)
                .body(resource);
    }

    /**
     * 视频素材缩略图（素材轨胶片条用）：按时间点抽帧，结果缓存到项目 thumbs 目录。
     * 例：/api/projects/{id}/media/thumb/{fileName}?t=2.5&w=240
     */
    @GetMapping("/thumb/{fileName}")
    public ResponseEntity<Resource> thumbnail(@PathVariable String id, @PathVariable String fileName,
                                              @RequestParam(value = "t", defaultValue = "1") double time,
                                              @RequestParam(value = "w", defaultValue = "240") int width)
            throws Exception {
        Path source = paths.mediaDir(id).resolve(fileName).normalize();
        if (!source.startsWith(paths.mediaDir(id)) || !Files.exists(source)) {
            return ResponseEntity.notFound().build();
        }
        Path dir = paths.projectDir(id).resolve("thumbs");
        Files.createDirectories(dir);
        String key = fileName.replaceAll("[^A-Za-z0-9._-]", "_")
                + "_" + (int) Math.round(time * 10) + "_" + width + ".jpg";
        Path target = dir.resolve(key);
        if (!Files.exists(target) || Files.size(target) == 0) {
            ffmpeg.extractThumbnail(source, time, width, target);
        }
        if (!Files.exists(target)) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok()
                .contentType(MediaType.IMAGE_JPEG)
                .header(HttpHeaders.CACHE_CONTROL, "public, max-age=86400")
                .body(new FileSystemResource(target.toFile()));
    }

    /* ---------------- 内部 ---------------- */

    private Project require(String id) {
        Project project = store.get(id);
        if (project == null) {
            throw new IllegalArgumentException("项目不存在: " + id);
        }
        return project;
    }

    private MediaInfo storeMedia(String projectId, MultipartFile file, String kindHint) throws Exception {
        Path dir = paths.mediaDir(projectId);
        Files.createDirectories(dir);

        String original = file.getOriginalFilename() == null ? "media" : file.getOriginalFilename();
        String ext = extensionOf(original);
        String fileName = UUID.randomUUID().toString().replace("-", "").substring(0, 10)
                + (ext.isEmpty() ? "" : "." + ext);
        Path target = dir.resolve(fileName);
        file.transferTo(target.toFile());
        log.info("保存媒体 [{}/{}] {} bytes", projectId, fileName, file.getSize());

        MediaInfo info = ffmpeg.probe(target, kindHint != null ? kindHint : guessKind(ext));
        info.setId(UUID.randomUUID().toString().replace("-", "").substring(0, 10));
        info.setFileName(fileName);
        info.setOriginalName(original);
        info.setMimeType(file.getContentType());
        info.setUploadedAt(System.currentTimeMillis());
        return info;
    }

    /** 按扩展名推断素材类型，作为 ffprobe 的兜底判断 */
    private static String guessKind(String ext) {
        if (ext == null) {
            return null;
        }
        String e = ext.toLowerCase();
        if (e.equals("mp3") || e.equals("wav") || e.equals("flac") || e.equals("m4a")
                || e.equals("aac") || e.equals("ogg") || e.equals("opus") || e.equals("wma")) {
            return "audio";
        }
        if (e.equals("jpg") || e.equals("jpeg") || e.equals("png") || e.equals("webp")
                || e.equals("gif") || e.equals("bmp") || e.equals("tif") || e.equals("tiff")
                || e.equals("avif") || e.equals("heic")) {
            return "image";
        }
        if (e.equals("mp4") || e.equals("mov") || e.equals("mkv") || e.equals("avi")
                || e.equals("webm") || e.equals("m4v") || e.equals("flv")) {
            return "video";
        }
        return null;
    }

    private static String extensionOf(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) {
            return "";
        }
        return name.substring(dot + 1).toLowerCase();
    }
}
