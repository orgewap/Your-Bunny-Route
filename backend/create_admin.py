"""Run: python -m backend.create_admin (interactive, no default password)."""
from __future__ import annotations

import getpass
import sqlite3
import uuid
from datetime import datetime, timezone
from .collaboration import create_user, init_security
from .main import DEFAULT_DATA


def main() -> None:
    DEFAULT_DATA.mkdir(parents=True, exist_ok=True)
    login = input("Логин администратора: ").strip()
    password = getpass.getpass("Пароль (не менее 12 символов): ")
    again = getpass.getpass("Повторите пароль: ")
    if password != again:
        raise SystemExit("Пароли не совпадают.")
    conn = sqlite3.connect(DEFAULT_DATA / "projects.sqlite3")
    try:
        init_security(conn)
        if conn.execute("SELECT 1 FROM users WHERE role='admin'").fetchone():
            raise SystemExit("Администратор уже существует. Добавляйте участников через интерфейс.")
        record = create_user(conn, str(uuid.uuid4()), login, password, "admin",
                             datetime.now(timezone.utc).isoformat(timespec="seconds"))
        conn.commit()
        print(f"Администратор {record['username']} создан. Пароль сохранён только в виде хеша.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
