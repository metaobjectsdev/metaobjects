// Phase 5 bug G6 — a path into a member of a FLATTENED value object (`address.city`): the
// member's column lives on the owning table under the embedding field's prefix. Ported from
// typescript/packages/metadata/src/core/field/flattened-member.ts.

using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Shared.BaseTypes;

namespace MetaObjects.Meta;

/// <summary>A flattened member path, resolved: the embedding field on the entity and the member on its value object.</summary>
public sealed record FlattenedMember(MetaData Embedding, MetaData Member);

public static class FlattenedMembers
{
    /// <summary>
    /// Resolve <c>&lt;field&gt;.&lt;member&gt;</c> against <paramref name="entity"/>: a <c>field.object</c> with
    /// <c>@storage: flattened</c>, and a field its value object declares. Null for anything else. One level.
    /// </summary>
    public static FlattenedMember? Resolve(MetaData entity, string path)
    {
        var dot = path.IndexOf('.');
        if (dot < 1 || dot == path.Length - 1 || path.IndexOf('.', dot + 1) >= 0) return null;
        var head = path[..dot];
        var tail = path[(dot + 1)..];
        var embedding = entity.Children().FirstOrDefault(c => c.Type == TYPE_FIELD && c.Name == head);
        if (embedding is null || embedding.SubType != FIELD_SUBTYPE_OBJECT) return null;
        // ADR-0039: resolving — @storage / @objectRef may be inherited via extends.
        if (embedding.Attr(FIELD_ATTR_STORAGE) as string != STORAGE_FLATTENED) return null;
        if (NamingRefs.RefTarget(embedding, FIELD_ATTR_OBJECT_REF) is not { } vo) return null;
        var member = vo.Children().FirstOrDefault(c => c.Type == TYPE_FIELD && c.Name == tail);
        return member is null ? null : new FlattenedMember(embedding, member);
    }
}
