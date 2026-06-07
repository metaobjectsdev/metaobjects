using MetaObjects.Core.Field;
using MetaObjects.Meta;
using MetaObjects.Shared;
using MetaObjects.Template;

namespace MetaObjects.Loader;

/// <summary>
/// AI-trace pre-freeze pass: inject typed <c>voRequest</c>/<c>voResponse</c>
/// <c>field.object</c> jsonb columns onto entities that extend <c>LlmCallBase</c>
/// and carry a nested <c>template.prompt</c> with <c>@payloadRef</c>/<c>@responseRef</c>.
///
/// <para>Cross-port mirror of the TS reference (<c>derive-trace-fields.ts</c>),
/// the Java <c>LlmTraceFieldDeriver</c>, and the Python <c>derive_trace_fields</c>.
/// The injected fields carry <c>@objectRef</c> + <c>@storage="jsonb"</c> so the
/// EF Core entity generator emits them as owned <c>.ToJson()</c> columns — identical
/// to a hand-authored <c>field.object</c>. Idempotent: an own field of the same name
/// is left untouched.</para>
///
/// <para>Wired ONLY into the codegen / verify loader path (see
/// <c>MetaDataLoader.FromDirectory(..., preFreeze:)</c>) — NEVER into the
/// conformance loader, so the metamodel canonical-serializer corpus serializes
/// authored metadata unchanged. The C# loader freezes the tree post-load, so this
/// must run before freeze (the loader invokes it after extends-resolution and
/// before validation, so derived nodes are validated like authored ones).</para>
/// </summary>
public static class DeriveTraceFields
{
    /// <summary>Short name of the shipped abstract base every trace entity extends.</summary>
    public const string LlmCallBase = "LlmCallBase";
    /// <summary>Derived field name for the typed request payload VO.</summary>
    public const string VoRequest = "voRequest";
    /// <summary>Derived field name for the typed extracted-response VO.</summary>
    public const string VoResponse = "voResponse";

    /// <summary>The pre-freeze hook: pass as <c>MetaDataLoader.FromDirectory(..., preFreeze: DeriveTraceFields.Apply)</c>.</summary>
    public static void Apply(MetaData root)
    {
        foreach (MetaData obj in root.OwnChildren())
        {
            if (obj.Type != BaseTypes.TYPE_OBJECT)
            {
                continue;
            }
            if (!ExtendsBase(obj))
            {
                continue;
            }
            MetaData? prompt = OwnPrompt(obj);
            if (prompt is null)
            {
                continue;
            }
            if (prompt.OwnAttr(TemplateConstants.TEMPLATE_ATTR_PAYLOAD_REF) is string payloadRef && payloadRef.Length > 0)
            {
                Inject(obj, VoRequest, payloadRef);
            }
            if (prompt.OwnAttr(TemplateConstants.TEMPLATE_ATTR_RESPONSE_REF) is string responseRef && responseRef.Length > 0)
            {
                Inject(obj, VoResponse, responseRef);
            }
        }
    }

    /// <summary>Last <c>::</c> segment of a (possibly package-qualified) name.</summary>
    private static string Short(string name)
    {
        int idx = name.LastIndexOf("::", System.StringComparison.Ordinal);
        return idx >= 0 ? name[(idx + 2)..] : name;
    }

    /// <summary>Walk the resolved super chain for a node whose short name == LlmCallBase.</summary>
    private static bool ExtendsBase(MetaData obj)
    {
        for (MetaData? cur = obj.SuperData; cur is not null; cur = cur.SuperData)
        {
            if (Short(cur.Name) == LlmCallBase)
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>First OWN <c>template.prompt</c> child of <paramref name="obj"/>, or null.</summary>
    private static MetaData? OwnPrompt(MetaData obj)
    {
        foreach (MetaData c in obj.OwnChildren())
        {
            if (c.Type == BaseTypes.TYPE_TEMPLATE && c.SubType == TemplateConstants.TEMPLATE_SUBTYPE_PROMPT)
            {
                return c;
            }
        }
        return null;
    }

    /// <summary>Inject a <c>field.object</c> child with <c>@objectRef</c> + <c>@storage="jsonb"</c>,
    /// unless an own field of that name already exists (idempotent).</summary>
    private static void Inject(MetaData entity, string fieldName, string objectRef)
    {
        foreach (MetaData c in entity.OwnChildren())
        {
            if (c.Type == BaseTypes.TYPE_FIELD && Short(c.Name) == fieldName)
            {
                return;
            }
        }
        var field = new MetaField(new TypeId(BaseTypes.TYPE_FIELD, FieldConstants.FIELD_SUBTYPE_OBJECT), fieldName);
        field.SetAttr(FieldConstants.FIELD_ATTR_OBJECT_REF, objectRef);
        field.SetAttr(FieldConstants.FIELD_ATTR_STORAGE, FieldConstants.STORAGE_JSONB);
        entity.AddChild(field);
    }
}
