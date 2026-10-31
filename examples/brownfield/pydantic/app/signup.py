from app.models import Customer, CustomerCreate


def welcome(customer: Customer) -> str:
    return f"Welcome, {customer.display_name}"


def parse_signup(body: dict[str, object]) -> CustomerCreate:
    return CustomerCreate.model_validate(body)
