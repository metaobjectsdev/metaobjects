/*
 * Copyright 2026 Doug Mealing LLC dba Meta Objects
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
package com.metaobjects.documentation;

import java.util.List;

/**
 * The 7 universal documentation common-attr names. Bare strings, identical
 * across all language ports (TS / C# / Java / Python). The serializer adds
 * the @-prefix on canonical JSON output per ADR-0006.
 */
public final class DocumentationConstants {
    private DocumentationConstants() {}

    public static final String DOC_ATTR_DESCRIPTION = "description";
    public static final String DOC_ATTR_SUMMARY      = "summary";
    public static final String DOC_ATTR_TITLE        = "title";
    public static final String DOC_ATTR_NOTES        = "notes";
    public static final String DOC_ATTR_DEPRECATED   = "deprecated";
    public static final String DOC_ATTR_REPLACED_BY  = "replacedBy";
    public static final String DOC_ATTR_SEE_ALSO     = "seeAlso";
    public static final String DOC_ATTR_ALIASES      = "aliases";

    /** All 8 names in declaration order. */
    public static final List<String> DOC_ATTR_NAMES = List.of(
        DOC_ATTR_DESCRIPTION,
        DOC_ATTR_SUMMARY,
        DOC_ATTR_TITLE,
        DOC_ATTR_NOTES,
        DOC_ATTR_DEPRECATED,
        DOC_ATTR_REPLACED_BY,
        DOC_ATTR_SEE_ALSO,
        DOC_ATTR_ALIASES
    );
}
