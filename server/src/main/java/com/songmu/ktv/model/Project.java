package com.songmu.ktv.model;

import java.util.ArrayList;
import java.util.List;

/**
 * 项目元数据（持久化到 <data>/projects/<id>/project.json，不使用数据库）。
 */
public class Project {

    private String id;
    private String name;
    private long createdAt;
    private long updatedAt;

    /** 歌曲音频 */
    private MediaInfo audio;

    /** 上一次音频裁剪前的音频信息（只保留一步，供「撤销裁剪」恢复；文件始终留在 media 目录） */
    private MediaInfo audioPrev;

    /** 背景素材：视频或图片，可多个 */
    private List<MediaInfo> backgrounds = new ArrayList<MediaInfo>();

    /** 字幕状态：EMPTY / RUNNING / READY / FAILED */
    private String subtitleStatus = "EMPTY";
    private String subtitleMessage;
    private int cueCount;

    /** 导出状态：NONE / RUNNING / DONE / FAILED */
    private String exportStatus = "NONE";
    private String exportPath;
    private String exportMessage;

    /** 模板与样式参数（MVP 仅一种 KTV 模板） */
    private String templateId = "ktv";
    private TemplateOptions template = new TemplateOptions();

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public long getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(long createdAt) {
        this.createdAt = createdAt;
    }

    public long getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(long updatedAt) {
        this.updatedAt = updatedAt;
    }

    public MediaInfo getAudio() {
        return audio;
    }

    public void setAudio(MediaInfo audio) {
        this.audio = audio;
    }

    public MediaInfo getAudioPrev() {
        return audioPrev;
    }

    public void setAudioPrev(MediaInfo audioPrev) {
        this.audioPrev = audioPrev;
    }

    public List<MediaInfo> getBackgrounds() {
        return backgrounds;
    }

    public void setBackgrounds(List<MediaInfo> backgrounds) {
        this.backgrounds = backgrounds;
    }

    public String getSubtitleStatus() {
        return subtitleStatus;
    }

    public void setSubtitleStatus(String subtitleStatus) {
        this.subtitleStatus = subtitleStatus;
    }

    public String getSubtitleMessage() {
        return subtitleMessage;
    }

    public void setSubtitleMessage(String subtitleMessage) {
        this.subtitleMessage = subtitleMessage;
    }

    public int getCueCount() {
        return cueCount;
    }

    public void setCueCount(int cueCount) {
        this.cueCount = cueCount;
    }

    public String getExportStatus() {
        return exportStatus;
    }

    public void setExportStatus(String exportStatus) {
        this.exportStatus = exportStatus;
    }

    public String getExportPath() {
        return exportPath;
    }

    public void setExportPath(String exportPath) {
        this.exportPath = exportPath;
    }

    public String getExportMessage() {
        return exportMessage;
    }

    public void setExportMessage(String exportMessage) {
        this.exportMessage = exportMessage;
    }

    public String getTemplateId() {
        return templateId;
    }

    public void setTemplateId(String templateId) {
        this.templateId = templateId;
    }

    public TemplateOptions getTemplate() {
        return template;
    }

    public void setTemplate(TemplateOptions template) {
        this.template = template;
    }
}
