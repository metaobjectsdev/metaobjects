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

import com.metaobjects.attr.StringArrayAttribute;
import com.metaobjects.attr.StringAttribute;

import java.util.List;

/**
 * The 7 universal documentation common attrs. Mirrors the TS {@code commonDocAttrs}
 * array and the C# {@code DocumentationSchema.CommonDocAttrs} list.
 *
 * <p>Value types use the Java-side subtype constants:</p>
 * <ul>
 *   <li>{@link StringAttribute#SUBTYPE_STRING} ({@code "string"}) — scalar string attrs</li>
 *   <li>{@link StringArrayAttribute#SUBTYPE_STRING_ARRAY} ({@code "stringarray"}) — array attrs</li>
 * </ul>
 *
 * <p>These values are cross-language-stable: TS uses {@code ATTR_SUBTYPE_STRING} /
 * {@code ATTR_SUBTYPE_STRINGARRAY} with the same underlying strings. Do not change them.</p>
 */
public final class DocumentationSchema {
    private DocumentationSchema() {}

    /**
     * A single documentation common-attr descriptor.
     *
     * @param name        Bare attr name (no {@code @} prefix). Cross-language-stable.
     * @param valueType   Attr value subtype — {@code "string"} or {@code "stringarray"}.
     * @param required    Whether this attr is required (all doc attrs are optional).
     * @param description Human-readable description of the attr's purpose.
     */
    public record CommonDocAttr(
        String name,
        String valueType,
        boolean required,
        String description
    ) {}

    /** The 8 universal documentation common attrs in declaration order. */
    public static final List<CommonDocAttr> COMMON_DOC_ATTRS = List.of(
        new CommonDocAttr(
            DocumentationConstants.DOC_ATTR_DESCRIPTION,
            StringAttribute.SUBTYPE_STRING,
            false,
            "Free-form user-facing prose. Markdown allowed, multi-line via YAML '|' block scalar. "
            + "Flows into doc-gen surfaces (JSDoc / XML-doc / Postgres COMMENT / Mermaid prose)."
        ),
        new CommonDocAttr(
            DocumentationConstants.DOC_ATTR_SUMMARY,
            StringAttribute.SUBTYPE_STRING,
            false,
            "Short single-line tagline (OpenAPI `summary` pattern) — used in index tables, sidebar "
            + "previews, and AI prompts where the full @description is too long. Optional supplement "
            + "to @description; when @summary is unset, doc surfaces typically fall back to the first "
            + "sentence of @description."
        ),
        new CommonDocAttr(
            DocumentationConstants.DOC_ATTR_TITLE,
            StringAttribute.SUBTYPE_STRING,
            false,
            "Short single-line human label (e.g. 'Email' for a field.string email). "
            + "Optional supplement to description."
        ),
        new CommonDocAttr(
            DocumentationConstants.DOC_ATTR_NOTES,
            StringAttribute.SUBTYPE_STRING,
            false,
            "Internal-only rationale. Stays in metadata; never emitted to user-facing docs."
        ),
        new CommonDocAttr(
            DocumentationConstants.DOC_ATTR_DEPRECATED,
            StringAttribute.SUBTYPE_STRING,
            false,
            "Text reason for deprecation. Presence => deprecated. "
            + "Codegen emits @deprecated / [Obsolete] with this reason."
        ),
        new CommonDocAttr(
            DocumentationConstants.DOC_ATTR_REPLACED_BY,
            StringAttribute.SUBTYPE_STRING,
            false,
            "FQN reference to the replacement element. Only meaningful with `deprecated`. "
            + "Codegen appends 'Replaced by <ref>' to deprecation messages."
        ),
        new CommonDocAttr(
            DocumentationConstants.DOC_ATTR_SEE_ALSO,
            StringArrayAttribute.SUBTYPE_STRING_ARRAY,
            false,
            "External documentation URLs. Codegen emits @see / <seealso href=...>."
        ),
        new CommonDocAttr(
            DocumentationConstants.DOC_ATTR_ALIASES,
            StringArrayAttribute.SUBTYPE_STRING_ARRAY,
            false,
            "Alternate names for this element. Aids AI authoring disambiguation, search, migration."
        )
    );
}
