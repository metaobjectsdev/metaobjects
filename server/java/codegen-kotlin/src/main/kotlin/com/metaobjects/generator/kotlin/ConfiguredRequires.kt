package com.metaobjects.generator.kotlin

/**
 * A generator whose `requires` depends on how it is configured.
 *
 * [GeneratorInfo.requires] is the static answer, the one `--list` prints: what the generator
 * needs with its default args. A generator that needs less under other args (spring-config emits
 * no reference to the generated validator when `validatorEnabled` is `false`) implements this, and
 * `mvn metaobjects:generate` asks the instance it is about to run, after its args are set, so a
 * pom that never needed the companion is not refused for lacking it.
 */
interface ConfiguredRequires {
    /** The stable names this instance's output references, given its configured args. */
    fun configuredRequires(): List<String>
}
