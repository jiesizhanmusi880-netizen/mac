package com.songmu.ktv.api;

import com.songmu.ktv.model.Project;
import com.songmu.ktv.model.SubtitleCue;
import com.songmu.ktv.model.TemplateOptions;
import com.songmu.ktv.service.ProjectStore;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/projects")
public class ProjectController {

    private final ProjectStore store;

    public ProjectController(ProjectStore store) {
        this.store = store;
    }

    @GetMapping
    public List<Project> list() {
        return store.list();
    }

    @PostMapping
    public Project create(@RequestBody(required = false) Map<String, String> body) throws IOException {
        String name = body == null ? null : body.get("name");
        return store.create(name);
    }

    @GetMapping("/{id}")
    public Project get(@PathVariable String id) {
        Project project = store.get(id);
        if (project == null) {
            throw new IllegalArgumentException("项目不存在: " + id);
        }
        return project;
    }

    @PutMapping("/{id}")
    public Project update(@PathVariable String id, @RequestBody Map<String, String> body) throws IOException {
        Project project = store.get(id);
        if (project == null) {
            throw new IllegalArgumentException("项目不存在: " + id);
        }
        if (body != null && body.get("name") != null && !body.get("name").trim().isEmpty()) {
            project.setName(body.get("name").trim());
        }
        store.save(project);
        return project;
    }

    @DeleteMapping("/{id}")
    public Map<String, Object> delete(@PathVariable String id) throws IOException {
        store.delete(id);
        return java.util.Collections.<String, Object>singletonMap("deleted", id);
    }

    @PutMapping("/{id}/template")
    public Project updateTemplate(@PathVariable String id, @RequestBody TemplateOptions options) throws IOException {
        Project project = store.get(id);
        if (project == null) {
            throw new IllegalArgumentException("项目不存在: " + id);
        }
        project.setTemplate(options);
        store.save(project);
        return project;
    }

    @GetMapping("/{id}/subtitles")
    public List<SubtitleCue> subtitles(@PathVariable String id) throws IOException {
        return store.loadSubtitles(id);
    }

    @PutMapping("/{id}/subtitles")
    public List<SubtitleCue> saveSubtitles(@PathVariable String id, @RequestBody List<SubtitleCue> cues) throws IOException {
        Project project = store.get(id);
        if (project == null) {
            throw new IllegalArgumentException("项目不存在: " + id);
        }
        store.saveSubtitles(id, cues);
        project.setCueCount(cues.size());
        if (!cues.isEmpty()) {
            project.setSubtitleStatus("READY");
        }
        store.save(project);
        return cues;
    }
}
