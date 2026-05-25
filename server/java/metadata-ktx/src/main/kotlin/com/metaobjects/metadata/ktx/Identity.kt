package com.metaobjects.metadata.ktx

import com.metaobjects.identity.MetaIdentity

/**
 * Typed nullable enum mapping for [MetaIdentity.getGeneration].
 *
 * Java exposes `@generation` as a raw String drawn from a closed set
 * ([MetaIdentity.GENERATION_INCREMENT], [MetaIdentity.GENERATION_UUID],
 * [MetaIdentity.GENERATION_ASSIGNED]). Kotlin gets a typed nullable enum
 * so the `when` is exhaustive and unknown/absent values surface as `null`.
 */
enum class IdentityGeneration { INCREMENT, UUID, ASSIGNED }

/** Typed view of [MetaIdentity.getGeneration]; null on absent or unrecognized value. */
val MetaIdentity.generationStrategy: IdentityGeneration?
    get() = when (generation?.lowercase()) {
        MetaIdentity.GENERATION_INCREMENT -> IdentityGeneration.INCREMENT
        MetaIdentity.GENERATION_UUID -> IdentityGeneration.UUID
        MetaIdentity.GENERATION_ASSIGNED -> IdentityGeneration.ASSIGNED
        else -> null
    }
