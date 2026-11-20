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
package com.metaobjects.manager.db.codec;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.registry.ServiceRegistryFactory;
import org.junit.AfterClass;
import org.junit.BeforeClass;
import org.junit.Test;

import java.math.BigDecimal;
import java.util.List;

import static org.junit.Assert.*;

/**
 * A numeric key or id read from text (an objectref id, a path id, a filter value) is accepted
 * only as canonical decimal text, by KeyText.coerce.
 */
public class NumericKeyTextTest {

    private static MetaDataLoader loader;
    private static MetaObject sample;

    @BeforeClass
    public static void load() throws Exception {
        MetaDataLoaderRegistry registry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
        loader = MetaDataLoader.fromResources("test-numeric-key", List.of("meta.codec.json"));
        registry.registerLoader(loader);
        sample = registry.findMetaObjectByName("codectest::Sample");
    }

    @AfterClass
    public static void teardown() {
        if (loader != null) loader.destroy();
    }

    private static Object bind(String field, String text) {
        return KeyText.coerce(sample.getMetaField(field), text);
    }

    @Test
    public void canonicalTextIsRead() throws Exception {
        assertEquals(1L, bind("id", "1"));
        assertEquals(0L, bind("id", "0"));
        assertEquals(-7L, bind("id", "-7"));
        assertEquals(-7, bind("count", "-7"));
        assertEquals(new BigDecimal("1.5"), bind("amount", "1.5"));
        assertEquals(1.5d, bind("ratio", "1.5"));
        assertEquals(-2.5f, bind("rate", "-2.5"));
        assertEquals(12L, bind("moneyVal", "12"));
    }

    @Test
    public void textThatIsNoIntegerKeyIsRefused() {
        for (String f : new String[]{"id", "count", "moneyVal"}) {
            for (String bad : new String[]{"0x1", "1e0", "0b1", "+1", " 1", "1 ", "", "01", "-0", "1.", "1.5",
                    ".5", "-", "1_0", "٣", "1٣", "99999999999999999999"}) {
                IllegalArgumentException e = assertThrows("[" + f + "] " + bad, IllegalArgumentException.class,
                    () -> bind(f, bad));
                assertTrue(e.getMessage(), e.getMessage().contains("Sample." + f));
                assertFalse("message must not echo the key text", !bad.isEmpty() && e.getMessage().contains("[" + bad + "]"));
            }
        }
    }

    @Test
    public void textThatIsNoDecimalKeyIsRefused() {
        for (String f : new String[]{"amount", "ratio", "rate"}) {
            for (String bad : new String[]{"0x1", "1e0", "1E5", "1.", ".5", "+1.5", "-0", "-0.0", "01.5", "1.5.2",
                    "1,5", " 1.5", "NaN", "Infinity", "٣"}) {
                assertThrows("[" + f + "] " + bad, IllegalArgumentException.class, () -> bind(f, bad));
            }
        }
    }

    @Test
    public void canonicalTextTooLargeForTheTypeIsRefused() throws Exception {
        String huge = "1" + "0".repeat(400);
        assertThrows(IllegalArgumentException.class, () -> bind("ratio", huge));
        assertThrows(IllegalArgumentException.class, () -> bind("rate", huge));
        assertEquals(new BigDecimal(huge), bind("amount", huge)); // a decimal has no such limit
    }

    @Test
    public void stringKeysAreUntouched() throws Exception {
        assertEquals("0123", bind("label", "0123"));
        assertEquals("0x1", bind("label", "0x1"));
    }
}
