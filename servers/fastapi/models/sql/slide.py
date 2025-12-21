from typing import Optional
import uuid
from sqlalchemy import ForeignKey, String
from sqlmodel import Field, Column, JSON, SQLModel


class SlideModel(SQLModel, table=True):
    __tablename__ = "slides"

    # Use String(36) to store UUID in standard format with hyphens
    id: str = Field(sa_column=Column(String(36), primary_key=True), default_factory=lambda: str(uuid.uuid4()))
    presentation: str = Field(
        sa_column=Column(String(36), ForeignKey("presentations.id", ondelete="CASCADE"), index=True)
    )
    layout_group: str
    layout: str
    index: int
    content: dict = Field(sa_column=Column(JSON))
    html_content: Optional[str]
    speaker_note: Optional[str] = None
    properties: Optional[dict] = Field(sa_column=Column(JSON))

    def get_new_slide(self, presentation: str, content: Optional[dict] = None):
        return SlideModel(
            id=str(uuid.uuid4()),
            presentation=presentation,
            layout_group=self.layout_group,
            layout=self.layout,
            index=self.index,
            speaker_note=self.speaker_note,
            content=content or self.content,
            properties=self.properties,
        )
