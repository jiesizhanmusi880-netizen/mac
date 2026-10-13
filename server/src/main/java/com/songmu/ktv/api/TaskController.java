package com.songmu.ktv.api;

import com.songmu.ktv.model.TaskInfo;
import com.songmu.ktv.service.TaskManager;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/tasks")
public class TaskController {

    private final TaskManager tasks;

    public TaskController(TaskManager tasks) {
        this.tasks = tasks;
    }

    @GetMapping("/{taskId}")
    public TaskInfo get(@PathVariable String taskId) {
        TaskInfo task = tasks.get(taskId);
        if (task == null) {
            throw new IllegalArgumentException("任务不存在: " + taskId);
        }
        return task;
    }
}
