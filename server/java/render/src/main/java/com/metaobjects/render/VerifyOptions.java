package com.metaobjects.render;

import java.util.List;

/**
 * Optional inputs to {@link Verify#check(String, java.util.List, VerifyOptions)}.
 *
 * <p>{@link #provider} — when set, {@code {{> ref}}} partials are resolved and
 * their bodies recursed (cycle + depth-guarded). When null, partials are
 * skipped silently (no error, no recursion).
 *
 * <p>{@link #requiredSlots} — slot names that MUST be referenced somewhere in
 * the template body (at the root context). Unused slots produce
 * {@code ERR_REQUIRED_SLOT_UNUSED} (warning-level).
 *
 * <p>{@link #requiredTags} — output tag names that MUST appear in the rendered
 * static text (body + resolved partials). Each tag must have both an opening
 * form ({@code <tag} followed by {@code >} or whitespace, so attributes are
 * allowed) and a closing {@code </tag>}.
 */
public record VerifyOptions(
    Provider provider,
    List<String> requiredSlots,
    List<String> requiredTags
) {
    /** Convenience: a fully-defaulted options record (all fields null). */
    public static VerifyOptions empty() {
        return new VerifyOptions(null, null, null);
    }
}
