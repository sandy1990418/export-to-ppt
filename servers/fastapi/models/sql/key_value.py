import uuid
from sqlalchemy import String
from sqlmodel import Field, Column, JSON, SQLModel


class KeyValueSqlModel(SQLModel, table=True):
    # Use String(36) to store UUID in standard format with hyphens
    id: str = Field(sa_column=Column(String(36), primary_key=True), default_factory=lambda: str(uuid.uuid4()))
    key: str = Field(index=True)
    value: dict = Field(sa_column=Column(JSON))
