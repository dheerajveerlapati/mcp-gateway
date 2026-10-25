"""user server access

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-25 18:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = '0005'
down_revision = '0004'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Existing users keep every server.
    op.add_column('users', sa.Column('all_servers', sa.Boolean(), server_default=sa.true(), nullable=False))
    op.create_table('user_server_access',
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('server_id', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['server_id'], ['servers.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('user_id', 'server_id')
    )


def downgrade() -> None:
    op.drop_table('user_server_access')
    op.drop_column('users', 'all_servers')
