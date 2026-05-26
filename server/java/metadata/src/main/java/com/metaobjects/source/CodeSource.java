/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.source;

/**
 * Programmatic / test-construction provenance — the default for any node not
 * built by a loader phase.
 *
 * <p>Mirrors {@code CodeSource} in
 * {@code server/csharp/MetaObjects/Source/ErrorSource.cs}. The
 * {@link #DEFAULT} singleton is the canonical no-caller instance returned by
 * {@code MetaData.getSource()} when nothing has been set.</p>
 *
 * @param caller optional human label (e.g. {@code "QueriesTest.makePost"});
 *               may be {@code null}
 */
public record CodeSource(String caller) implements ErrorSource {

    /** Canonical singleton for the no-caller case. */
    public static final CodeSource DEFAULT = new CodeSource(null);

    /** Convenience constructor: no caller label. */
    public CodeSource() {
        this(null);
    }

    @Override
    public String format() {
        return "code";
    }
}
