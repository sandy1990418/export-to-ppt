from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field


class DirectSlideInput(BaseModel):
    """Input for a single slide with pre-generated content"""
    layout: str = Field(..., description="Layout ID (e.g., 'simple-bullet-points-layout')")
    data: Dict[str, Any] = Field(..., description="Slide data matching the layout schema")
    speaker_note: Optional[str] = Field(None, description="Speaker notes for this slide")


class DirectPresentationRequest(BaseModel):
    """Request to create a presentation directly from pre-generated schema data"""
    template: str = Field(..., description="Template ID (e.g., 'swift', 'general')")
    title: str = Field(..., description="Presentation title")
    slides: List[DirectSlideInput] = Field(..., min_length=1, description="List of slides with their data")
    language: str = Field(default="en", description="Language code")
    export_as: Optional[Literal["pptx", "pdf"]] = Field(
        default=None,
        description="Export format. If provided, will automatically export after creation"
    )
