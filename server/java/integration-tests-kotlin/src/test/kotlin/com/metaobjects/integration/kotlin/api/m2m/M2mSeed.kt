package com.metaobjects.integration.kotlin.api.m2m

import com.fasterxml.jackson.databind.ObjectMapper
import java.nio.file.Files
import java.nio.file.Path

/**
 * FR-018 — the shared M:N corpus `seed.json`, keyed by physical table name (six
 * tables: posts/tags/post_tags/people/follows/friendships). Kotlin mirror of the
 * Java `M2mSeed`.
 */
object M2mSeed {

    private val mapper = ObjectMapper()

    @Suppress("UNCHECKED_CAST")
    fun load(corpus: Path): Map<String, List<Map<String, Any?>>> {
        val text = Files.readString(corpus.resolve("seed.json"))
        return mapper.readValue(text, Map::class.java) as Map<String, List<Map<String, Any?>>>
    }

    fun rows(seed: Map<String, List<Map<String, Any?>>>, table: String): List<Map<String, Any?>> =
        seed[table] ?: emptyList()
}
