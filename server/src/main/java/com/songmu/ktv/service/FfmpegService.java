package com.songmu.ktv.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.songmu.ktv.model.MediaInfo;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * ffmpeg / ffprobe 封装：
 * - 媒体探测（时长、宽高）
 * - 音频转 16kHz 单声道 WAV（whisper 输入）
 * - 帧序列 + 音轨 合成 MP4（导出）
 * - 背景素材预处理（视频统一规格 / 图片 Ken Burns 的素材制作）
 */
@Service
public class FfmpegService {

    private static final Logger log = LoggerFactory.getLogger(FfmpegService.class);

    private final ToolLocator tools;
    private final ObjectMapper mapper = new ObjectMapper();

    public FfmpegService(ToolLocator tools) {
        this.tools = tools;
    }

    public interface ProgressSink {
        void onProgress(double ratio, String rawLine);
    }

    private void requireFfmpeg() {
        if (!tools.ffmpegReady()) {
            throw new IllegalStateException("ffmpeg 未就绪：请把 ffmpeg（Windows 为 ffmpeg.exe）放入 bin 目录");
        }
    }

    /* ---------------- 探测 ---------------- */

    public MediaInfo probe(Path file, String kindHint) throws IOException, InterruptedException {
        requireFfmpeg();
        List<String> cmd = Arrays.asList(
                tools.ffprobe().toString(),
                "-v", "error",
                "-print_format", "json",
                "-show_format", "-show_streams",
                file.toString());
        String json = runCapture(cmd, 60);
        JsonNode root = mapper.readTree(json);

        MediaInfo info = new MediaInfo();
        info.setSize(Files.size(file));
        info.setKind(kindHint);

        JsonNode format = root.path("format");
        if (format.has("duration")) {
            info.setDuration(format.path("duration").asDouble(0));
        }

        JsonNode streams = root.path("streams");
        if (streams.isArray()) {
            for (JsonNode stream : streams) {
                String type = stream.path("codec_type").asText("");
                String codec = stream.path("codec_name").asText("");
                if ("video".equals(type)) {
                    if (info.getWidth() == 0) {
                        info.setWidth(stream.path("width").asInt(0));
                        info.setHeight(stream.path("height").asInt(0));
                    }
                    if (kindHint == null) {
                        // 视频轨优先于音频轨，避免被后面的音频流覆盖成 audio
                        info.setKind(isImageCodec(codec) ? "image" : "video");
                    }
                } else if ("audio".equals(type)) {
                    if (kindHint == null && info.getKind() == null) {
                        info.setKind("audio");
                    }
                }
            }
        }
        if (info.getKind() == null) {
            info.setKind("video");
        }
        return info;
    }

    /** 常见静态图片编码（用于区分图片素材与视频素材） */
    private static boolean isImageCodec(String codec) {
        if (codec == null) {
            return false;
        }
        String c = codec.toLowerCase();
        return c.contains("png") || c.contains("jpeg") || c.contains("mjpeg") || c.contains("webp")
                || c.contains("gif") || c.contains("bmp") || c.contains("tiff") || c.contains("avif");
    }

    /* ---------------- 音频 ---------------- */

    /** 转 16kHz 单声道 PCM16 WAV，whisper.cpp 的标准输入。 */
    public void toWav16kMono(Path input, Path output) throws IOException, InterruptedException {
        requireFfmpeg();
        Files.createDirectories(output.getParent());
        List<String> cmd = Arrays.asList(
                tools.ffmpeg().toString(), "-y",
                "-i", input.toString(),
                "-vn", "-ac", "1", "-ar", "16000",
                "-c:a", "pcm_s16le",
                output.toString());
        run(cmd, 1800, null);
    }

    /* ---------------- 导出合成 ---------------- */

