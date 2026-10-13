package com.songmu.ktv.service;

import com.songmu.ktv.config.AppPaths;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.annotation.PostConstruct;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 探测外部工具（Windows / macOS 通用：Windows 带 .exe 后缀，macOS 无扩展名）：
 * - ffmpeg / ffprobe（bin 目录优先，其次系统 PATH）
 * - whisper.cpp（whisper-cli + bin/models/ggml-*.bin）
 * - Python 版 whisper（whisper，OpenAI 官方包，作为无 whisper.cpp 时的后备）
 */
@Service
public class ToolLocator {

    private static final Logger log = LoggerFactory.getLogger(ToolLocator.class);

    private final AppPaths paths;
    private final String modelName;

    private Path ffmpeg;
    private Path ffprobe;
    private Path whisperCpp;
    private Path pythonWhisper;
    private Path cppModel;

    public ToolLocator(AppPaths paths,
                       @Value("${ktv.whisper.model:ggml-medium.bin}") String modelName) {
        this.paths = paths;
        this.modelName = modelName;
    }

    @PostConstruct
    public void detect() {
        ffmpeg = find("ffmpeg.exe", "ffmpeg");
        ffprobe = find("ffprobe.exe", "ffprobe");
        // 候选名同时覆盖 Windows（.exe）与 macOS / Linux（无扩展名）
        whisperCpp = find("whisper-cli.exe", "whisper-cli", "main.exe", "main", "whisper-cpp.exe", "whisper-cpp");
        pythonWhisper = find("whisper.exe", "whisper");
        cppModel = paths.modelsDir().resolve(modelName);
        log.info("工具探测: ffmpeg={} whisperCpp={} pythonWhisper={} cppModel={}",
                ffmpeg, whisperCpp, pythonWhisper, Files.isRegularFile(cppModel) ? cppModel : "(缺失)");
    }

    private Path find(String... names) {
        for (String name : names) {
            Path local = paths.binDir().resolve(name);
            if (Files.isRegularFile(local)) {
                return local;
            }
        }
        String pathEnv = System.getenv("PATH");
        if (pathEnv != null) {
            String[] dirs = pathEnv.split(File.pathSeparator);   // Windows ";" / macOS-Linux ":"
            for (String dir : dirs) {
                if (dir.trim().isEmpty()) {
                    continue;
                }
                for (String name : names) {
                    Path candidate = Paths.get(dir.trim()).resolve(name);
                    if (Files.isRegularFile(candidate)) {
                        return candidate;
                    }
                }
            }
        }
        return null;
    }

    public Path ffmpeg() {
        return ffmpeg;
    }

    public Path ffprobe() {
        return ffprobe;
    }

    public Path whisperCpp() {
        return whisperCpp;
    }

    public Path pythonWhisper() {
        return pythonWhisper;
    }

    /** whisper.cpp 使用的 ggml 模型文件路径 */
    public Path model() {
        return cppModel;
    }

    /** Python whisper 使用的模型名，如 medium / large-v3 */
    public String pythonModelName() {
        String name = modelName;
        if (name.endsWith(".bin")) {
            name = name.substring(0, name.length() - 4);
        }
        if (name.startsWith("ggml-")) {
            name = name.substring(5);
        }
        return name;
    }

    public boolean ffmpegReady() {
        return ffmpeg != null && ffprobe != null;
    }

    /** 识别后端：whisper.cpp 优先，回退 Python whisper */
    public String whisperBackend() {
        if (whisperCpp != null && Files.isRegularFile(cppModel)) {
            return "whisper.cpp";
        }
        if (pythonWhisper != null) {
            return "python-whisper";
        }
        return null;
    }

    public boolean whisperReady() {
        return whisperBackend() != null;
    }

    public Map<String, Object> status() {
        Map<String, Object> map = new LinkedHashMap<String, Object>();
        map.put("ffmpeg", ffmpeg == null ? null : ffmpeg.toString());
        map.put("ffprobe", ffprobe == null ? null : ffprobe.toString());
        map.put("whisperCpp", whisperCpp == null ? null : whisperCpp.toString());
        map.put("pythonWhisper", pythonWhisper == null ? null : pythonWhisper.toString());
        map.put("model", Files.isRegularFile(cppModel) ? cppModel.toString() : null);
        map.put("ffmpegReady", ffmpegReady());
        map.put("whisperBackend", whisperBackend());
        map.put("whisperReady", whisperReady());
        map.put("binDir", paths.binDir().toString());
        return map;
    }
}
