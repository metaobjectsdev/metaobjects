package com.metaobjects.render.templategen;

/**
 * One walk entry: a payload + the output path the rendered template should
 * be emitted to (relative to whatever output root the caller chooses).
 */
public record TemplateWalkResult(Object data, String outputPath) {}
