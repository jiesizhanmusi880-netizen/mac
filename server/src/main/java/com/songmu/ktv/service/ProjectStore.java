package com.songmu.ktv.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.songmu.ktv.config.AppPaths;
import com.songmu.ktv.model.Project;
import com.songmu.ktv.model.SubtitleCue;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 项目存储：每个项目一个目录，元数据写 project.json，字幕写 subtitles.json。
 * 不依赖数据库，方便迁移与备份。
 */
@Service
public class ProjectStore {

    private static final Logger log = LoggerFactory.getLogger(ProjectStore.class);

    private final AppPaths paths;
    private final ObjectMapper mapper;
    private final Map<String, Project> cache = new ConcurrentHashMap<String, Project>();

    public ProjectStore(AppPaths paths, ObjectMapper mapper) {
        this.paths = paths;
        this.mapper = mapper;
    }

    public synchronized Project create(String name) throws IOException {
        String id = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        Project project = new Project();
        project.setId(id);
        project.setName(name == null || name.trim().isEmpty() ? "未命名项目" : name.trim());
        long now = System.currentTimeMillis();
        project.setCreatedAt(now);
        project.setUpdatedAt(now);

        Files.createDirectories(paths.mediaDir(id));
        Files.createDirectories(paths.framesDir(id));
        Files.createDirectories(paths.exportDir(id));
        save(project);
        log.info("创建项目 {} ({})", project.getName(), id);
        return project;
    }

    public List<Project> list() {
        List<Project> result = new ArrayList<Project>();
        File dir = paths.projectsDir().toFile();
        File[] children = dir.listFiles();
        if (children == null) {
            return result;
        }
        for (File child : children) {
            if (!child.isDirectory()) {
                continue;
            }
            Project project = read(child.getName());
            if (project != null) {
                result.add(project);
            }
        }
        result.sort(new Comparator<Project>() {
            @Override
            public int compare(Project a, Project b) {
                return Long.compare(b.getUpdatedAt(), a.getUpdatedAt());
            }
        });
        return result;
    }

    public Project get(String id) {
        Project cached = cache.get(id);
        if (cached != null) {
            return cached;
        }
        return read(id);
    }

    public Project read(String id) {
        Path file = paths.projectJson(id);
        if (!Files.exists(file)) {
            return null;
        }
        try {
            Project project = mapper.readValue(file.toFile(), Project.class);
            cache.put(id, project);
            return project;
        } catch (IOException ex) {
            log.warn("读取项目失败 {}: {}", id, ex.getMessage());
            return null;
        }
    }

    public synchronized void save(Project project) throws IOException {
        project.setUpdatedAt(System.currentTimeMillis());
        Files.createDirectories(paths.projectDir(project.getId()));
        mapper.writerWithDefaultPrettyPrinter().writeValue(paths.projectJson(project.getId()).toFile(), project);
        cache.put(project.getId(), project);
    }

    public synchronized void delete(String id) throws IOException {
        cache.remove(id);
        Path dir = paths.projectDir(id);
        if (!Files.exists(dir)) {
            return;
        }
        Files.walk(dir)
                .sorted(Comparator.reverseOrder())
                .forEach(p -> {
                    try {
                        Files.deleteIfExists(p);
                    } catch (IOException ignored) {
                        // 尽力删除
                    }
                });
        log.info("删除项目 {}", id);
    }

    public List<SubtitleCue> loadSubtitles(String id) throws IOException {
        Path file = paths.subtitleJson(id);
        if (!Files.exists(file)) {
            return new ArrayList<SubtitleCue>();
        }
        return mapper.readValue(file.toFile(), new TypeReference<List<SubtitleCue>>() {
        });
    }

    public void saveSubtitles(String id, List<SubtitleCue> cues) throws IOException {
        Files.createDirectories(paths.projectDir(id));
        mapper.writerWithDefaultPrettyPrinter().writeValue(paths.subtitleJson(id).toFile(), cues);
    }

    /** 音频裁剪前备份当前歌词（只保留一步，供「撤销裁剪」还原）。 */
    public void saveSubtitlesBackup(String id, List<SubtitleCue> cues) throws IOException {
        Files.createDirectories(paths.projectDir(id));
        mapper.writerWithDefaultPrettyPrinter().writeValue(paths.subtitleBackupJson(id).toFile(), cues);
    }

    /** 读取歌词备份；没有备份时返回 null。 */
    public List<SubtitleCue> loadSubtitlesBackup(String id) throws IOException {
        Path file = paths.subtitleBackupJson(id);
        if (!Files.exists(file)) {
            return null;
        }
        return mapper.readValue(file.toFile(), new TypeReference<List<SubtitleCue>>() {
        });
    }
}
