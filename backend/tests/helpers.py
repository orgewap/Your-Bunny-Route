"""Test-only account provisioning; no default credentials are shipped."""
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

from backend.collaboration import create_user

TEST_PASSWORD = 'TestAccountPassword!1905'


def login_admin(client, data_dir: Path, name='testadmin'):
    conn = sqlite3.connect(data_dir / 'projects.sqlite3')
    try:
        create_user(conn, str(uuid.uuid4()), name, TEST_PASSWORD, 'admin',
                    datetime.now(timezone.utc).isoformat())
        conn.commit()
    finally:
        conn.close()
    result = client.post('/api/auth/login', json={'username': name, 'password': TEST_PASSWORD})
    assert result.status_code == 200, result.text
    return result.json()
