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
package com.metaobjects.object.pojo;

import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.MetaObjectAware;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;

import static org.junit.Assert.assertSame;

/**
 * Regression guard for {@link PojoObject} — the base class code-generated POJOs
 * extend to carry their {@link MetaObject} back-reference.
 *
 * <p>The legacy reference's {@code setMetaData} did a self-assignment
 * ({@code metaObject = metaObject}) AND held the field {@code final}, so the
 * back-ref could never be set or updated. This test asserts the ctor-supplied
 * MetaObject is returned by {@code getMetaData()} AND that a later
 * {@code setMetaData(...)} actually replaces it.</p>
 */
public class PojoObjectTest {

    private static final String PKG = "com::example::om";
    private static final String PERSON_FQN = PKG + "::Person";
    private static final String ADDRESS_FQN = PKG + "::Address";

    /** Minimal generated-POJO stand-in: extends PojoObject, ctor passes the MetaObject up. */
    static class Sample extends PojoObject {
        Sample(MetaObject mo) {
            super(mo);
        }
    }

    private static Path locateCorpus() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve("fixtures/object-model-conformance");
            if (Files.isDirectory(candidate)) {
                return candidate;
            }
            dir = dir.getParent();
        }
        throw new AssertionError(
                "Could not locate fixtures/object-model-conformance/ by walking up from: "
                        + Paths.get("").toAbsolutePath());
    }

    private MetaDataLoader loadCorpus(String loaderName) {
        Path meta = locateCorpus().resolve("meta.json");
        String canonical;
        try {
            canonical = new String(Files.readAllBytes(meta), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new AssertionError("Could not read corpus meta.json at " + meta, e);
        }
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "pojo-object-test-" + loaderName);
        loader.init();
        loader.load(List.of(new InMemoryStringSource(canonical, "object-model-conformance/meta.json")));
        return loader;
    }

    @Test
    public void ctorSuppliedMetaObjectIsReturned() {
        MetaDataLoader loader = loadCorpus("ctor");
        MetaObject person = loader.getMetaObjectByName(PERSON_FQN);

        Sample sample = new Sample(person);
        assertSame("ctor-supplied MetaObject must be the back-reference",
                person, sample.getMetaData());
    }

    @Test
    public void setMetaDataActuallyUpdatesBackRef() {
        MetaDataLoader loader = loadCorpus("set");
        MetaObject person = loader.getMetaObjectByName(PERSON_FQN);
        MetaObject address = loader.getMetaObjectByName(ADDRESS_FQN);

        Sample sample = new Sample(person);
        assertSame("precondition: starts as Person", person, sample.getMetaData());

        // Legacy-bug regression guard: setMetaData must actually replace the back-ref.
        ((MetaObjectAware) sample).setMetaData(address);
        assertSame("setMetaData must update the back-reference to the new MetaObject",
                address, sample.getMetaData());
    }
}
