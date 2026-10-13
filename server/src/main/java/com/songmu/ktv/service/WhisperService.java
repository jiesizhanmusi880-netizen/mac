package com.songmu.ktv.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.songmu.ktv.model.SubtitleCue;
import com.songmu.ktv.model.TaskInfo;
import com.songmu.ktv.model.WordTiming;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 识别服务：双后端
 * - whisper.cpp：更快，参数 --max-context 0 + -dtw（词级时间戳）
 * - Python whisper：复用系统已装的 whisper.exe，输出 segments/words
 *
 * 输出统一为 List&lt;SubtitleCue&gt;（行级时间 + 逐字时间），并做抗幻觉后处理：
 * 模板文本黑名单、纯口水词过滤、非中文行过滤、时间轴单调化。
 */
@Service
public class WhisperService {

    private static final Logger log = LoggerFactory.getLogger(WhisperService.class);

    private static final Set<String> HALLUCINATION_LINES = new HashSet<String>(Arrays.asList(
            "字幕志愿者", "字幕组", "谢谢观看", "谢谢大家", "感谢观看", "感谢收看",
            "请不吝点赞", "请点赞", "订阅", "转发", "打赏", "明镜与点点栏目",
            "訂閱", "贊助", "字幕由", "翻译", "校对", "未经作者授权", "MING PAO"
    ));

    private static final Pattern HAN = Pattern.compile("[\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff]");
    private static final Pattern FILLER_ONLY = Pattern.compile(
            "^(?:[a-zA-Z\\s',.!?]|哦|噢|啊|嗯|哈|嘿|呀|啦|哇|欸|呃|yeah|oh|ah|uh|mm|hmm)+$");

    private final ToolLocator tools;
    private final ObjectMapper mapper = new ObjectMapper();
    private final int threads;
    private final String language;
    private final boolean dtw;

    public WhisperService(ToolLocator tools,
                          @Value("${ktv.whisper.threads:8}") int threads,
                          @Value("${ktv.whisper.language:zh}") String language,
                          @Value("${ktv.whisper.dtw:true}") boolean dtw) {
        this.tools = tools;
        this.threads = threads;
        this.language = language;
        this.dtw = dtw;
    }

    /**
     * 识别 16kHz 单声道 WAV。
     *
     * @param wav     输入音频
     * @param outBase 输出前缀（whisper.cpp 用）；Python 后端用其父目录作为输出目录
     * @param task    进度上报（可为 null）
     */
    public List<SubtitleCue> recognize(Path wav, Path outBase, TaskInfo task) throws IOException, InterruptedException {
        String backend = tools.whisperBackend();
        if (backend == null) {
            throw new IllegalStateException("未找到可用的识别后端：请安装 whisper（Python 包）"
                    + "或把 whisper-cli（Windows 为 whisper-cli.exe）与模型放入 bin 目录");
        }
        log.info("使用识别后端: {}", backend);

        List<SubtitleCue> cues;
        if ("whisper.cpp".equals(backend)) {
            runWhisperCpp(wav, outBase, task);
            cues = parseWhisperCpp(Paths.get(outBase.toString() + ".json"));
        } else {
            Path json = runPythonWhisper(wav, outBase, task);
            cues = parsePythonWhisper(json);
        }
        return postProcess(cues);
    }

    /* ---------------- whisper.cpp ---------------- */

    private void runWhisperCpp(Path wav, Path outBase, TaskInfo task) throws IOException, InterruptedException {
        List<String> cmd = new ArrayList<String>(Arrays.asList(
                tools.whisperCpp().toString(),
                "-m", tools.model().toString(),
                "-f", wav.toString(),
                "-l", language,
                "-t", String.valueOf(threads),
                "--output-json",
                "--output-file", outBase.toString(),
                "--max-context", "0"));
        if (dtw) {
            cmd.add("-dtw");
            cmd.add(tools.pythonModelName());
        }
        run(cmd, task, "progress = ", 6);
    }

    private List<SubtitleCue> parseWhisperCpp(Path json) throws IOException {
        JsonNode root = mapper.readTree(json.toFile());
        JsonNode transcription = root.path("transcription");
        List<SubtitleCue> cues = new ArrayList<SubtitleCue>();
        if (!transcription.isArray()) {
            return cues;
        }
        for (JsonNode node : transcription) {
            String text = node.path("text").asText("").trim();
            if (text.isEmpty()) {
                continue;
            }
            SubtitleCue cue = new SubtitleCue();
            cue.setStart(node.path("offsets").path("from").asDouble(0) / 1000.0);
            cue.setEnd(node.path("offsets").path("to").asDouble(0) / 1000.0);
            cue.setText(text);
            cue.setWords(wordsFromTokens(node.path("tokens")));
            cues.add(cue);
        }
        return cues;
    }

