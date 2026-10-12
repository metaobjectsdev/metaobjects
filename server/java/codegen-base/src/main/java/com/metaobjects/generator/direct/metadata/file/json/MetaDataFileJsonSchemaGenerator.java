package com.metaobjects.generator.direct.metadata.file.json;

import com.metaobjects.generator.CodeGenMetaDataProvider;
import com.metaobjects.generator.GeneratorIOException;
import com.metaobjects.generator.direct.metadata.json.SingleJsonDirectGeneratorBase;
import com.metaobjects.generator.direct.metadata.json.JsonDirectWriter;
import com.metaobjects.loader.MetaDataLoader;

import java.io.OutputStream;

/**
 * Generator for creating JSON Schema that validates metadata files themselves.
 * v6.0.0: Creates schemas for validating the structure of metadata JSON files
 * (like {"metadata": {"children": [...]}}), not the data instances.
 * 
 * This reads constraint definitions to understand valid metadata structure and
 * generates JSON Schema that can validate metadata files during development.
 */
public class MetaDataFileJsonSchemaGenerator extends SingleJsonDirectGeneratorBase {

    public final static String ARG_SCHEMA_VERSION = "schemaVersion";
    public final static String ARG_SCHEMA_ID = "schemaId";
    public final static String ARG_TITLE = "title";
    public final static String ARG_DESCRIPTION = "description";

    private String schemaVersion = "https://json-schema.org/draft/2020-12/schema";
    private String schemaId = null;
    private String title = "MetaData File JSON Schema";
    private String description = "JSON Schema for validating MetaData file structure";

    //////////////////////////////////////////////////////////////////////
    // SingleFileDirectorGenerator Execute Override methods

    @Override
    protected void parseArgs() {
        if (hasArg(ARG_SCHEMA_VERSION)) {
            schemaVersion = getArg(ARG_SCHEMA_VERSION);
        }
        
        if (hasArg(ARG_SCHEMA_ID)) {
            schemaId = getArg(ARG_SCHEMA_ID);
        }
        
        if (hasArg(ARG_TITLE)) {
            title = getArg(ARG_TITLE);
        }
        
        if (hasArg(ARG_DESCRIPTION)) {
            description = getArg(ARG_DESCRIPTION);
        }

        if (log.isDebugEnabled()) log.debug(toString());
    }

    @Override
    protected JsonDirectWriter getWriter(MetaDataLoader loader, OutputStream os) throws GeneratorIOException {
        return new MetaDataFileSchemaWriter(loader, os)
                .withSchemaVersion(schemaVersion)
                .withSchemaId(schemaId)
                .withTitle(title)
                .withDescription(description);
    }

    ///////////////////////////////////////////////////
    // Misc Methods

    @Override
    public String toString() {
        final StringBuilder sb = new StringBuilder(this.getClass().getSimpleName() + "{");
        sb.append("args=").append(getArgs());
        sb.append(", filters=").append(getFilters());
        sb.append(", schemaVersion=").append(schemaVersion);
        sb.append(", schemaId=").append(schemaId);
        sb.append(", title=").append(title);
        sb.append(", description=").append(description);
        sb.append('}');
        return sb.toString();
    }

    ///////////////////////////////////////////////////
    // Service Provider Pattern Registration
    //
    // The attributes and their registration live in CodeGenMetaDataProvider, which the loader
    // consults, so a copy of this generator made by `mvn metaobjects:eject` owns emit code only.
    // These names stay here for existing callers.

    /** @deprecated use {@link CodeGenMetaDataProvider#JSON_SCHEMA_VERSION} */
    @Deprecated
    public static final String JSON_SCHEMA_VERSION = CodeGenMetaDataProvider.JSON_SCHEMA_VERSION;
    /** @deprecated use {@link CodeGenMetaDataProvider#JSON_SCHEMA_ID} */
    @Deprecated
    public static final String JSON_SCHEMA_ID = CodeGenMetaDataProvider.JSON_SCHEMA_ID;
    /** @deprecated use {@link CodeGenMetaDataProvider#JSON_TITLE} */
    @Deprecated
    public static final String JSON_TITLE = CodeGenMetaDataProvider.JSON_TITLE;
    /** @deprecated use {@link CodeGenMetaDataProvider#JSON_DESCRIPTION} */
    @Deprecated
    public static final String JSON_DESCRIPTION = CodeGenMetaDataProvider.JSON_DESCRIPTION;
    /** @deprecated use {@link CodeGenMetaDataProvider#JSON_FORMAT} */
    @Deprecated
    public static final String JSON_FORMAT = CodeGenMetaDataProvider.JSON_FORMAT;
    /** @deprecated use {@link CodeGenMetaDataProvider#JSON_PATTERN} */
    @Deprecated
    public static final String JSON_PATTERN = CodeGenMetaDataProvider.JSON_PATTERN;
    /** @deprecated use {@link CodeGenMetaDataProvider#JSON_ENUM} */
    @Deprecated
    public static final String JSON_ENUM = CodeGenMetaDataProvider.JSON_ENUM;
    /** @deprecated use {@link CodeGenMetaDataProvider#JSON_MINIMUM} */
    @Deprecated
    public static final String JSON_MINIMUM = CodeGenMetaDataProvider.JSON_MINIMUM;
    /** @deprecated use {@link CodeGenMetaDataProvider#JSON_MAXIMUM} */
    @Deprecated
    public static final String JSON_MAXIMUM = CodeGenMetaDataProvider.JSON_MAXIMUM;

    /** @deprecated use {@link CodeGenMetaDataProvider#registerJsonSchemaAttributes} */
    @Deprecated
    public static void registerJsonSchemaAttributes(com.metaobjects.registry.MetaDataRegistry registry) {
        CodeGenMetaDataProvider.registerJsonSchemaAttributes(registry);
    }
}