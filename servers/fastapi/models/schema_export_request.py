from typing import List, Literal, Optional, Union
from pydantic import BaseModel, Field

from models.pptx_models import PptxStructureModel


class BulletItem(BaseModel):
    """A bullet item with text and optional structure info."""

    text: str = Field(..., description="Text content of the bullet item")
    structure: Optional[PptxStructureModel] = Field(
        None, description="Structure info for nested lists"
    )


class BulletPointContent(BaseModel):
    """A bullet point with title and description items."""

    title: str = Field(default="", description="Title of the bullet point")
    description: List[Union[str, BulletItem]] = Field(
        default_factory=list, description="List of sub-points (string or BulletItem)"
    )


class SchemaSlideInput(BaseModel):
    """Input for a single slide with text and optional tables."""
    mainTitle: Optional[str] = Field(None, description="Main title of the slide")
    bulletPoint: Optional[BulletPointContent] = Field(None, description="Bullet point with title and sub-points")
    table: Optional[str] = Field(None, description="Single markdown table (backward compatible)")
    tables: Optional[List[str]] = Field(None, description="Multiple markdown tables (1=full width, 2=side by side, 3+=stacked)")


class SchemaExportRequest(BaseModel):
    """Request to export a presentation from schema with text and tables."""
    title: str = Field(..., description="Presentation title")
    slides: List[SchemaSlideInput] = Field(..., min_length=1, description="List of slides")
    export_as: Literal["pptx", "pdf"] = Field(default="pptx", description="Export format")
