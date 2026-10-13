package com.songmu.ktv.model;

/**
 * KTV 字幕模板参数。
 * 默认值参考歌暮 defaults.json（字号/渐变/描边/阴影），落点为 1080p 画布。
 */
public class TemplateOptions {

    /** 默认字体与歌暮一致：抖音美好体 */
    private String fontFamily = "抖音美好体";
    /** 背景预设图文件名（desktop/assets/backgrounds 下），空表示不使用 */
    private String backgroundPreset;

    /** 画面叠加信息：歌名 / 歌手 / DJ 名字（一键添加到画面） */
    private String nameText;
    private String singerText;
    private String djText;
    private boolean overlayInfoEnabled = true;

    private double fontSize = 95;
    private double letterSpacing = 10;

    /** 已唱颜色模式：gradient / solid */
    private String playedColorMode = "gradient";
    private String playedSolidColor = "#B721FF";
    private String gradientStart = "#A900B2";
    private String gradientMiddle = "#6651D0";
    private String gradientEnd = "#23A2EE";

    /** 未唱颜色 */
    private String unplayedColor = "#FFFFFF";

    private boolean strokeEnabled = true;
    private String strokeColor = "#000000";
    private double strokeOpacity = 1.0;
    private double strokeWidth = 5.0;

    private boolean shadowEnabled = true;
    private String shadowColor = "#000000";
    private double shadowOpacity = 0.7;
    private double shadowBlur = 8.0;
    private double shadowDistance = 6.0;
    private double shadowAngle = 90.0;

    private boolean fadeEnabled = true;
    private double fadeInDuration = 0.3;
    private double fadeOutDuration = 0.5;

    /** 每条字幕最大字数（超出自动分两行） */
    private int maxChars = 15;
    /** 双行时两行的垂直间距（1080p 像素） */
    private double lineGap = 110;
    /** 字幕整体距底部的距离（1080p 像素） */
    private double bottomMargin = 160;

    public String getFontFamily() {
        return fontFamily;
    }

    public void setFontFamily(String fontFamily) {
        this.fontFamily = fontFamily;
    }

    public String getBackgroundPreset() {
        return backgroundPreset;
    }

    public void setBackgroundPreset(String backgroundPreset) {
        this.backgroundPreset = backgroundPreset;
    }

    public String getNameText() {
        return nameText;
    }

    public void setNameText(String nameText) {
        this.nameText = nameText;
    }

    public String getSingerText() {
        return singerText;
    }

    public void setSingerText(String singerText) {
        this.singerText = singerText;
    }

    public String getDjText() {
        return djText;
    }

    public void setDjText(String djText) {
        this.djText = djText;
    }

    public boolean isOverlayInfoEnabled() {
        return overlayInfoEnabled;
    }

    public void setOverlayInfoEnabled(boolean overlayInfoEnabled) {
        this.overlayInfoEnabled = overlayInfoEnabled;
    }

    public double getFontSize() {
        return fontSize;
    }

    public void setFontSize(double fontSize) {
        this.fontSize = fontSize;
    }

    public double getLetterSpacing() {
        return letterSpacing;
    }

    public void setLetterSpacing(double letterSpacing) {
        this.letterSpacing = letterSpacing;
    }

    public String getPlayedColorMode() {
        return playedColorMode;
    }

    public void setPlayedColorMode(String playedColorMode) {
        this.playedColorMode = playedColorMode;
    }

    public String getPlayedSolidColor() {
        return playedSolidColor;
    }

    public void setPlayedSolidColor(String playedSolidColor) {
        this.playedSolidColor = playedSolidColor;
    }

    public String getGradientStart() {
        return gradientStart;
    }

    public void setGradientStart(String gradientStart) {
        this.gradientStart = gradientStart;
    }

    public String getGradientMiddle() {
        return gradientMiddle;
    }

    public void setGradientMiddle(String gradientMiddle) {
        this.gradientMiddle = gradientMiddle;
    }

    public String getGradientEnd() {
        return gradientEnd;
    }

    public void setGradientEnd(String gradientEnd) {
        this.gradientEnd = gradientEnd;
    }

    public String getUnplayedColor() {
        return unplayedColor;
    }

    public void setUnplayedColor(String unplayedColor) {
        this.unplayedColor = unplayedColor;
    }

    public boolean isStrokeEnabled() {
        return strokeEnabled;
    }

    public void setStrokeEnabled(boolean strokeEnabled) {
        this.strokeEnabled = strokeEnabled;
    }

    public String getStrokeColor() {
        return strokeColor;
    }

    public void setStrokeColor(String strokeColor) {
        this.strokeColor = strokeColor;
    }

    public double getStrokeOpacity() {
        return strokeOpacity;
    }

    public void setStrokeOpacity(double strokeOpacity) {
        this.strokeOpacity = strokeOpacity;
    }

    public double getStrokeWidth() {
        return strokeWidth;
    }

    public void setStrokeWidth(double strokeWidth) {
        this.strokeWidth = strokeWidth;
    }

    public boolean isShadowEnabled() {
        return shadowEnabled;
    }

    public void setShadowEnabled(boolean shadowEnabled) {
        this.shadowEnabled = shadowEnabled;
    }

    public String getShadowColor() {
        return shadowColor;
    }

    public void setShadowColor(String shadowColor) {
        this.shadowColor = shadowColor;
    }

    public double getShadowOpacity() {
        return shadowOpacity;
    }

    public void setShadowOpacity(double shadowOpacity) {
        this.shadowOpacity = shadowOpacity;
    }

    public double getShadowBlur() {
        return shadowBlur;
    }

    public void setShadowBlur(double shadowBlur) {
        this.shadowBlur = shadowBlur;
    }

    public double getShadowDistance() {
        return shadowDistance;
    }

    public void setShadowDistance(double shadowDistance) {
        this.shadowDistance = shadowDistance;
    }

    public double getShadowAngle() {
        return shadowAngle;
    }

    public void setShadowAngle(double shadowAngle) {
        this.shadowAngle = shadowAngle;
    }

    public boolean isFadeEnabled() {
        return fadeEnabled;
    }

    public void setFadeEnabled(boolean fadeEnabled) {
        this.fadeEnabled = fadeEnabled;
    }

    public double getFadeInDuration() {
        return fadeInDuration;
    }

    public void setFadeInDuration(double fadeInDuration) {
        this.fadeInDuration = fadeInDuration;
    }

    public double getFadeOutDuration() {
        return fadeOutDuration;
    }

    public void setFadeOutDuration(double fadeOutDuration) {
        this.fadeOutDuration = fadeOutDuration;
    }

    public int getMaxChars() {
        return maxChars;
    }

    public void setMaxChars(int maxChars) {
        this.maxChars = maxChars;
    }

    public double getLineGap() {
        return lineGap;
    }

    public void setLineGap(double lineGap) {
        this.lineGap = lineGap;
    }

    public double getBottomMargin() {
        return bottomMargin;
    }

    public void setBottomMargin(double bottomMargin) {
        this.bottomMargin = bottomMargin;
    }
}
