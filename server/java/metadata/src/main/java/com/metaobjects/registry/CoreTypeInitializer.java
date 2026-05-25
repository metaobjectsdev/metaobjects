package com.metaobjects.registry;

import com.metaobjects.attr.PropertiesAttribute;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Core type initializer that ensures all core types are loaded and registered.
 * This class explicitly loads core classes to trigger their static registration blocks.
 * Note: DataObject and ValueObject types are now handled by the dynamic module.
 */
public class CoreTypeInitializer {

    private static final Logger log = LoggerFactory.getLogger(CoreTypeInitializer.class);
    private static boolean initialized = false;

    /**
     * Initialize all core types by loading their classes to trigger static blocks.
     * Uses string-based Class.forName to avoid a compile-time dependency on classes
     * that reside in a sibling module (file-IO loader lives in the same package after
     * the WA4 move, but this class must compile independently from metadata).
     */
    public static synchronized void initializeCoreTypes() {
        if (initialized) {
            return;
        }

        try {
            log.debug("Loading core MetaData types...");

            // Load FileMetaDataLoader to trigger its static block.
            // String literal avoids a compile-time dep; the class is always on the
            // classpath at runtime (same artifact after WA4 completes).
            Class.forName("com.metaobjects.loader.file.FileMetaDataLoader");
            log.debug("Loaded FileMetaDataLoader type");

            // Load PropertiesAttribute to trigger its static block
            Class.forName(PropertiesAttribute.class.getName());
            log.debug("Loaded PropertiesAttribute type");

            // Note: DataObject and ValueObject initialization is now handled by the dynamic module

            initialized = true;
            log.debug("Successfully initialized core MetaData types");

        } catch (ClassNotFoundException e) {
            log.error("Failed to load core MetaData types", e);
            throw new RuntimeException("Failed to initialize core MetaData types", e);
        }
    }

    // Static block to auto-initialize when this class is loaded
    static {
        initializeCoreTypes();
    }
}