    /** whisper.cpp tokens → 逐字时间（多字符 token 按字符均分时间片）。 */
    private List<WordTiming> wordsFromTokens(JsonNode tokens) {
        List<WordTiming> words = new ArrayList<WordTiming>();
        if (tokens == null || !tokens.isArray()) {
            return words;
        }
        for (JsonNode token : tokens) {
            String raw = token.path("text").asText("");
            if (raw.isEmpty()) {
                continue;
            }
            double from = token.path("offsets").path("from").asDouble(-1) / 1000.0;
            double to = token.path("offsets").path("to").asDouble(-1) / 1000.0;
            if (from < 0 || to <= from) {
                continue;
            }
            String cleaned = normalizeToken(raw);
            if (cleaned.isEmpty()) {
                continue;
            }
            splitByChars(cleaned, from, to, words);
        }
        return words;
    }

    /* ---------------- Python whisper ---------------- */

    private Path runPythonWhisper(Path wav, Path outBase, TaskInfo task) throws IOException, InterruptedException {
        Path outDir = outBase.getParent();
        Files.createDirectories(outDir);
        String baseName = wav.getFileName().toString();
        int dot = baseName.lastIndexOf('.');
        final String stem = dot > 0 ? baseName.substring(0, dot) : baseName;

        List<String> cmd = new ArrayList<String>(Arrays.asList(
                tools.pythonWhisper().toString(),
                wav.toString(),
                "--model", tools.pythonModelName(),
                "--language", language,
                "--task", "transcribe",
                "--output_format", "json",
                "--output_dir", outDir.toString(),
                "--word_timestamps", "True",
                "--condition_on_previous_text", "False",
                "--fp16", "False",
                "--verbose", "False"));
        run(cmd, task, "%|", 6);

        Path json = outDir.resolve(stem + ".json");
        if (!Files.exists(json)) {
            throw new IOException("Python whisper 未生成 JSON: " + json);
        }
        // 复制成统一命名，便于排查
        Path copy = Paths.get(outBase.toString() + ".json");
        Files.copy(json, copy, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        return json;
    }

    private List<SubtitleCue> parsePythonWhisper(Path json) throws IOException {
        JsonNode root = mapper.readTree(json.toFile());
        JsonNode segments = root.path("segments");
        List<SubtitleCue> cues = new ArrayList<SubtitleCue>();
        if (!segments.isArray()) {
            return cues;
        }
        int index = 0;
        for (JsonNode segment : segments) {
            index++;
            String text = segment.path("text").asText("").trim();
            if (text.isEmpty()) {
                continue;
            }
            SubtitleCue cue = new SubtitleCue();
            cue.setStart(segment.path("start").asDouble(0));
            cue.setEnd(segment.path("end").asDouble(0));
            cue.setText(text);

            List<WordTiming> words = new ArrayList<WordTiming>();
            JsonNode wordNodes = segment.path("words");
            if (wordNodes.isArray()) {
                for (JsonNode word : wordNodes) {
                    String wt = word.path("word").asText("");
                    double ws = word.path("start").asDouble(-1);
                    double we = word.path("end").asDouble(-1);
                    if (wt.isEmpty() || ws < 0 || we <= ws) {
                        continue;
                    }
                    String cleaned = wt.trim();
                    if (cleaned.isEmpty()) {
                        continue;
                    }
                    splitByChars(cleaned, ws, we, words);
                }
            }
            cue.setWords(words);
            cues.add(cue);
        }
        log.info("解析 Python whisper 输出：{} 段", index);
        return cues;
    }

    /* ---------------- 公共 ---------------- */

    /** 把一段文本按字符均分到 [from, to] 时间片，生成逐字时间。 */
    private void splitByChars(String text, double from, double to, List<WordTiming> out) {
        char[] chars = text.toCharArray();
        double span = (to - from) / chars.length;
        for (int i = 0; i < chars.length; i++) {
            double cs = from + span * i;
            double ce = (i == chars.length - 1) ? to : from + span * (i + 1);
            out.add(new WordTiming(round3(cs), round3(ce), String.valueOf(chars[i])));
        }
    }

    private String normalizeToken(String raw) {
        String value = raw;
        if (value.startsWith("[_") && value.endsWith("_]")) {
            return "";
        }
        if (value.startsWith("<|") || value.endsWith("|>")) {
            return "";
        }
        if (value.startsWith("_") || value.startsWith(" ")) {
            value = value.substring(1);
        }
        return value;
    }

    private List<SubtitleCue> postProcess(List<SubtitleCue> cues) {
        List<SubtitleCue> kept = new ArrayList<SubtitleCue>();
        double lastEnd = 0;
        for (SubtitleCue cue : cues) {
            String text = cue.getText() == null ? "" : cue.getText().trim();
            if (text.isEmpty() || isHallucination(text) || isFillerOnly(text)) {
                continue;
            }
            if ("zh".equalsIgnoreCase(language) && !HAN.matcher(text).find()) {
                continue;
            }
            double start = cue.getStart();
            double end = cue.getEnd();
            if (end - start < 0.12) {
                continue;
            }
            if (start < lastEnd - 0.01) {
                start = lastEnd;
            }
            if (end <= start) {
                continue;
            }
            cue.setStart(round3(start));
            cue.setEnd(round3(end));
            cue.setText(text);
            cue.setWords(clampWords(cue.getWords(), start, end));
            kept.add(cue);
            lastEnd = end;
        }
        log.info("后处理完成：{} 行 → {} 行", cues.size(), kept.size());
        return kept;
    }

    private List<WordTiming> clampWords(List<WordTiming> words, double start, double end) {
        List<WordTiming> result = new ArrayList<WordTiming>();
        if (words == null) {
            return result;
        }
        double cursor = start;
        for (WordTiming word : words) {
            if (word.getText() == null || word.getText().isEmpty()) {
                continue;
            }
            double ws = Math.max(start, Math.max(cursor, word.getStart()));
            double we = Math.min(end, Math.max(ws + 0.02, word.getEnd()));
            if (ws >= end) {
                break;
            }
            result.add(new WordTiming(round3(ws), round3(we), word.getText()));
            cursor = we;
        }
        return result;
    }

    private boolean isHallucination(String text) {
        for (String bad : HALLUCINATION_LINES) {
            if (text.contains(bad)) {
                return true;
            }
        }
        return false;
    }

    private boolean isFillerOnly(String text) {
        String compact = text.replaceAll("\\s+", "");
        if (compact.isEmpty()) {
            return true;
        }
        return FILLER_ONLY.matcher(text).matches() && compact.length() <= 12;
    }

    /* ---------------- 进程执行与进度 ---------------- */

    /** 从输出行提取百分比（兼容 whisper.cpp 的 "progress = 12%" 与 tqdm 的 " 12%|███"）。 */
    private static final Pattern PERCENT = Pattern.compile("(\\d{1,3})\\s*%");

    private void run(List<String> cmd, TaskInfo task, String progressMarker, int baseMessageLen)
            throws IOException, InterruptedException {
        log.info("执行识别: {}", String.join(" ", cmd));
        ProcessBuilder builder = new ProcessBuilder(cmd);
        builder.redirectErrorStream(true);
        // Python whisper 在 Windows 默认按控制台代码页(GBK)输出，强制 UTF-8，避免中文乱码
        builder.environment().put("PYTHONIOENCODING", "utf-8");
        Process process = builder.start();

        StringBuilder output = new StringBuilder();
        try (InputStream in = new BufferedInputStream(process.getInputStream());
             ByteArrayOutputStream lineBuf = new ByteArrayOutputStream()) {
            int b;
            while ((b = in.read()) != -1) {
                // \r 与 \n 都视为行结束：tqdm 进度条用 \r 刷新，可及时上报并避免拼接出超长行
                if (b == '\n' || b == '\r') {
                    if (lineBuf.size() > 0) {
                        handleLine(decodeLine(lineBuf.toByteArray()), output, task, progressMarker);
                        lineBuf.reset();
                    }
                } else {
                    lineBuf.write(b);
                    if (lineBuf.size() >= 65536) {
                        handleLine(decodeLine(lineBuf.toByteArray()), output, task, progressMarker);
                        lineBuf.reset();
                    }
                }
            }
            if (lineBuf.size() > 0) {
                handleLine(decodeLine(lineBuf.toByteArray()), output, task, progressMarker);
            }
        }
        if (!process.waitFor(8, TimeUnit.HOURS)) {
            process.destroyForcibly();
            throw new IOException("识别超时");
        }
        if (process.exitValue() != 0) {
            throw new IOException("识别失败(" + process.exitValue() + "):\n" + tail(output.toString()));
        }
    }

    private void handleLine(String line, StringBuilder output, TaskInfo task, String progressMarker) {
        output.append(line).append('\n');
        if (output.length() > 200000) {
            output.delete(0, output.length() - 100000);
        }
        log.debug("[whisper] {}", line);
        if (task == null || progressMarker == null || progressMarker.isEmpty()) {
            return;
        }
        if (line.indexOf(progressMarker) < 0) {
            return;
        }
        Matcher matcher = PERCENT.matcher(line);
        if (matcher.find()) {
            int percent = Integer.parseInt(matcher.group(1));
            task.setProgress(Math.max(0, Math.min(99, percent)));
            task.setMessage("识别中 " + percent + "%");
            task.setUpdatedAt(System.currentTimeMillis());
        }
    }

    /** 子进程输出解码：优先严格 UTF-8，失败则按 GBK（Windows 控制台默认代码页）。 */
    private static String decodeLine(byte[] bytes) {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString();
        } catch (CharacterCodingException e) {
            try {
                return new String(bytes, Charset.forName("GBK"));
            } catch (RuntimeException fallback) {
                return new String(bytes, StandardCharsets.UTF_8);
            }
        }
    }

    private static double round3(double value) {
        return Math.round(value * 1000.0) / 1000.0;
    }

    private static String tail(String text) {
        if (text.length() <= 1200) {
            return text;
        }
        return text.substring(text.length() - 1200);
    }
}
