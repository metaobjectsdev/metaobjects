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
package com.metaobjects.manager.db;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.ObjectRef;
import com.metaobjects.manager.exp.Expression;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.registry.ServiceRegistryFactory;
import org.junit.AfterClass;
import org.junit.BeforeClass;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.*;

/** An objectref id becomes a numeric key only from canonical decimal text; string keys stay text. */
public class PrimaryKeyRefTextTest {

    private static MetaDataLoader numLoader;
    private static MetaDataLoader strLoader;
    private static MetaObject longKeyed;
    private static MetaObject stringKeyed;

    @BeforeClass
    public static void load() throws Exception {
        MetaDataLoaderRegistry registry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
        numLoader = MetaDataLoader.fromResources("test-refkey-num", List.of("meta.codec.json"));
        registry.registerLoader(numLoader);
        strLoader = MetaDataLoader.fromResources("test-refkey-str", List.of("meta.uuid.json"));
        registry.registerLoader(strLoader);
        longKeyed = registry.findMetaObjectByName("codectest::Sample");
        stringKeyed = registry.findMetaObjectByName("uuidtest::Widget");
    }

    @AfterClass
    public static void teardown() {
        if (numLoader != null) numLoader.destroy();
        if (strLoader != null) strLoader.destroy();
    }

    private static Expression build(MetaObject mo, String id) {
        return new ObjectManagerDB().buildPrimaryKeyExpressionFromRef(mo, new ObjectRef(mo, new String[]{id}));
    }

    @Test
    public void canonicalIdsBecomeLong() {
        assertEquals(1L, build(longKeyed, "1").getValue());
        assertEquals(0L, build(longKeyed, "0").getValue());
    }

    @Test
    public void textThatIsNoKeyIsRefused() {
        for (String bad : new String[]{"0x1", "1e0", "+1", "01"}) {
            assertThrows(bad, IllegalArgumentException.class, () -> build(longKeyed, bad));
        }
    }

    @Test
    public void stringKeysStayText() {
        assertEquals("0123", build(stringKeyed, "0123").getValue());
    }
}
