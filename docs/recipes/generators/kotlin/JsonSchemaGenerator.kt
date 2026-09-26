// EXAMPLE GENERATOR — copy into a Kotlin codegen Maven module the metaobjects-maven-plugin
// has as a <dependency>, and own it. Not a supported MetaObjects product surface.
//
// Kotlin generators run through the same `mvn metaobjects:generate` SPI as Java ones:
//   <generator>
//     <classname>com.acme.codegen.KtJsonSchemaGenerator</classname>
//     <args><outputDir>${project.basedir}/src/main/resources/schemas</outputDir></args>
//   </generator>
// `mvn metaobjects:verify` re-runs it and fails on drift.
//
// Emits <Name>.schema.json (JSON Schema 2020-12) per concrete object.
package com.acme.codegen

import com.metaobjects.field.MetaField
import com.metaobjects.generator.FileEmittingGenerator
import com.metaobjects.generator.ModelWalk
import com.metaobjects.loader.MetaDataLoader

class KtJsonSchemaGenerator : FileEmittingGenerator() {

    override fun generate(loader: MetaDataLoader): List<EmittedFile> =
        // concreteObjects: abstract bases only contribute fields to what extends them.
        ModelWalk.concreteObjects(loader).map { obj ->
            // ModelWalk.fields RESOLVES: inherited fields included.
            val fields = ModelWalk.fields(obj)
            val props = fields.joinToString(",\n") { f -> "    \"${f.name}\": ${fieldSchema(f)}" }
            val required = fields.filter(ModelWalk::isRequired).joinToString(", ") { "\"${it.name}\"" }
            // ModelWalk.name, not obj.name: that is the FQN "shop::Customer".
            val name = ModelWalk.name(obj)
            EmittedFile(
                "$name.schema.json",
                """
                |{
                |  "${'$'}schema": "https://json-schema.org/draft/2020-12/schema",
                |  "title": "$name",
                |  "type": "object",
                |  "properties": {
                |$props
                |  },
                |  "required": [$required]
                |}
                |""".trimMargin(),
            )
        }

    private fun fieldSchema(f: MetaField<*>): String {
        val value = when (f.subType) {
            "int", "long", "currency" -> """{"type": "integer"}"""
            "double", "float" -> """{"type": "number"}"""
            "boolean" -> """{"type": "boolean"}"""
            "date" -> """{"type": "string", "format": "date"}"""
            "timestamp" -> """{"type": "string", "format": "date-time"}"""
            "enum" -> """{"type": "string", "enum": [${ModelWalk.enumValues(f).joinToString(", ") { "\"$it\"" }}]}"""
            // Package-aware @objectRef (ADR-0042), never a short-name match.
            "object" -> ModelWalk.objectRefTarget(f)?.let { """{"${'$'}ref": "./${ModelWalk.name(it)}.schema.json"}""" }
                ?: """{"type": "object"}"""
            else -> ModelWalk.maxLength(f)?.let { """{"type": "string", "maxLength": $it}""" } ?: """{"type": "string"}"""
        }
        // ModelWalk.isArray, never f.isArray: that is the own flag and misses inheritance.
        return if (ModelWalk.isArray(f)) """{"type": "array", "items": $value}""" else value
    }
}
