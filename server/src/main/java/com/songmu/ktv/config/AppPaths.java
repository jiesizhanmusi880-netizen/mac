package com.songmu.ktv.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * 统一管理运行期目录：
 * - 数据目录：项目元数据、媒体、字幕、导出产物
 * - 工具目录：ffmpeg / ffprobe / whisper-cli / models
 */
@Component
public class AppPaths {

    private final Path dataDir;
    private final Path binDir;
    private final Path modelsDir;

    public AppPaths(@Value("${ktv.data-dir:./data}") String dataDir,
                    @Value("${ktv.bin-dir:../bin}") String binDir,
                    @Value("${ktv.models-dir:}") String modelsDir) {
        this.dataDir = Paths.get(dataDir).toAbsolutePath().normalize();
        this.binDir = Paths.get(binDir).toAbsolutePath().normalize();
        // 模型目录：默认 bin/models；打包运行时由桌面端传 --ktv.models-dir 指向用户可写目录
        // （语音识别模型不进安装包，改为首次使用时在应用内下载，见 desktop/main.js）
        this.modelsDir = (modelsDir == null || modelsDir.trim().isEmpty())
                ? this.binDir.resolve("models")
                : Paths.get(modelsDir).toAbsolutePath().normalize();
    }

    @PostConstruct
    public void init() throws IOException {
        Files.createDirectories(projectsDir());
    }

    public Path dataDir() {
        return dataDir;
    }

    public Path projectsDir() {
        return dataDir.resolve("projects");
    }

    public Path binDir() {
        return binDir;
    }

    public Path modelsDir() {
        return modelsDir;
    }

    public Path projectDir(String projectId) {
        return projectsDir().resolve(projectId);
    }

    public Path mediaDir(String projectId) {
        return projectDir(projectId).resolve("media");
    }

    public Path framesDir(String projectId) {
        return projectDir(projectId).resolve("frames");
    }

    public Path exportDir(String projectId) {
        return projectDir(projectId).resolve("export");
    }

    public Path projectJson(String projectId) {
        return projectDir(projectId).resolve("project.json");
    }

    public Path subtitleJson(String projectId) {
        return projectDir(projectId).resolve("subtitles.json");
    }

    /** 音频裁剪前的歌词备份（只保留一步，供「撤销裁剪」还原） */
    public Path subtitleBackupJson(String projectId) {
        return projectDir(projectId).resolve("subtitles.prev.json");
    }

    public Path whisperJson(String projectId) {
        return projectDir(projectId).resolve("whisper.json");
    }

    public Path workAudio(String projectId) {
        return projectDir(projectId).resolve("work-16k.wav");
    }
}
