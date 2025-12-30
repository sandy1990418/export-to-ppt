from typing import List, Literal, Optional
from pydantic import BaseModel, Field


class ParsedBlock(BaseModel):
    """Parsed markdown block."""

    type: Literal["title", "bullet", "table", "paragraph", "thematic_break"]
    content: str = ""
    level: int = 0  # Heading level or list indentation level
    children: List["ParsedBlock"] = Field(default_factory=list)


class MarkdownExportRequest(BaseModel):
    """Request to export a presentation from markdown."""

    markdown: str = Field(..., description="Markdown content to convert")
    title: Optional[str] = Field(
        None, description="Optional title, otherwise extract from first # in markdown"
    )
    export_as: Literal["pptx", "pdf"] = Field(default="pptx", description="Export format")