    /**
     * 帧序列（%06d.png）+ 音轨 → H.264 MP4。
     * 使用 -progress pipe:1 解析进度。
     */
    public void encodeFrames(Path framesDir, double fps, Path audio, Path output,
                             int crf, String preset, double totalSeconds, ProgressSink sink)
            throws IOException, InterruptedException {
        requireFfmpeg();
        Files.createDirectories(output.getParent());
        Path pattern = framesDir.resolve("%06d.jpg");

        List<String> cmd = new ArrayList<String>(Arrays.asList(
                tools.ffmpeg().toString(), "-y",
                "-framerate", trim(fps),
                "-i", pattern.toString()));
        if (audio != null && Files.exists(audio)) {
            cmd.add("-i");
            cmd.add(audio.toString());
        }
        cmd.addAll(Arrays.asList(
                "-c:v", "libx264",
                "-pix_fmt", "yuv420p",
                "-crf", String.valueOf(crf),
                "-preset", preset,
                "-movflags", "+faststart",
                "-progress", "pipe:1",
                "-nostats"));
        if (audio != null && Files.exists(audio)) {
            cmd.addAll(Arrays.asList("-c:a", "aac", "-b:a", "192k", "-shortest"));
        }
        cmd.add(output.toString());

        runWithProgress(cmd, 7200, totalSeconds, sink);
    }

    /** 视频素材 → 统一分辨率/帧率的背景片段（循环或裁剪到歌曲时长）。 */
    public void prepareVideoBackground(Path input, Path output, int width, int height, double seconds)
            throws IOException, InterruptedException {
        requireFfmpeg();
        List<String> cmd = Arrays.asList(
                tools.ffmpeg().toString(), "-y",
                "-stream_loop", "-1",
                "-i", input.toString(),
                "-t", trim(seconds),
                "-vf", "scale=" + width + ":" + height + ":force_original_aspect_ratio=increase,"
                        + "crop=" + width + ":" + height + ",fps=30",
                "-an",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "veryfast",
                output.toString());
        run(cmd, 3600, null);
    }

    /**
     * 视频素材 → 目标规格的 JPEG 帧序列（000001.jpg ...），长度 seconds，循环填充。
     * 供前端逐帧合成使用（避免浏览器内 seek 视频）。
     */
    public void extractBackgroundFrames(Path input, Path outDir, int width, int height, int fps, double seconds)
            throws IOException, InterruptedException {
        requireFfmpeg();
        Files.createDirectories(outDir);
        List<String> cmd = Arrays.asList(
                tools.ffmpeg().toString(), "-y",
                "-stream_loop", "-1",
                "-i", input.toString(),
                "-t", trim(seconds),
                "-vf", "scale=" + width + ":" + height + ":force_original_aspect_ratio=increase,"
                        + "crop=" + width + ":" + height + ",fps=" + fps,
                "-q:v", "3",
                "-an",
                outDir.resolve("%06d.jpg").toString());
        run(cmd, 7200, null);
    }

    /* ---------------- 音频裁剪 ---------------- */

    /**
     * 删除音频区间 [start, end)：保留头段 [0, start) 与尾段 [end, 结尾] 并拼接为一个新文件。
     * 默认走流复制（-c copy）：只按帧边界拷贝、不解码不重编码，整首歌秒级完成，
     * 切割点对齐音频帧边界（mp3 ≈ 26ms / aac ≈ 21ms 误差，小于视频一帧 33ms）；
     * 若某些容器不支持流复制拼接，自动回退 atrim 精确模式（重编码，慢但采样级精确）。
     */
    public void cutAudio(Path input, Path output, double start, double end)
            throws IOException, InterruptedException {
        requireFfmpeg();
        Files.createDirectories(output.getParent());
        long begin = System.currentTimeMillis();
        try {
            copyCutAudio(input, output, start, end);
            log.info("音频裁剪完成（流复制）：删除 [{} , {}]s，耗时 {} ms",
                    trim(start), trim(end), System.currentTimeMillis() - begin);
        } catch (Exception err) {
            log.warn("流复制裁剪失败，回退精确模式（重编码）：{}", err.getMessage());
            preciseCutAudio(input, output, start, end);
        }
    }

