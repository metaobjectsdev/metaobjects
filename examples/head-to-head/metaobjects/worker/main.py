import os
import sys

import psycopg

from worker.generated.WelcomePayload import WelcomePayload
from worker.prompts import render_welcome


def load_payload(conn: psycopg.Connection, customer_id: int) -> WelcomePayload:
    row = conn.execute(
        "SELECT name, email, plan FROM customers WHERE id = %s", (customer_id,)
    ).fetchone()
    if row is None:
        raise LookupError(f"no customer {customer_id}")
    name, email, plan = row
    return WelcomePayload(name=name, email=email, plan=plan)


def main() -> None:
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        # A real worker would send this prompt to an LLM; the demo prints it.
        print(render_welcome(load_payload(conn, int(sys.argv[1]))))


if __name__ == "__main__":
    main()
