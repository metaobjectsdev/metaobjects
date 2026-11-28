package com.metaobjects.render.templategen;

/**
 * One walk entry: a payload + the output path the rendered template should
 * be emitted to (relative to whatever output root the caller chooses).
 *
 * <p>{@code sourceNode} is the resolution key of the node a per-entity entry was walked from;
 * {@code null} for a per-package or per-model entry.
 */
public record TemplateWalkResult(Object data, String outputPath, String sourceNode) {
    /** An entry walked from no single node. */
    public TemplateWalkResult(Object data, String outputPath) {
        this(data, outputPath, null);
    }
}
