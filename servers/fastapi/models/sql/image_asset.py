from datetime import datetime
from typing import Optional
import uuid

from sqlalchemy import JSON, Column, DateTime, String
from sqlmodel import Field, SQLModel

from utils.datetime_utils import get_current_utc_datetime


class ImageAsset(SQLModel, table=True):
    # Use String(36) to store UUID in standard format with hyphens
    id: str = Field(sa_column=Column(String(36), primary_key=True), default_factory=lambda: str(uuid.uuid4()))
    created_at: datetime = Field(
        sa_column=Column(
            DateTime(timezone=True), nullable=False, default=get_current_utc_datetime
        ),
    )
    is_uploaded: bool = Field(default=False)
    path: str
    extras: Optional[dict] = Field(sa_column=Column(JSON), default=None)
