package acme.commerce

/**
 * GENERATED — do not hand-edit.
 * Shared Jackson ObjectMapper backing the typed `field.object @storage:jsonb` and
 * `field.map` Exposed `jsonb()` columns in this package. Jackson (not kotlinx) is the
 * codec, so the generated entity/value data classes carry NO `@Serializable` and need
 * NO per-type serializer plumbing — every java.time / java.util / java.math / java.net
 * field a jsonb value object may carry round-trips through the kotlin + jsr310 modules
 * with no compiler plugin.
 *
 * Consumer classpath: jackson-databind, jackson-module-kotlin, jackson-datatype-jsr310.
 */
internal val metaJsonbMapper: com.fasterxml.jackson.databind.ObjectMapper =
    com.fasterxml.jackson.databind.json.JsonMapper.builder()
        .addModule(com.fasterxml.jackson.module.kotlin.kotlinModule())
        .addModule(com.fasterxml.jackson.datatype.jsr310.JavaTimeModule())
        .disable(com.fasterxml.jackson.databind.SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
        .build()

