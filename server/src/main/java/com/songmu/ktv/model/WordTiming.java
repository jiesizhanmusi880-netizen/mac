package com.songmu.ktv.model;

/**
 * 单个字/词的起止时间，KTV 逐字高亮的最小单位。
 */
public class WordTiming {

    private double start;
    private double end;
    private String text;

    public WordTiming() {
    }

    public WordTiming(double start, double end, String text) {
        this.start = start;
        this.end = end;
        this.text = text;
    }

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
}
