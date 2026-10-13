package com.songmu.ktv.api;

import com.songmu.ktv.config.AppPaths;
import com.songmu.ktv.model.Project;
import com.songmu.ktv.model.SubtitleCue;
import com.songmu.ktv.model.TaskInfo;
import com.songmu.ktv.service.FfmpegService;
import com.songmu.ktv.service.ProjectStore;
import com.songmu.ktv.service.TaskManager;
import com.songmu.ktv.service.WhisperService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 启动识别：音频 → 16k WAV → whisper.cpp → 后处理 → 保存字幕。
 */
@RestController
@RequestMapping("/api/projects/{id}")
public class RecognizeController {

    private static final Logger log = LoggerFactory.getLogger(RecognizeController.class);

    private final ProjectStore store;
    private final AppPaths paths;
    private final FfmpegService ffmpeg;
    private final WhisperService whisper;
    private final TaskManager tasks;

    public RecognizeController(ProjectStore store, AppPaths paths, FfmpegService ffmpeg,
                               WhisperService whisper, TaskManager tasks) {
        this.store = store;
        this.paths = paths;
        this.ffmpeg = ffmpeg;
        this.whisper = whisper;
        this.tasks = tasks;
    }

    @PostMapping("/recognize")
    public Map<String, Object> recognize(@PathVariable final String id) {
        final Project project = store.get(id);
        if (project == null) {
            throw new IllegalArgumentException("项目不存在: " + id);
        }
        if (project.getAudio() == null) {
            throw new IllegalStateException("请先上传歌曲音频");
        }

        final TaskInfo task = tasks.create(id, "recognize");
        project.setSubtitleStatus("RUNNING");
        project.setSubtitleMessage("准备中");
        try {
            store.save(project);
        } catch (Exception ignored) {
            // 保存失败不阻塞识别
        }

        tasks.submit(task, new TaskManager.TaskBody() {
            @Override
            public void run(TaskInfo t) throws Exception {
                try {
                    tasks.progress(t, 1, "提取音频（16kHz 单声道）");
                    Path audio = paths.mediaDir(id).resolve(project.getAudio().getFileName());
                    Path wav = paths.workAudio(id);
                    ffmpeg.toWav16kMono(audio, wav);

                    tasks.progress(t, 3, "Whisper 识别中");
                    List<SubtitleCue> cues = whisper.recognize(wav, paths.whisperJson(id), t);

                    tasks.progress(t, 96, "保存字幕（" + cues.size() + " 行）");
                    store.saveSubtitles(id, cues);

                    Project fresh = store.get(id);
                    fresh.setCueCount(cues.size());
                    fresh.setSubtitleStatus("READY");
                    fresh.setSubtitleMessage(null);
                    store.save(fresh);

                    t.getResult().put("cueCount", cues.size());
                    log.info("识别完成 {}：{} 行", id, cues.size());
                } catch (Exception ex) {
                    Project fresh = store.get(id);
                    if (fresh != null) {
                        fresh.setSubtitleStatus("FAILED");
                        fresh.setSubtitleMessage(ex.getMessage());
                        store.save(fresh);
                    }
                    throw ex;
                }
            }
        });

        Map<String, Object> response = new LinkedHashMap<String, Object>();
        response.put("taskId", task.getId());
        response.put("status", task.getStatus());
        return response;
    }
}
