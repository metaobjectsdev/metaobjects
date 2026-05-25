package com.metaobjects.render;

/**
 * Thrown when a render fails — unresolved {@code ref}, unresolved or cyclic
 * partial, partial-expansion depth overflow, or Mustache compile / execute
 * failure. Also thrown when {@link RenderRequest} validation fails (neither
 * template nor ref set, both set, missing provider/payload).
 */
public final class RenderException extends RuntimeException {

    public RenderException(String message) {
        super(message);
    }

    public RenderException(String message, Throwable cause) {
        super(message, cause);
    }
}
