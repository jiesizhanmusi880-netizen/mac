package com.songmu.ktv.model;

import java.util.ArrayList;
import java.util.List;

/**
 * 一句字幕（行级时间 + 逐字时间轴，后者用于 KTV 逐字高亮）。
 */
public class SubtitleCue {

    private double start;
    private double end;
    private String text;
    private List<WordTiming> words = new ArrayList<WordTiming>();

    /** 扫色方式：follow（跟唱，按逐字时间） / even（整句均匀扫色） */
    private String sweepMode = "follow";

    public double getStart() {
        return start;
    }

    public void setStart(double start) {
        this.start = start;
    }

    public double getEnd() {
        return end;
    }

    public void setEnd(double end) {
        this.end = end;
    }

    public String getText() {
        return text;
    }

    public void setText(String text) {
        this.text = text;
    }

    public List<WordTiming> getWords() {
        return words;
    }

    public void setWords(List<WordTiming> words) {
        this.words = words;
    }

    public String getSweepMode() {
        return sweepMode;
    }

    public void setSweepMode(String sweepMode) {
        this.sweepMode = sweepMode;
    }
}
