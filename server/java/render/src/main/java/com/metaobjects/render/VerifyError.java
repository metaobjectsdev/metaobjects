package com.metaobjects.render;

/**
 * A single drift finding from {@link Verify#check(String, java.util.List, VerifyOptions)} —
 * an error code (one of the {@code Verify.ERR_*} constants) plus the offending
 * variable path / partial ref / slot / tag name.
 */
public record VerifyError(String code, String path) {}
