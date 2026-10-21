"""Session fixtures for the integration lanes."""
from __future__ import annotations

from collections.abc import Iterator

import pytest

from .mysql_container import MySqlContainer, MySqlInfo, reset_database


@pytest.fixture(scope="session")
def mysql_server() -> Iterator[MySqlInfo]:
    """ONE MySQL 8.4 server for the whole session, started on first use. Callers get an
    EMPTY database each (:func:`mysql_empty`), so sharing the server shares no state."""
    with MySqlContainer() as server:
        yield server.info()


@pytest.fixture
def mysql_empty(mysql_server: MySqlInfo) -> MySqlInfo:
    reset_database(mysql_server)
    return mysql_server
