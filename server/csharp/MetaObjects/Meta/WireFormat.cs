// Wire format — ADR-0019 Amendment 2: one project setting for the OUTPUT form of a generated
// REST surface (`wire` in .metaobjects/config.json), read by every port's codegen. Input rules
// (W2, W3) never change with it. Carried on the loaded root, like PhysicalNaming (ADR-0058).

namespace MetaObjects.Meta;

/// <summary>How a <c>field.decimal</c> is written (<c>wire.decimals</c>).</summary>
public enum DecimalWireForm
{
    /// <summary>The default: what System.Text.Json writes for a <c>decimal</c>, a JSON number
    /// carrying the value's scale (<c>12.50</c>).</summary>
    Native,
    /// <summary>The canonical string of ADR-0019 Amendment 1, W1 (<c>"12.5"</c>), the form every
    /// port writes alike.</summary>
    String,
}

/// <summary>How a value object's null member is written (<c>wire.nullMembers</c>).</summary>
public enum NullMemberForm
{
    /// <summary>The default: what System.Text.Json writes, <c>null</c> with the key present.</summary>
    Native,
    /// <summary><c>null</c> with the key present (in C#, the same as <see cref="Native"/>).</summary>
    Emit,
    /// <summary>Left out (<c>[JsonIgnore(Condition = WhenWritingNull)]</c> on each nullable member).</summary>
    Omit,
}

/// <summary>
/// The project's wire-format setting: <c>wire</c> in <c>.metaobjects/config.json</c>
/// (ADR-0019 Amendment 2). Both keys default to native, each port's own language-standard output;
/// <c>{ "decimals": "string", "nullMembers": "omit" }</c> is the cross-port form.
/// </summary>
public sealed record WireFormat(DecimalWireForm Decimals, NullMemberForm NullMembers)
{
    /// <summary>Both keys native: what a tree loaded with no project carries.</summary>
    public static readonly WireFormat Default = new(DecimalWireForm.Native, NullMemberForm.Native);

    /// <summary>The setting the tree <paramref name="node"/> belongs to carries, else <see cref="Default"/>.</summary>
    public static WireFormat Of(MetaData node) =>
        node.Root() is MetaRoot root ? root.WireFormat : Default;

    /// <summary>The <c>wire.decimals</c> spelling of <paramref name="form"/>.</summary>
    public static string Spelling(DecimalWireForm form) => form == DecimalWireForm.String ? "string" : "native";

    /// <summary>The <c>wire.nullMembers</c> spelling of <paramref name="form"/>.</summary>
    public static string Spelling(NullMemberForm form) => form switch
    {
        NullMemberForm.Emit => "emit",
        NullMemberForm.Omit => "omit",
        _ => "native",
    };

    /// <summary>This setting as the <c>wire</c> block that declares it.</summary>
    public string Block() =>
        $"\"wire\": {{ \"decimals\": \"{Spelling(Decimals)}\", \"nullMembers\": \"{Spelling(NullMembers)}\" }}";
}