    /** 流复制裁剪：头段 / 尾段分别 -c copy，再用 concat demuxer 拼接（不解码，秒级） */
    private void copyCutAudio(Path input, Path output, double start, double end)
            throws IOException, InterruptedException {
        Path dir = output.getParent();
        String outName = output.getFileName().toString();
        String suffix = "";
        int dot = outName.lastIndexOf('.');
        if (dot > 0) {
            suffix = outName.substring(dot);       // 保留扩展名：流复制需要按容器封装
        }
        Path head = dir.resolve(outName + ".part-head" + suffix);
        Path tail = dir.resolve(outName + ".part-tail" + suffix);
        Path list = dir.resolve(outName + ".part-concat.txt");
        try {
            // 头段 [0, start)：-t 放在 -i 前 = 按帧限制读取时长
            boolean hasHead = start > 0.01;
            if (hasHead) {
                run(Arrays.asList(
                        tools.ffmpeg().toString(), "-y",
                        "-t", trim(start),
                        "-i", input.toString(),
                        "-map", "0:a:0", "-vn", "-c", "copy",
                        head.toString()), 600, null);
                hasHead = probeDurationQuiet(head) > 0.05;
            }
            // 尾段 [end, 结尾]：-ss 放在 -i 前 = 按帧快速定位
            run(Arrays.asList(
                    tools.ffmpeg().toString(), "-y",
                    "-ss", trim(Math.max(0, end)),
                    "-i", input.toString(),
                    "-map", "0:a:0", "-vn", "-c", "copy",
                    tail.toString()), 600, null);
            boolean hasTail = probeDurationQuiet(tail) > 0.05;

            if (hasHead && hasTail) {
                Files.write(list, Arrays.asList(
                        "file '" + concatPath(head) + "'",
                        "file '" + concatPath(tail) + "'"), StandardCharsets.UTF_8);
                run(Arrays.asList(
                        tools.ffmpeg().toString(), "-y",
                        "-f", "concat", "-safe", "0",
                        "-i", list.toString(),
                        "-c", "copy",
                        output.toString()), 600, null);
            } else if (hasTail) {
                Files.copy(tail, output, StandardCopyOption.REPLACE_EXISTING);
            } else if (hasHead) {
                Files.copy(head, output, StandardCopyOption.REPLACE_EXISTING);
            } else {
                throw new IOException("裁剪后音频为空（start=" + trim(start) + " end=" + trim(end) + "）");
            }
        } finally {
            Files.deleteIfExists(head);
            Files.deleteIfExists(tail);
            Files.deleteIfExists(list);
        }
    }

    /** 精确裁剪（原 atrim 实现）：采样级切割，需要解码 + 重编码整首歌 */
    private void preciseCutAudio(Path input, Path output, double start, double end)
            throws IOException, InterruptedException {
        String filter;
        if (start <= 0.01) {
            // 只删开头：直接取尾段
            filter = "[0:a]atrim=start=" + trim(Math.max(0, end)) + ",asetpts=PTS-STARTPTS[out]";
        } else {
            filter = "[0:a]atrim=start=0:end=" + trim(start) + ",asetpts=PTS-STARTPTS[head];"
                    + "[0:a]atrim=start=" + trim(Math.max(0, end)) + ",asetpts=PTS-STARTPTS[tail];"
                    + "[head][tail]concat=n=2:v=0:a=1[out]";
        }
        List<String> cmd = new ArrayList<String>(Arrays.asList(
                tools.ffmpeg().toString(), "-y",
                "-i", input.toString(),
                "-filter_complex", filter,
                "-map", "[out]"));
        cmd.addAll(audioEncoderArgs(output));
        cmd.add(output.toString());
        run(cmd, 3600, null);
    }

    /** 探测时长（文件缺失 / 解析失败返回 0）：用于判断头段 / 尾段是否真有内容 */
    private double probeDurationQuiet(Path file) {
        try {
            if (!Files.exists(file) || Files.size(file) < 128) {
                return 0;
            }
            return probe(file, "audio").getDuration();
        } catch (Exception err) {
            return 0;
        }
    }

    /** concat 列表里的路径写法：绝对路径 + 正斜杠（Windows 下配合 -safe 0） */
    private static String concatPath(Path file) {
        return file.toAbsolutePath().toString().replace('\\', '/').replace("'", "'\\''");
    }

