from typing import List, Optional
import mistune
from pydantic import BaseModel, Field

from models.markdown_models import ParsedBlock
from models.pptx_models import PptxStructureModel
from models.schema_export_request import (
    BulletItem,
    BulletPointContent,
    SchemaExportRequest,
    SchemaSlideInput,
)
from models.llm_message import LLMSystemMessage, LLMUserMessage
from services.llm_client import LLMClient
from utils.llm_provider import get_model


# Response schema for LLM slide grouping
class SlideGroupItem(BaseModel):
    """A single content item within a slide."""

    content: str = Field(..., description="The text content of this item")
    level: int = Field(
        default=0, description="Nesting level (0=top level, 1=nested, etc.)"
    )
    is_list: bool = Field(default=True, description="Whether this is a list item")


class SlideGroup(BaseModel):
    """A group of content that belongs to one slide."""

    title: str = Field(default="", description="The slide title (mainTitle)")
    items: List[SlideGroupItem] = Field(
        default_factory=list, description="Content items for this slide"
    )
    tables: List[str] = Field(
        default_factory=list, description="Markdown tables for this slide"
    )


class SlideGroupingResponse(BaseModel):
    """LLM response for how to group content into slides."""

    presentation_title: str = Field(..., description="The presentation title")
    slides: List[SlideGroup] = Field(
        ..., min_length=1, description="List of slides with grouped content"
    )


