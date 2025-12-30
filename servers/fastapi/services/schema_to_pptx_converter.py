from typing import List, Union
from pptx.enum.text import PP_ALIGN

from models.schema_export_request import BulletItem, SchemaExportRequest, SchemaSlideInput
from models.pptx_models import (
    PptxFillModel,
    PptxFontModel,
    PptxParagraphModel,
    PptxPositionModel,
    PptxPresentationModel,
    PptxSlideModel,
    PptxSpacingModel,
    PptxStructureModel,
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
BULLET_LEVEL_INDENT = 20  # Additional indent per nesting level

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
            # Add bullet title with structure (level=1, isList=False)
            if slide_input.bulletPoint.title:
                bullet_title_item = BulletItem(
                    text=slide_input.bulletPoint.title,
                    structure=PptxStructureModel(level=1, isList=False),
                )
                bullet_title_shape = self._create_bullet_item_textbox(
                    bullet_title_item, current_top
                )
                shapes.append(bullet_title_shape)
                current_top += BULLET_ITEM_SPACING

            # Add bullet items
            base_level = 2  # Description items start at level 2
            for item in slide_input.bulletPoint.description:
                # If item is a string, convert to BulletItem with level=2
                if isinstance(item, str):
                    bullet_item = BulletItem(
                        text=item,
                        structure=PptxStructureModel(level=base_level, isList=True),
                    )
                elif item.structure is None:
                    # If BulletItem has no structure, default to level=2
                    bullet_item = BulletItem(
                        text=item.text,
                        structure=PptxStructureModel(level=base_level, isList=True),
                    )
                else:
                    # Adjust level: add base_level to existing structure level
                    adjusted_level = base_level + item.structure.level
                    bullet_item = BulletItem(
                        text=item.text,
                        structure=PptxStructureModel(
                            level=adjusted_level, isList=item.structure.isList
                        ),
                    )
                item_shape = self._create_bullet_item_textbox(bullet_item, current_top)
                shapes.append(item_shape)
                current_top += BULLET_ITEM_SPACING

        # Collect all tables (support both 'table' and 'tables')
        all_tables: List[str] = []
        if slide_input.tables:
            all_tables.extend(slide_input.tables)
        elif slide_input.table:
            all_tables.append(slide_input.table)

        # Add tables with automatic layout
        if all_tables:
            table_shapes = self._create_tables_with_layout(
                all_tables, current_top + TABLE_MARGIN_TOP
            )
            shapes.extend(table_shapes)

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

    def _create_bullet_item_textbox(
        self, item: Union[str, BulletItem], top: int
    ) -> PptxTextBoxModel:
        """Create a bullet item textbox with optional structure-based indentation."""
        # Extract text and structure from item
        if isinstance(item, str):
            text = item
            structure = None
        else:
            text = item.text
            structure = item.structure

        # Calculate indentation based on structure level
        level = structure.level if structure else 0
        base_indent = 20
        level_indent = level * BULLET_LEVEL_INDENT
        total_indent = base_indent + level_indent

        # Determine bullet prefix based on isList
        is_list = structure.isList if structure else True
        if is_list:
            # Use different bullet symbols for different levels
            bullet_symbols = ["•", "◦", "▪", "▫"]
            bullet = bullet_symbols[min(level, len(bullet_symbols) - 1)]
            display_text = f"{bullet} {text}"
        else:
            # No bullet for non-list items (like headings converted to bullets)
            display_text = text

        return PptxTextBoxModel(
            position=PptxPositionModel(
                left=MARGIN_LEFT + total_indent,
                top=top,
                width=CONTENT_WIDTH - total_indent,
                height=30,
            ),
            paragraphs=[
                PptxParagraphModel(
                    text=display_text,
                    alignment=PP_ALIGN.LEFT,
                    font=PptxFontModel(
                        name="Inter",
                        size=BULLET_ITEM_FONT_SIZE,
                        color=BULLET_ITEM_COLOR,
                        font_weight=400,
                    ),
                )
            ],
            structure=structure,
        )

    def _create_tables_with_layout(
        self, markdown_tables: List[str], top: int
    ) -> List[PptxTableModel]:
        """
        Create tables with automatic layout based on count.

        Layout rules:
        - 1 table: full width
        - 2 tables: side by side (two columns)
        - 3+ tables: stacked vertically
        """
        table_count = len(markdown_tables)

        if table_count == 0:
            return []

        if table_count == 1:
            # Single table: full width
            table = self._create_table(
                markdown_tables[0], top, MARGIN_LEFT, CONTENT_WIDTH
            )
            return [table] if table else []

        if table_count == 2:
            # Two tables: side by side
            gap = 20  # Gap between columns
            column_width = (CONTENT_WIDTH - gap) // 2
            tables = []

            # Left table
            left_table = self._create_table(
                markdown_tables[0], top, MARGIN_LEFT, column_width
            )
            if left_table:
                tables.append(left_table)

            # Right table
            right_table = self._create_table(
                markdown_tables[1], top, MARGIN_LEFT + column_width + gap, column_width
            )
            if right_table:
                tables.append(right_table)

            return tables

        # 3+ tables: stacked vertically
        tables = []
        current_top = top
        for markdown_table in markdown_tables:
            table = self._create_table(
                markdown_table, current_top, MARGIN_LEFT, CONTENT_WIDTH
            )
            if table:
                tables.append(table)
                # Calculate next position based on table height
                parsed_rows = parse_markdown_table(markdown_table)
                table_height = len(parsed_rows) * TABLE_ROW_HEIGHT if parsed_rows else 0
                current_top += table_height + 20  # 20px gap between tables

        return tables

    def _create_table(
        self, markdown_table: str, top: int, left: int, width: int
    ) -> PptxTableModel | None:
        """Create a table from markdown table string with specified position."""
        parsed_rows = parse_markdown_table(markdown_table)
        if not parsed_rows:
            return None

        num_cols = len(parsed_rows[0])
        num_rows = len(parsed_rows)

        # Calculate table height
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
                left=left,
                top=top,
                width=width,
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
