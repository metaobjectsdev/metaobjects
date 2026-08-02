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
package com.metaobjects.loader;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * #246 — a {@code field.enum} that both {@code extends} a shared root-level
 * abstract enum AND declares its own {@code @values} must fail to load with
 * {@code ERR_ENUM_EXTENDS_VALUES_CONFLICT}: one shared enum type has one
 * member set, so the own {@code @values} would be silently dropped by
 * codegen's shared-enum collapse.
 *
 * <p>Mirrors the TS reference test
 * ({@code server/typescript/packages/metadata/test/enum-extends-values-conflict.test.ts})
 * and the Java loader also covers Kotlin (Kotlin inherits the JVM loader).</p>
 *
 * <p>Three cases (the third pins the "root-level" clause of the predicate —
 * dropping the {@code sup.getParent() instanceof MetaRoot} check would let a
 * non-root abstract super go unrejected):</p>
 * <ol>
 *   <li>CONFLICT — extends a root-level (metadata.root child) abstract enum,
 *       and also declares its own {@code @values}.</li>
 *   <li>LEGAL — extends a CONCRETE (non-abstract) enum, and also declares its
 *       own {@code @values}.</li>
 *   <li>LEGAL — extends an ABSTRACT but NON-ROOT enum (declared as a child of
 *       an {@code object.entity}, not the shared package level), and also
 *       declares its own {@code @values}.</li>
 * </ol>
 */
public class EnumExtendsValuesConflictTest extends SharedRegistryTestBase {

    private MetaDataLoader newTestLoader() {
        return createTestLoader("EnumExtendsValuesConflictTest", Collections.emptyList());
    }

    private MetaDataLoader loadThrough(String canonical, String id) {
        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(new InMemoryStringSource(canonical, id)));
        return loader;
    }

    // ------------------------------------------------------------------------
    // 1 — CONFLICT: root-level abstract super + own @values.
    // ------------------------------------------------------------------------

    private static final String CONFLICT_ROOT_LEVEL_ABSTRACT_SUPER =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"field.enum\": { \"name\": \"Status\", \"@isAbstract\": true,"
            + "      \"@values\": [\"A\", \"B\"] } },"
            + "  { \"object.entity\": { \"name\": \"Order\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.enum\": { \"name\": \"status\", \"extends\": \"acme::Status\","
            + "        \"@values\": [\"A\", \"B\", \"C\"] } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } }"
            + "  ] } }"
            + "] } }";

    @Test
    public void conflictExtendsRootLevelAbstractEnumWithOwnValues() {
        try {
            loadThrough(CONFLICT_ROOT_LEVEL_ABSTRACT_SUPER, "conflict-root-abstract.json");
            fail("Expected MetaDataException for field.enum extending a shared root-level"
                + " abstract enum while also declaring its own @values");
        } catch (MetaDataException e) {
            assertTrue("must signal ERR_ENUM_EXTENDS_VALUES_CONFLICT: " + e.getMessage(),
                signalsEnumExtendsValuesConflict(e));
            assertTrue("message should name the conflicting field 'status': " + e.getMessage(),
                e.getMessage().contains("status"));
        }
    }

    // ------------------------------------------------------------------------
    // 2 — LEGAL: concrete (non-abstract) super + own @values.
    // ------------------------------------------------------------------------

    private static final String LEGAL_CONCRETE_SUPER =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"field.enum\": { \"name\": \"Status\","
            + "      \"@values\": [\"A\", \"B\"] } },"
            + "  { \"object.entity\": { \"name\": \"Order\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.enum\": { \"name\": \"status\", \"extends\": \"acme::Status\","
            + "        \"@values\": [\"A\", \"B\", \"C\"] } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } }"
            + "  ] } }"
            + "] } }";

    @Test
    public void legalExtendsConcreteEnumWithOwnValues() {
        MetaDataLoader loader = loadThrough(LEGAL_CONCRETE_SUPER, "legal-concrete-super.json");
        // Loaded cleanly — no ERR_ENUM_EXTENDS_VALUES_CONFLICT for a concrete super.
        assertTrue("expected no warnings", loader.getWarnings().isEmpty());
    }

    // ------------------------------------------------------------------------
    // 3 — LEGAL: abstract but NON-ROOT super (nested inside an object) + own @values.
    // ------------------------------------------------------------------------

    private static final String LEGAL_NON_ROOT_ABSTRACT_SUPER =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Container\", \"@isAbstract\": true, \"children\": ["
            + "    { \"field.enum\": { \"name\": \"kind\", \"@isAbstract\": true,"
            + "        \"@values\": [\"X\", \"Y\"] } }"
            + "  ] } },"
            + "  { \"object.entity\": { \"name\": \"Order\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.enum\": { \"name\": \"status\", \"extends\": \"acme::Container.kind\","
            + "        \"@values\": [\"X\", \"Y\", \"Z\"] } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } }"
            + "  ] } }"
            + "] } }";

    @Test
    public void legalExtendsNonRootAbstractEnumWithOwnValues() {
        // Pins the `sup.getParent() instanceof MetaRoot` clause of the predicate —
        // dropping it would incorrectly reject this nested-abstract-super case.
        MetaDataLoader loader = loadThrough(LEGAL_NON_ROOT_ABSTRACT_SUPER, "legal-non-root-abstract.json");
        assertTrue("expected no warnings", loader.getWarnings().isEmpty());
    }

    /** True if the exception signals ERR_ENUM_EXTENDS_VALUES_CONFLICT via code or message. */
    private static boolean signalsEnumExtendsValuesConflict(MetaDataException e) {
        boolean byCode = e.getCode().map(c -> c == ErrorCode.ERR_ENUM_EXTENDS_VALUES_CONFLICT).orElse(false);
        boolean byMsg = e.getMessage() != null
            && e.getMessage().contains("ERR_ENUM_EXTENDS_VALUES_CONFLICT");
        return byCode || byMsg;
    }
}
