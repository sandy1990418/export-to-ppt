from typing import List
from pptx.enum.text import PP_ALIGN

from models.schema_export_request import SchemaExportRequest, SchemaSlideInput
from models.pptx_models import (
    PptxFillModel,
    PptxFontModel,
    PptxParagraphModel,
    PptxPositionModel,
    PptxPresentationModel,
    PptxSlideModel,
    PptxSpacingModel,
    PptxTableCellModel,
    PptxTableModel,
    PptxTextBoxModel,
)
from utils.markdown_table_parser import parse_markdown_table


# Slide dimensions (matching PptxPresentationCreator defaults)
SLIDE_WIDTH = 1280
SLIDE_HEIGHT = 720

# Layout constants
MARGIN_LEFT = 60
MARGIN_RIGHT = 60
CONTENT_WIDTH = SLIDE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT

# Title styling
TITLE_TOP = 50
TITLE_FONT_SIZE = 36
TITLE_COLOR = "333333"

# Bullet point styling
BULLET_TITLE_TOP = 120
BULLET_TITLE_FONT_SIZE = 24
BULLET_TITLE_COLOR = "444444"

BULLET_ITEM_TOP = 170
BULLET_ITEM_FONT_SIZE = 18
BULLET_ITEM_COLOR = "555555"
BULLET_ITEM_SPACING = 30

# Table styling
TABLE_MARGIN_TOP = 40
TABLE_ROW_HEIGHT = 35
TABLE_HEADER_FILL = "4472C4"
TABLE_HEADER_FONT_COLOR = "FFFFFF"
TABLE_CELL_FONT_COLOR = "333333"


class SchemaToPptxConverter:
    """
    Convert a SchemaExportRequest to a PptxPresentationModel.

    Creates slides with:
    - Main title at top
    - Bullet points below title
    - Table at bottom (if provided)
    """

    def convert(self, request: SchemaExportRequest) -> PptxPresentationModel:
        """
        Convert the schema export request to a full PPTX presentation model.

        Args:
            request: The schema export request with slides data.

        Returns:
            A PptxPresentationModel ready for rendering.
        """
        slides = []
        for slide_input in request.slides:
            slide_model = self._convert_slide(slide_input)
            slides.append(slide_model)

        return PptxPresentationModel(
            name=request.title,
            slides=slides,
        )

    def _convert_slide(self, slide_input: SchemaSlideInput) -> PptxSlideModel:
        """Convert a single slide input to a PptxSlideModel."""
        shapes = []
        current_top = TITLE_TOP

        # Add main title if present
        if slide_input.mainTitle:
            title_shape = self._create_title_textbox(slide_input.mainTitle, current_top)
            shapes.append(title_shape)
            current_top = BULLET_TITLE_TOP

        # Add bullet point if present
        if slide_input.bulletPoint:
            # Add bullet title
            if slide_input.bulletPoint.title:
                bullet_title_shape = self._create_bullet_title_textbox(
                    slide_input.bulletPoint.title, current_top
                )
                shapes.append(bullet_title_shape)
                current_top = BULLET_ITEM_TOP

            # Add bullet items
            for item in slide_input.bulletPoint.description:
                item_shape = self._create_bullet_item_textbox(item, current_top)
                shapes.append(item_shape)
                current_top += BULLET_ITEM_SPACING

        # Add table if present
        if slide_input.table:
            table_shape = self._create_table(slide_input.table, current_top + TABLE_MARGIN_TOP)
            if table_shape:
                shapes.append(table_shape)

        return PptxSlideModel(shapes=shapes)

    def _create_title_textbox(self, text: str, top: int) -> PptxTextBoxModel:
        """Create a title textbox."""
        return PptxTextBoxModel(
            position=PptxPositionModel(
                left=MARGIN_LEFT,
                top=top,
                width=CONTENT_WIDTH,
                height=50,
            ),
            paragraphs=[
                PptxParagraphModel(
                    text=text,
                    alignment=PP_ALIGN.CENTER,
                    font=PptxFontModel(
                        name="Inter",
                        size=TITLE_FONT_SIZE,
                        color=TITLE_COLOR,
                        font_weight=700,
                    ),
                )
            ],
        )

    def _create_bullet_title_textbox(self, text: str, top: int) -> PptxTextBoxModel:
        """Create a bullet point title textbox."""
        return PptxTextBoxModel(
            position=PptxPositionModel(
                left=MARGIN_LEFT,
                top=top,
                width=CONTENT_WIDTH,
                height=40,
            ),
            paragraphs=[
                PptxParagraphModel(
                    text=text,
                    alignment=PP_ALIGN.LEFT,
                    font=PptxFontModel(
                        name="Inter",
                        size=BULLET_TITLE_FONT_SIZE,
                        color=BULLET_TITLE_COLOR,
                        font_weight=600,
                    ),
                )
            ],
        )

    def _create_bullet_item_textbox(self, text: str, top: int) -> PptxTextBoxModel:
        """Create a bullet item textbox."""
        return PptxTextBoxModel(
            position=PptxPositionModel(
                left=MARGIN_LEFT + 20,  # Indent for bullet items
                top=top,
                width=CONTENT_WIDTH - 20,
                height=30,
            ),
            paragraphs=[
                PptxParagraphModel(
                    text=f"• {text}",
                    alignment=PP_ALIGN.LEFT,
                    font=PptxFontModel(
                        name="Inter",
                        size=BULLET_ITEM_FONT_SIZE,
                        color=BULLET_ITEM_COLOR,
                        font_weight=400,
                    ),
                )
            ],
        )

    def _create_table(self, markdown_table: str, top: int) -> PptxTableModel | None:
        """Create a table from markdown table string."""
        parsed_rows = parse_markdown_table(markdown_table)
        if not parsed_rows:
            return None

        num_cols = len(parsed_rows[0])
        num_rows = len(parsed_rows)

        # Calculate table dimensions
        table_width = CONTENT_WIDTH
        table_height = num_rows * TABLE_ROW_HEIGHT

        # Convert parsed rows to PptxTableCellModel
        rows: List[List[PptxTableCellModel]] = []
        for row in parsed_rows:
            cells = [PptxTableCellModel(text=cell) for cell in row]
            # Pad row if it has fewer cells than expected
            while len(cells) < num_cols:
                cells.append(PptxTableCellModel(text=""))
            rows.append(cells)

        return PptxTableModel(
            position=PptxPositionModel(
                left=MARGIN_LEFT,
                top=top,
                width=table_width,
                height=table_height,
            ),
            rows=rows,
            header_row=True,
            font=PptxFontModel(
                name="Inter",
                size=12,
                color=TABLE_CELL_FONT_COLOR,
            ),
            header_font=PptxFontModel(
                name="Inter",
                size=12,
                color=TABLE_HEADER_FONT_COLOR,
                font_weight=700,
            ),
            header_fill=PptxFillModel(color=TABLE_HEADER_FILL),
        )
