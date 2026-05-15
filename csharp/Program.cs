using MetaObjects;

var baseEntity = new MetaObject("entity", "BaseEntity") { IsAbstract = true };
baseEntity.AddChild(new MetaField("long", "id"));

var subscriber = new MetaObject("entity", "Subscriber");
subscriber.AddChild(new MetaField("string", "email"));
subscriber.SuperData = baseEntity;

baseEntity.Freeze();
subscriber.Freeze();

var fieldNames = subscriber.Fields().Select(f => f.Name).ToList();
Assert(fieldNames.Contains("id"), "Fields() must include inherited 'id'");
Assert(fieldNames.Contains("email"), "Fields() must include own 'email'");
Assert(fieldNames.Count == 2, $"Fields() must have exactly 2 entries, got {fieldNames.Count}");

var ownNames = subscriber.OwnFields().Select(f => f.Name).ToList();
Assert(ownNames.Count == 1 && ownNames[0] == "email", "OwnFields() must be exactly ['email']");

Assert(ReferenceEquals(subscriber.Fields(), subscriber.Fields()),
    "Fields() must be cached — same reference on repeat call");

Console.WriteLine("C# MetaData spike: all assertions passed.");

static void Assert(bool condition, string message)
{
    if (!condition) throw new Exception("SPIKE ASSERTION FAILED: " + message);
}