    /** 裁剪输出编码：按扩展名匹配容器，避免输出与格式不兼容。 */
    private static List<String> audioEncoderArgs(Path output) {
        String name = output.getFileName().toString().toLowerCase();
        if (name.endsWith(".mp3")) {
            return Arrays.asList("-c:a", "libmp3lame", "-q:a", "2");
        }
        if (name.endsWith(".m4a") || name.endsWith(".mp4") || name.endsWith(".aac")) {
            return Arrays.asList("-c:a", "aac", "-b:a", "256k");
        }
        if (name.endsWith(".flac")) {
            return Arrays.asList("-c:a", "flac", "-compression_level", "8");
        }
        if (name.endsWith(".ogg") || name.endsWith(".opus")) {
            return Arrays.asList("-c:a", "libopus", "-b:a", "192k");
        }
        if (name.endsWith(".wma")) {
            return Arrays.asList("-c:a", "wmav2", "-b:a", "192k");
        }
        return Arrays.asList("-c:a", "pcm_s16le");
    }

    /** 抽取视频某一时刻的缩略图（JPEG），供素材轨胶片条使用。 */
    public void extractThumbnail(Path input, double timeSeconds, int width, Path output)
            throws IOException, InterruptedException {
        requireFfmpeg();
        Files.createDirectories(output.getParent());
        List<String> cmd = Arrays.asList(
                tools.ffmpeg().toString(), "-y",
                "-ss", trim(timeSeconds),
                "-i", input.toString(),
                "-frames:v", "1",
                "-vf", "scale=" + width + ":-2",
                "-q:v", "5",
                output.toString());
        run(cmd, 300, null);
    }

    /* ---------------- 进程执行 ---------------- */

    private String runCapture(List<String> cmd, long timeoutSeconds) throws IOException, InterruptedException {
        Process process = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append('\n');
            }
        }
        if (!process.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            throw new IOException("命令超时: " + cmd.get(0));
        }
        if (process.exitValue() != 0) {
            throw new IOException("命令失败(" + process.exitValue() + "): " + cmd.get(0) + "\n" + tail(sb.toString()));
        }
        return sb.toString();
    }

    private void run(List<String> cmd, long timeoutSeconds, ProgressSink sink) throws IOException, InterruptedException {
        Process process = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (sink != null) {
                    sink.onProgress(-1, line);
                }
                log.debug("[ffmpeg] {}", line);
            }
        }
        if (!process.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            throw new IOException("命令超时: " + cmd.get(0));
        }
        if (process.exitValue() != 0) {
            throw new IOException("命令失败(" + process.exitValue() + "): " + cmd.get(0));
        }
    }

    /** 带进度：解析 -progress 输出的 out_time_us / out_time_ms。 */
    private void runWithProgress(List<String> cmd, long timeoutSeconds, double totalSeconds, ProgressSink sink)
            throws IOException, InterruptedException {
        Process process = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        InputStream stream = process.getInputStream();
        BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8));
        String lastError = "";
        try {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.startsWith("out_time_us=") || line.startsWith("out_time_ms=")) {
                    String value = line.substring(line.indexOf('=') + 1).trim();
                    try {
                        double micros = Double.parseDouble(value);
                        // ffmpeg 的 out_time_ms 实际单位是微秒
                        double seconds = micros / 1_000_000.0;
                        if (totalSeconds > 0 && sink != null) {
                            sink.onProgress(Math.min(1.0, seconds / totalSeconds), line);
                        }
                    } catch (NumberFormatException ignored) {
                        // 跳过
                    }
                } else if (line.startsWith("error") || line.contains("Error") || line.contains("Invalid")) {
                    lastError = line;
                }
                log.debug("[ffmpeg] {}", line);
            }
        } finally {
            reader.close();
        }
        if (!process.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            throw new IOException("ffmpeg 超时");
        }
        if (process.exitValue() != 0) {
            throw new IOException("ffmpeg 失败(" + process.exitValue() + "): " + lastError);
        }
        if (sink != null) {
            sink.onProgress(1.0, "done");
        }
    }

    private static String trim(double value) {
        if (value == Math.floor(value)) {
            return String.valueOf((long) value);
        }
        return String.valueOf(value);
    }

    private static String tail(String text) {
        if (text.length() <= 800) {
            return text;
        }
        return text.substring(text.length() - 800);
    }
}
