package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The generated shapes must be constructible FROM JAVA, not only from Kotlin (#365).
 *
 * Kotlin default arguments are a compiler feature, not a bytecode one, so a data class whose
 * properties are all defaulted offers Java the full N-arg constructor, a synthetic bitmask one
 * it cannot call, and a no-arg one yielding an all-null instance of an immutable class —
 * nothing in between. An adopter converting an untyped jsonb bag to an `object.value` found a
 * generated 14-member VO needed 14 arguments with 11 nulls where the hand-written class it
 * replaced had a Lombok builder.
 *
 * Every other test in this module is Kotlin-side, where named arguments hide the problem
 * completely. This one compiles real JAVA against the generated output, which is the only way
 * the guarantee stays honest.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinValueObjectJavaConstructionTest {

    private val fixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.value": { "name": "ItemEffect", "children": [
            { "field.string": { "name": "name" } },
            { "field.string": { "name": "targetAttribute" } },
            { "field.int":    { "name": "value" } },
            { "field.int":    { "name": "duration" } },
            { "field.string": { "name": "damageType" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `java can construct a generated value object setting only some properties`() {
        val outDir = Files.createTempDirectory("kgen-java-ctor-")
        try {
            val gen = KotlinEntityGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test", fixture))

            val generated = Files.walk(outDir).filter { it.isRegularFile() }.toList()
                .map { SourceFile.kotlin(it.fileName.toString(), it.readText()) }

            // Sets 2 of 5 properties. Without a builder this cannot be written at all: the
            // class is immutable, so there is no no-arg-then-set path, and the only other
            // constructor takes every argument.
            val caller = SourceFile.java(
                "Caller.java",
                """
                package acme.demo;

                public class Caller {
                    public static ItemEffect partial() {
                        return ItemEffect.builder()
                                .name("Restore HP")
                                .value(10)
                                .build();
                    }
                }
                """.trimIndent(),
            )

            val result = KotlinCompilation().apply {
                sources = generated + caller
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()

            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "Java could not construct the generated value object:\n${result.messages}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
