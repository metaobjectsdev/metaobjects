import "@typespec/http";
import "@typespec/openapi3";

using TypeSpec.Http;

@service(#{ title: "Customer API" })
namespace CustomerApi;

enum Plan {
  free,
  pro,
}

model Customer {
  id: int64;

  @maxLength(320)
  email: string;

  @maxLength(200)
  name?: string;

  plan: Plan;
  createdAt: utcDateTime;
}

model CreateCustomer {
  @minLength(1)
  @maxLength(320)
  email: string;

  @maxLength(200)
  name?: string;

  plan?: Plan = Plan.free;
}

// The payload the LLM worker fills the welcome prompt with.
model WelcomePayload is PickProperties<Customer, "name" | "email" | "plan">;

@route("/customers")
interface Customers {
  @get list(@query email?: string): Customer[];
  @get read(@path id: int64): Customer | NotFoundResponse;
  @post create(@body body: CreateCustomer): {
    @statusCode _: 201;
    @body body: Customer;
  };
}
