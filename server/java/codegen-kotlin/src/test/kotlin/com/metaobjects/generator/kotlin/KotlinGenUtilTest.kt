package com.metaobjects.generator.kotlin

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Unit tests for [KotlinGenUtil] helpers. Currently covers [KotlinGenUtil.camelToSnake]
 * — the column-name normaliser used by [KotlinExposedTableGenerator] so generated
 * Exposed columns match the snake_case convention nearly every Postgres schema uses.
 */
class KotlinGenUtilTest {

    @Test fun `single lowercase word is unchanged`() {
        assertEquals("id", KotlinGenUtil.camelToSnake("id"))
        assertEquals("name", KotlinGenUtil.camelToSnake("name"))
    }

    @Test fun `camelCase splits at lower-to-upper boundary`() {
        assertEquals("display_name", KotlinGenUtil.camelToSnake("displayName"))
        assertEquals("html_content", KotlinGenUtil.camelToSnake("htmlContent"))
        assertEquals("user_id", KotlinGenUtil.camelToSnake("userId"))
        assertEquals("created_at", KotlinGenUtil.camelToSnake("createdAt"))
        assertEquals("updated_at", KotlinGenUtil.camelToSnake("updatedAt"))
    }

    @Test fun `multi-camel sequences split at every boundary`() {
        assertEquals("first_name_last_name", KotlinGenUtil.camelToSnake("firstNameLastName"))
        assertEquals("the_quick_brown_fox", KotlinGenUtil.camelToSnake("theQuickBrownFox"))
    }

    @Test fun `leading acronym becomes single lowercase token`() {
        // URLPath → url_path (NOT u_r_l_path) — acronym treated as one word
        assertEquals("url_path", KotlinGenUtil.camelToSnake("URLPath"))
        assertEquals("html_parser", KotlinGenUtil.camelToSnake("HTMLParser"))
    }

    @Test fun `trailing or embedded acronyms stay together`() {
        assertEquals("api_url", KotlinGenUtil.camelToSnake("apiURL"))
        assertEquals("parse_html", KotlinGenUtil.camelToSnake("parseHTML"))
    }

    @Test fun `digits stay attached to preceding token`() {
        assertEquals("foo123_bar", KotlinGenUtil.camelToSnake("foo123Bar"))
    }

    @Test fun `empty string is preserved`() {
        assertEquals("", KotlinGenUtil.camelToSnake(""))
    }

    @Test fun `already snake-case input is preserved`() {
        // No camel boundaries → no underscores inserted; only lowercased pass-through.
        assertEquals("already_snake", KotlinGenUtil.camelToSnake("already_snake"))
    }
}
