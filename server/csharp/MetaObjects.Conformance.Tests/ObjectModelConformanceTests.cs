// ObjectModelConformanceTests — the C# runtime object-model conformance runner.
//
// Loads the shared corpus fixtures/object-model-conformance/meta.json and runs
// the 7 behavioral scenarios that every port's runtime object model must satisfy
// (instantiate-value, scalar, nested, array-of-objects, overflow, bound-type,
// no-binding-fallback). Mirrors the Java / TS / Python runners.
//
// The contract is behavioral (type-kind, back-ref identity, field values, list
// contents, overflow) — not byte-identity.

using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class ObjectModelConformanceTests
{
    // FQNs as authored in meta.json (@objectRef + each object's resolution key).
    private const string PersonFqn = "com::example::om::Person";
    private const string AddressFqn = "com::example::om::Address";
    private const string TagFqn = "com::example::om::Tag";

    // -------------------------------------------------------------------------
    // Corpus resolution — sibling of fixtures/conformance/ (CorpusRoot.Path).
    // -------------------------------------------------------------------------

    private static string ObjectModelCorpusDir { get; } =
        System.IO.Path.GetFullPath(
            System.IO.Path.Combine(CorpusRoot.Path, "..", "object-model-conformance"));

    private static MetaRoot LoadRoot()
    {
        var result = MetaDataLoader.FromDirectory(ObjectModelCorpusDir);
        Assert.Empty(result.Errors);
        return result.Root;
    }

    private static MetaObject Object(MetaRoot root, string name)
    {
        var mo = root.Children()
            .OfType<MetaObject>()
            .FirstOrDefault(o => o.Name == name);
        Assert.NotNull(mo);
        return mo!;
    }

    // -------------------------------------------------------------------------
    // Scenario 1 — instantiate-value
    // -------------------------------------------------------------------------

    [Fact]
    public void Scenario1_InstantiateValue_ReturnsValueObjectWithBackRef()
    {
        var root = LoadRoot();
        var person = Object(root, "Person");

        var instance = person.NewInstance(new ObjectClassRegistry());

        var vo = Assert.IsType<ValueObject>(instance);
        Assert.Same(person, vo.GetMetaData());
    }

    // -------------------------------------------------------------------------
    // Scenario 2 — scalar-round-trip
    // -------------------------------------------------------------------------

    [Fact]
    public void Scenario2_ScalarRoundTrip()
    {
        var root = LoadRoot();
        var person = Object(root, "Person");
        var instance = person.NewInstance(new ObjectClassRegistry());

        person.GetField("name")!.SetValue(instance, "Ada");
        person.GetField("age")!.SetValue(instance, 36);

        Assert.Equal("Ada", person.GetField("name")!.GetValue(instance));
        Assert.Equal(36, person.GetField("age")!.GetValue(instance));
    }

    // -------------------------------------------------------------------------
    // Scenario 3 — nested-object
    // -------------------------------------------------------------------------

    [Fact]
    public void Scenario3_NestedObject()
    {
        var root = LoadRoot();
        var person = Object(root, "Person");
        var address = Object(root, "Address");
        var registry = new ObjectClassRegistry();

        var personInst = person.NewInstance(registry);

        var addressInst = address.NewInstance(registry);
        address.GetField("street")!.SetValue(addressInst, "1 Main");
        address.GetField("city")!.SetValue(addressInst, "Anytown");

        person.GetField("home")!.SetValue(personInst, addressInst);

        var gotHome = person.GetField("home")!.GetValue(personInst);
        var gotAddress = Assert.IsType<ValueObject>(gotHome);
        Assert.Equal("1 Main", address.GetField("street")!.GetValue(gotAddress));
        Assert.Equal("Anytown", address.GetField("city")!.GetValue(gotAddress));
        Assert.Same(address, gotAddress.GetMetaData());
    }

    // -------------------------------------------------------------------------
    // Scenario 4 — array-of-objects
    // -------------------------------------------------------------------------

    [Fact]
    public void Scenario4_ArrayOfObjects()
    {
        var root = LoadRoot();
        var person = Object(root, "Person");
        var tag = Object(root, "Tag");
        var registry = new ObjectClassRegistry();

        var personInst = person.NewInstance(registry);

        var tagA = tag.NewInstance(registry);
        tag.GetField("label")!.SetValue(tagA, "a");
        var tagB = tag.NewInstance(registry);
        tag.GetField("label")!.SetValue(tagB, "b");

        var tagsField = person.GetField("tags")!;
        Assert.True(tagsField.IsArray);
        tagsField.SetValue(personInst, new List<object> { tagA, tagB });

        var gotTags = tagsField.GetValue(personInst);
        var list = Assert.IsType<List<object>>(gotTags);
        Assert.Equal(2, list.Count);

        var first = Assert.IsType<ValueObject>(list[0]);
        var second = Assert.IsType<ValueObject>(list[1]);
        Assert.Equal("a", tag.GetField("label")!.GetValue(first));
        Assert.Equal("b", tag.GetField("label")!.GetValue(second));
        Assert.Same(tag, first.GetMetaData());
        Assert.Same(tag, second.GetMetaData());
    }

    // -------------------------------------------------------------------------
    // Scenario 5 — overflow
    // -------------------------------------------------------------------------

    [Fact]
    public void Scenario5_Overflow()
    {
        var root = LoadRoot();
        var person = Object(root, "Person");
        var instance = (ValueObject)person.NewInstance(new ObjectClassRegistry());

        // "nickname" is not a declared field — overflow key.
        Assert.Null(person.FindField("nickname"));
        instance.Set("nickname", "Countess");

        Assert.Equal("Countess", instance.Get("nickname"));
    }

    // -------------------------------------------------------------------------
    // Scenario 6 — bound-type (registered native type, AOT-safe factory delegate)
    // -------------------------------------------------------------------------

    [Fact]
    public void Scenario6_BoundType()
    {
        var root = LoadRoot();
        var person = Object(root, "Person");
        var address = Object(root, "Address");
        var tag = Object(root, "Tag");

        // Fresh, scoped registry so the binding does not leak into other scenarios.
        var registry = new ObjectClassRegistry();
        registry.Register(PersonFqn, mo => new PersonObj());

        var instance = person.NewInstance(registry);

        var personObj = Assert.IsType<PersonObj>(instance);
        Assert.Same(person, personObj.GetMetaData());

        // scalar — identical behavior to a ValueObject via the field SPI.
        person.GetField("name")!.SetValue(personObj, "Ada");
        person.GetField("age")!.SetValue(personObj, 36);
        Assert.Equal("Ada", person.GetField("name")!.GetValue(personObj));
        Assert.Equal(36, person.GetField("age")!.GetValue(personObj));

        // nested — store an Address-backed object.
        var addressInst = (ValueObject)address.NewInstance(registry);
        address.GetField("street")!.SetValue(addressInst, "1 Main");
        person.GetField("home")!.SetValue(personObj, addressInst);
        var gotHome = Assert.IsType<ValueObject>(person.GetField("home")!.GetValue(personObj));
        Assert.Equal("1 Main", address.GetField("street")!.GetValue(gotHome));

        // array — store a list of Tag-backed objects.
        var tagA = (ValueObject)tag.NewInstance(registry);
        tag.GetField("label")!.SetValue(tagA, "a");
        person.GetField("tags")!.SetValue(personObj, new List<object> { tagA });
        var gotTags = Assert.IsType<List<object>>(person.GetField("tags")!.GetValue(personObj));
        Assert.Single(gotTags);
        Assert.Equal("a", tag.GetField("label")!.GetValue(Assert.IsType<ValueObject>(gotTags[0])));
    }

    // -------------------------------------------------------------------------
    // Scenario 7 — no-binding-fallback
    // -------------------------------------------------------------------------

    [Fact]
    public void Scenario7_NoBindingFallback()
    {
        var root = LoadRoot();
        var address = Object(root, "Address");

        // Nothing registered for Address → ValueObject.
        var registry = new ObjectClassRegistry();
        var instance = address.NewInstance(registry);

        var vo = Assert.IsType<ValueObject>(instance);
        Assert.Same(address, vo.GetMetaData());
    }

    // -------------------------------------------------------------------------
    // PersonObj — the bound test type (scenario 6).
    //
    // Implements IMetaObjectAware (carries the MetaObject back-reference) and
    // ITypedFieldAccessor (the AOT-safe, reflection-free field dispatch — a plain
    // switch over its own typed members; mirrors what generated code emits).
    // -------------------------------------------------------------------------

    private sealed class PersonObj : IMetaObjectAware, ITypedFieldAccessor
    {
        private MetaObject? _meta;

        public string? Name { get; set; }
        public int Age { get; set; }
        public object? Home { get; set; }
        public List<object>? Tags { get; set; }

        public MetaObject? GetMetaData() => _meta;
        public void SetMetaData(MetaObject mo) => _meta = mo;

        public object? GetFieldValue(string name) => name switch
        {
            "name" => Name,
            "age" => Age,
            "home" => Home,
            "tags" => Tags,
            _ => throw new ArgumentException($"PersonObj has no field '{name}'"),
        };

        public void SetFieldValue(string name, object? value)
        {
            switch (name)
            {
                case "name": Name = (string?)value; break;
                case "age": Age = (int)value!; break;
                case "home": Home = value; break;
                case "tags": Tags = (List<object>?)value; break;
                default: throw new ArgumentException($"PersonObj has no field '{name}'");
            }
        }
    }
}
