package com.metaobjects.spring;

import org.junit.Test;
import org.springframework.boot.context.annotation.ImportCandidates;
import org.springframework.boot.autoconfigure.AutoConfiguration;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertTrue;

/**
 * Boot 3 reads autoconfiguration classes from
 * META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports,
 * NOT the legacy spring.factories EnableAutoConfiguration key. This pins that the
 * MetaObjects autoconfigurations are discoverable the Boot-3 way.
 */
public class AutoConfigurationRegistrationTest {

    private static List<String> candidates() {
        List<String> out = new ArrayList<>();
        ImportCandidates.load(AutoConfiguration.class,
                AutoConfigurationRegistrationTest.class.getClassLoader())
            .forEach(out::add);
        return out;
    }

    @Test
    public void metaDataAutoConfiguration_isRegisteredForBoot3Discovery() {
        assertTrue("MetaDataAutoConfiguration must be listed in AutoConfiguration.imports; saw: " + candidates(),
            candidates().contains("com.metaobjects.spring.MetaDataAutoConfiguration"));
    }

    @Test
    public void objectManagerAutoConfiguration_isRegisteredForBoot3Discovery() {
        assertTrue("ObjectManagerAutoConfiguration must be listed in AutoConfiguration.imports; saw: " + candidates(),
            candidates().contains("com.metaobjects.spring.ObjectManagerAutoConfiguration"));
    }
}
