/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
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