class MarkdownToSchemaConverter:
    """Convert markdown content to SchemaExportRequest for PPTX/PDF export."""

    MAX_BULLETS_PER_SLIDE = 8

    def __init__(self):
        # Use mistune's AST mode (renderer=None returns AST)
        self.markdown_parser = mistune.create_markdown(renderer=None)

    def convert(
        self, markdown: str, export_as: str = "pptx", title: Optional[str] = None
    ) -> SchemaExportRequest:
        """Convert markdown to SchemaExportRequest using rule-based splitting."""
        # 1. Parse markdown to AST
        ast = self.markdown_parser(markdown)

        # 2. Process AST to extract structured blocks
        blocks = self._process_ast(ast)

        # 3. Extract title from first heading if not provided
        extracted_title = title
        if not extracted_title and blocks:
            for block in blocks:
                if block.type == "title" and block.level == 1:
                    extracted_title = block.content
                    break

        if not extracted_title:
            extracted_title = "Untitled Presentation"

        # 4. Split blocks into slides using rules
        slides = self._split_into_slides(blocks)

        # 5. Build SchemaExportRequest
        return SchemaExportRequest(
            title=extracted_title,
            slides=slides,
            export_as=export_as,
        )

    async def convert_with_llm(
        self, markdown: str, export_as: str = "pptx", title: Optional[str] = None
    ) -> SchemaExportRequest:
        """Convert markdown to SchemaExportRequest using LLM-assisted splitting."""
        # 1. Parse markdown to AST
        ast = self.markdown_parser(markdown)

        # 2. Process AST to extract structured blocks
        blocks = self._process_ast(ast)

        # 3. Extract title from first heading if not provided
        extracted_title = title
        if not extracted_title and blocks:
            for block in blocks:
                if block.type == "title" and block.level == 1:
                    extracted_title = block.content
                    break

        # 4. Use LLM to decide how to group blocks into slides
        slide_grouping = await self._llm_split_into_slides(blocks, extracted_title)

        # 5. Use LLM response title if no title was provided
        if not extracted_title:
            extracted_title = slide_grouping.presentation_title or "Untitled Presentation"

        # 6. Convert LLM response to SchemaSlideInput list
        slides = self._build_slides_from_llm_response(slide_grouping)

        # 7. Build SchemaExportRequest
        return SchemaExportRequest(
            title=extracted_title,
            slides=slides,
            export_as=export_as,
        )

    async def _llm_split_into_slides(
        self, blocks: List[ParsedBlock], title: Optional[str]
    ) -> SlideGroupingResponse:
        """Use LLM to intelligently group blocks into slides."""
        # Prepare content description for LLM
        content_items = []
        for i, block in enumerate(blocks):
            if block.type == "title" and block.level == 1:
                content_items.append(f"[{i}] PRESENTATION_TITLE: {block.content}")
            elif block.type == "title":
                content_items.append(
                    f"[{i}] HEADING_L{block.level}: {block.content}"
                )
            elif block.type == "bullet":
                indent = "  " * block.level
                content_items.append(f"[{i}] BULLET (level={block.level}): {indent}{block.content}")
            elif block.type == "table":
                # Truncate long tables for LLM context
                table_preview = block.content[:200] + "..." if len(block.content) > 200 else block.content
                content_items.append(f"[{i}] TABLE:\n{table_preview}")
            elif block.type == "paragraph":
                content_items.append(f"[{i}] PARAGRAPH: {block.content}")
            elif block.type == "thematic_break":
                content_items.append(f"[{i}] --- (page break)")

        content_text = "\n".join(content_items)

        system_prompt = """You are an expert presentation designer. Your task is to organize markdown content into well-structured presentation slides.

Guidelines for slide organization:
1. Each slide should have a clear focus on ONE topic or idea
2. Keep 3-8 bullet points per slide (split if more content)
3. Group related content together
4. Use thematic breaks (---) as strong hints for slide boundaries
5. Level 2 headings (##) typically start new slides
6. Tables should stay with their related content
7. Preserve the hierarchical structure (nested bullets)
8. If content is too long for one slide, split it logically and add "(cont.)" to the title

Output the grouped content using the exact text from the input items.
Do NOT modify or rephrase the content - use it exactly as provided."""

        user_prompt = f"""Organize the following markdown content into presentation slides.

Content items:
{content_text}

{"Suggested presentation title: " + title if title else ""}

Group these items into slides. Each slide should have:
- A title (from headings or create a descriptive one)
- Content items (bullets, paragraphs)
- Any associated tables

Return your response as a JSON object with the slide groupings."""

        client = LLMClient()
        response = await client.generate_structured(
            model=get_model(),
            messages=[
                LLMSystemMessage(content=system_prompt),
                LLMUserMessage(content=user_prompt),
            ],
            response_format=SlideGroupingResponse.model_json_schema(),
            strict=False,
        )

        return SlideGroupingResponse(**response)

    def _build_slides_from_llm_response(
        self, grouping: SlideGroupingResponse
    ) -> List[SchemaSlideInput]:
        """Convert LLM slide grouping response to SchemaSlideInput list."""
        slides = []

        for slide_group in grouping.slides:
            # Build bullet items
            bullets = []
            for item in slide_group.items:
                bullets.append(
                    BulletItem(
                        text=item.content,
                        structure=PptxStructureModel(
                            level=item.level, isList=item.is_list
                        ),
                    )
                )

            # Build bullet point content
            bullet_point = None
            if bullets:
                bullet_point = BulletPointContent(
                    title="",
                    description=bullets,
                )

            # Build slide
            slide = SchemaSlideInput(
                mainTitle=slide_group.title if slide_group.title else None,
                bulletPoint=bullet_point,
                tables=slide_group.tables if slide_group.tables else None,
            )
            slides.append(slide)

        # Ensure at least one slide
        if not slides:
            slides.append(SchemaSlideInput(mainTitle="Empty Presentation"))

        return slides

    def _process_ast(self, ast: list) -> List[ParsedBlock]:
        """Process mistune AST and extract structured blocks."""
        blocks = []

        for node in ast:
            node_type = node.get("type", "")

            if node_type == "heading":
                # Extract heading text
                text = self._extract_text_with_links(node.get("children", []))
                level = node.get("attrs", {}).get("level", 1)
                blocks.append(ParsedBlock(type="title", content=text, level=level))

            elif node_type == "list":
                # Process list items with nesting
                list_blocks = self._process_list(node, level=0)
                blocks.extend(list_blocks)

            elif node_type == "table":
                # Convert table back to markdown format
                table_md = self._table_to_markdown(node)
                if table_md:
                    blocks.append(ParsedBlock(type="table", content=table_md))

            elif node_type == "thematic_break":
                # --- horizontal rule for slide separation
                blocks.append(ParsedBlock(type="thematic_break", content="---"))

            elif node_type == "paragraph":
                # Regular paragraph
                text = self._extract_text_with_links(node.get("children", []))
                if text.strip():
                    blocks.append(ParsedBlock(type="paragraph", content=text))

        return blocks

    def _process_list(self, list_node: dict, level: int) -> List[ParsedBlock]:
        """Process a list node recursively to handle nesting."""
        blocks = []
        children = list_node.get("children", [])

        for item in children:
            if item.get("type") == "list_item":
                item_children = item.get("children", [])
                for child in item_children:
                    child_type = child.get("type", "")

                    if child_type == "paragraph":
                        text = self._extract_text_with_links(child.get("children", []))
                        if text.strip():
                            blocks.append(
                                ParsedBlock(type="bullet", content=text, level=level)
                            )

                    elif child_type == "list":
                        # Nested list - recursively process with increased level
                        nested_blocks = self._process_list(child, level=level + 1)
                        blocks.extend(nested_blocks)

        return blocks

    def _extract_text_with_links(self, children: list) -> str:
        """Extract text from AST children, preserving link format."""
        result = []

        for child in children:
            child_type = child.get("type", "")

            if child_type == "text":
                result.append(child.get("raw", ""))

            elif child_type == "codespan":
                result.append(child.get("raw", ""))

            elif child_type == "link":
                # Preserve link format: [text](url)
                link_text = self._extract_text_with_links(child.get("children", []))
                link_url = child.get("attrs", {}).get("url", "")
                result.append(f"[{link_text}]({link_url})")

            elif child_type == "strong":
                # Remove bold formatting, just keep text
                text = self._extract_text_with_links(child.get("children", []))
                result.append(text)

            elif child_type == "emphasis":
                # Remove italic formatting, just keep text
                text = self._extract_text_with_links(child.get("children", []))
                result.append(text)

            elif child_type == "softbreak":
                result.append(" ")

            elif "children" in child:
                # Recursively extract from nested children
                result.append(self._extract_text_with_links(child["children"]))

        return "".join(result)

    def _table_to_markdown(self, table_node: dict) -> str:
        """Convert table AST back to markdown format."""
        lines = []
        children = table_node.get("children", [])

        for i, row in enumerate(children):
            if row.get("type") in ("table_head", "table_body"):
                row_children = row.get("children", [])
                for tr in row_children:
                    if tr.get("type") == "table_row":
                        cells = []
                        for cell in tr.get("children", []):
                            cell_text = self._extract_text_with_links(
                                cell.get("children", [])
                            )
                            cells.append(cell_text)
                        lines.append("| " + " | ".join(cells) + " |")

                        # Add separator after header
                        if row.get("type") == "table_head":
                            separator = "| " + " | ".join(["---"] * len(cells)) + " |"
                            lines.append(separator)

        return "\n".join(lines) if lines else ""

    def _split_into_slides(self, blocks: List[ParsedBlock]) -> List[SchemaSlideInput]:
        """Split blocks into slides using rule-based logic."""
        slides = []
        current_slide = self._create_empty_slide_data()
        bullet_count = 0

        for block in blocks:
            # Skip level 1 title (presentation title)
            if block.type == "title" and block.level == 1:
                continue

            # Thematic break forces new slide
            if block.type == "thematic_break":
                if self._has_content(current_slide):
                    slides.append(self._build_slide(current_slide))
                current_slide = self._create_empty_slide_data()
                bullet_count = 0
                continue

            # Level 2 heading starts new slide
            if block.type == "title" and block.level == 2:
                if self._has_content(current_slide):
                    slides.append(self._build_slide(current_slide))
                current_slide = self._create_empty_slide_data()
                current_slide["main_title"] = block.content
                bullet_count = 0
                continue

            # Level 3+ heading becomes bullet title or bullet item
            if block.type == "title" and block.level >= 3:
                # If we have bullets already, treat as a section separator
                if bullet_count > 0 and bullet_count >= self.MAX_BULLETS_PER_SLIDE:
                    slides.append(self._build_slide(current_slide))
                    current_slide = self._create_empty_slide_data()
                    bullet_count = 0

                # Add as bullet item with level 0
                current_slide["bullets"].append(
                    BulletItem(
                        text=block.content,
                        structure=PptxStructureModel(level=0, isList=False),
                    )
                )
                bullet_count += 1
                continue

            # Bullet points
            if block.type == "bullet":
                # Check if need to split due to bullet count
                if bullet_count >= self.MAX_BULLETS_PER_SLIDE:
                    slides.append(self._build_slide(current_slide))
                    # Keep main title for continuation
                    old_title = current_slide.get("main_title", "")
                    current_slide = self._create_empty_slide_data()
                    if old_title:
                        current_slide["main_title"] = f"{old_title} (cont.)"
                    bullet_count = 0

                current_slide["bullets"].append(
                    BulletItem(
                        text=block.content,
                        structure=PptxStructureModel(level=block.level, isList=True),
                    )
                )
                bullet_count += 1
                continue

            # Tables
            if block.type == "table":
                current_slide["tables"].append(block.content)
                continue

            # Paragraphs - treat as bullet points
            if block.type == "paragraph":
                if bullet_count >= self.MAX_BULLETS_PER_SLIDE:
                    slides.append(self._build_slide(current_slide))
                    old_title = current_slide.get("main_title", "")
                    current_slide = self._create_empty_slide_data()
                    if old_title:
                        current_slide["main_title"] = f"{old_title} (cont.)"
                    bullet_count = 0

                current_slide["bullets"].append(
                    BulletItem(
                        text=block.content,
                        structure=PptxStructureModel(level=0, isList=False),
                    )
                )
                bullet_count += 1
                continue

        # Add final slide if has content
        if self._has_content(current_slide):
            slides.append(self._build_slide(current_slide))

        # Ensure at least one slide
        if not slides:
            slides.append(SchemaSlideInput(mainTitle="Empty Presentation"))

        return slides

    def _create_empty_slide_data(self) -> dict:
        """Create empty slide data structure."""
        return {
            "main_title": None,
            "bullets": [],
            "tables": [],
        }

    def _has_content(self, slide_data: dict) -> bool:
        """Check if slide data has any content."""
        return bool(
            slide_data.get("main_title")
            or slide_data.get("bullets")
            or slide_data.get("tables")
        )

    def _build_slide(self, slide_data: dict) -> SchemaSlideInput:
        """Build SchemaSlideInput from slide data."""
        bullet_point = None
        if slide_data["bullets"]:
            bullet_point = BulletPointContent(
                title="",
                description=slide_data["bullets"],
            )

        tables = slide_data["tables"] if slide_data["tables"] else None

        return SchemaSlideInput(
            mainTitle=slide_data["main_title"],
            bulletPoint=bullet_point,
            tables=tables,
        )
