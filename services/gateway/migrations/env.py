"""Alembic runs this to apply database migrations (`alembic upgrade head`).

In the cluster it runs in an init container before the gateway starts. With
several gateway replicas starting at once, a Postgres advisory lock makes
sure only one of them migrates at a time; the others wait, then find
nothing left to do.
"""

import asyncio

from alembic import context
from sqlalchemy import text

from app.db import Base, engine

MIGRATION_LOCK_ID = 7_310_001  # any fixed number, shared by all replicas


def run_migrations(connection):
    context.configure(connection=connection, target_metadata=Base.metadata, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


async def main():
    async with engine.connect() as connection:
        await connection.execute(text("SELECT pg_advisory_lock(:id)"), {"id": MIGRATION_LOCK_ID})
        try:
            await connection.run_sync(run_migrations)
            await connection.commit()
        finally:
            await connection.execute(text("SELECT pg_advisory_unlock(:id)"), {"id": MIGRATION_LOCK_ID})
    await engine.dispose()


asyncio.run(main())
