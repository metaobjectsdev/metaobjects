package com.metaobjects.loader.validation;

import com.metaobjects.source.ErrorSource;

/**
 * A collected validation finding. {@code code} is a String (not the {@link
 * com.metaobjects.ErrorCode} enum) so a DOWNSTREAM provider can emit its own codes; the
 * loader maps built-in codes back to the enum when it eager-throws. Phase 2 prototype —
 * see docs/superpowers/specs/2026-06-19-metadata-validation-architecture-design.md.
 */
public record ValidationError(String code, String message, ErrorSource source) {}
