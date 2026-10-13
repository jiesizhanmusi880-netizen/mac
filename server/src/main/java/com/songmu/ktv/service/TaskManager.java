package com.songmu.ktv.service;

import com.songmu.ktv.model.TaskInfo;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import javax.annotation.PreDestroy;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 后台任务管理：识别与导出都是长任务，统一用线程池执行，前端轮询进度。
 */
@Service
public class TaskManager {

    private static final Logger log = LoggerFactory.getLogger(TaskManager.class);

    private final ExecutorService pool = Executors.newFixedThreadPool(2);
    private final Map<String, TaskInfo> tasks = new ConcurrentHashMap<String, TaskInfo>();

    public TaskInfo create(String projectId, String type) {
        TaskInfo task = new TaskInfo();
        task.setId(UUID.randomUUID().toString().replace("-", "").substring(0, 12));
        task.setProjectId(projectId);
        task.setType(type);
        task.setStatus(TaskInfo.PENDING);
        task.setProgress(0);
        long now = System.currentTimeMillis();
        task.setCreatedAt(now);
        task.setUpdatedAt(now);
        tasks.put(task.getId(), task);
        return task;
    }

    public TaskInfo get(String id) {
        return tasks.get(id);
    }

    public void submit(final TaskInfo task, final TaskBody body) {
        pool.submit(new Runnable() {
            @Override
            public void run() {
                task.setStatus(TaskInfo.RUNNING);
                task.setUpdatedAt(System.currentTimeMillis());
                try {
                    body.run(task);
                    if (!TaskInfo.FAILED.equals(task.getStatus()) && !TaskInfo.CANCELLED.equals(task.getStatus())) {
                        task.setStatus(TaskInfo.DONE);
                        task.setProgress(100);
                    }
                } catch (Exception ex) {
                    log.error("任务 {} 失败: {}", task.getId(), ex.getMessage(), ex);
                    task.setStatus(TaskInfo.FAILED);
                    task.setMessage(ex.getMessage() == null ? ex.toString() : ex.getMessage());
                } finally {
                    task.setUpdatedAt(System.currentTimeMillis());
                }
            }
        });
    }

    public void progress(TaskInfo task, int percent, String message) {
        task.setProgress(Math.max(0, Math.min(100, percent)));
        task.setMessage(message);
        task.setUpdatedAt(System.currentTimeMillis());
    }

    @PreDestroy
    public void shutdown() {
        pool.shutdownNow();
    }

    public interface TaskBody {
        void run(TaskInfo task) throws Exception;
    }
}
