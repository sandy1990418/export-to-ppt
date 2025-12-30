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


# LLM Evaluation Response Schema
class SlideIssue(BaseModel):
    """An issue found in a specific slide."""

    slide_index: int = Field(..., description="Index of the problematic slide (0-based)")
    issue: str = Field(..., description="Description of the issue")
    severity: str = Field(
        default="medium", description="Severity: low, medium, high"
    )


class SlideFix(BaseModel):
    """A fix suggestion for a slide."""

    slide_index: int = Field(..., description="Index of slide to fix (0-based)")
    action: str = Field(
        ..., description="Action: split, merge_with_next, merge_with_prev, reorganize"
    )
    new_title: Optional[str] = Field(None, description="New title if changed")
    items_to_move: Optional[List[int]] = Field(
        None, description="Indices of items to move (for split/reorganize)"
    )
    split_at: Optional[int] = Field(
        None, description="Split after this item index (for split action)"
    )


class SlideEvaluationResponse(BaseModel):
    """LLM evaluation of the slide splitting quality."""

    is_good: bool = Field(..., description="Whether the current splitting is acceptable")
    overall_score: int = Field(
        ..., ge=1, le=10, description="Quality score from 1-10"
    )
    issues: List[SlideIssue] = Field(
        default_factory=list, description="List of issues found"
    )
    fixes: List[SlideFix] = Field(
        default_factory=list, description="Suggested fixes for issues"
    )
    reasoning: str = Field(..., description="Brief explanation of the evaluation")


class MarkdownToSchemaConverter:
    """Convert markdown content to SchemaExportRequest for PPTX/PDF export."""

    # Slide dimensions (matching schema_to_pptx_converter.py)
    SLIDE_HEIGHT = 720
    MARGIN_BOTTOM = 60
    TITLE_HEIGHT = 70  # mainTitle area
    BULLET_ITEM_HEIGHT = 30  # Height per bullet item
    TABLE_ROW_HEIGHT = 35  # Height per table row
    TABLE_MARGIN = 40  # Margin before table

    # Content area: from after title to bottom margin
    CONTENT_START_Y = 170  # Where bullets start
    MAX_CONTENT_HEIGHT = SLIDE_HEIGHT - CONTENT_START_Y - MARGIN_BOTTOM  # ~490px

    MIN_ACCEPTABLE_SCORE = 7  # Threshold for accepting rule-based result

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
        """
        Convert markdown with LLM as validator.

        Flow:
        1. First do rule-based splitting
        2. LLM evaluates the result
        3. If good (score >= 7) -> use rule-based result
        4. If not good -> apply LLM's suggested fixes
        """
        # Step 1: Get rule-based result first
        rule_based_result = self.convert(markdown, export_as, title)

        # Step 2: Ask LLM to evaluate the splitting
        evaluation = await self._llm_evaluate_slides(rule_based_result)

        # Step 3: If evaluation is good, return rule-based result
        if evaluation.is_good and evaluation.overall_score >= self.MIN_ACCEPTABLE_SCORE:
            return rule_based_result

        # Step 4: Apply LLM's suggested fixes
        fixed_slides = self._apply_fixes(rule_based_result.slides, evaluation.fixes)

        return SchemaExportRequest(
            title=rule_based_result.title,
            slides=fixed_slides,
            export_as=export_as,
        )

    async def _llm_evaluate_slides(
        self, schema_request: SchemaExportRequest
    ) -> SlideEvaluationResponse:
        """Use LLM to evaluate the quality of slide splitting."""
        # Prepare slides description for LLM
        slides_description = []
        for i, slide in enumerate(schema_request.slides):
            slide_desc = f"\n=== Slide {i} ===\n"
            if slide.mainTitle:
                slide_desc += f"Title: {slide.mainTitle}\n"

            if slide.bulletPoint:
                slide_desc += "Content:\n"
                for j, item in enumerate(slide.bulletPoint.description):
                    if isinstance(item, str):
                        slide_desc += f"  [{j}] {item}\n"
                    else:
                        indent = "  " * (item.structure.level if item.structure else 0)
                        bullet = "•" if (item.structure and item.structure.isList) else "-"
                        slide_desc += f"  [{j}] {indent}{bullet} {item.text}\n"

            if slide.tables:
                slide_desc += f"Tables: {len(slide.tables)} table(s)\n"

            slides_description.append(slide_desc)

        slides_text = "".join(slides_description)

        system_prompt = """You are a presentation quality evaluator. Your job is to judge whether the slide splitting is good.

Evaluation criteria:
1. Each slide should focus on ONE coherent topic
2. Slides should have 3-8 bullet points (not too few, not too many)
3. Related content should be grouped together
4. Tables should be with their related content
5. The flow between slides should be logical

Score Guidelines:
- 9-10: Excellent, no changes needed
- 7-8: Good, minor improvements possible but acceptable
- 5-6: Acceptable but could be better
- 3-4: Poor, significant issues
- 1-2: Very poor, major restructuring needed

If score < 7, provide specific fixes using these actions:
- "split": Split one slide into two (specify split_at index)
- "merge_with_next": Merge this slide with the next one
- "merge_with_prev": Merge this slide with the previous one
- "reorganize": Move items between slides (specify items_to_move)

Be conservative - only suggest fixes for clear problems."""

        user_prompt = f"""Evaluate the following presentation slide structure:

Presentation Title: {schema_request.title}

{slides_text}

Is this splitting good? What issues exist and how to fix them?"""

        client = LLMClient()
        try:
            response = await client.generate_structured(
                model=get_model(),
                messages=[
                    LLMSystemMessage(content=system_prompt),
                    LLMUserMessage(content=user_prompt),
                ],
                response_format=SlideEvaluationResponse.model_json_schema(),
                strict=False,
            )
            return SlideEvaluationResponse(**response)
        except Exception:
            # If LLM fails, assume rule-based is good enough
            return SlideEvaluationResponse(
                is_good=True,
                overall_score=7,
                issues=[],
                fixes=[],
                reasoning="LLM evaluation failed, using rule-based result",
            )

    def _apply_fixes(
        self, slides: List[SchemaSlideInput], fixes: List[SlideFix]
    ) -> List[SchemaSlideInput]:
        """Apply LLM-suggested fixes to the slides."""
        if not fixes:
            return slides

        # Work with a mutable copy
        result = list(slides)

        # Sort fixes by slide index in reverse order to avoid index shifting issues
        sorted_fixes = sorted(fixes, key=lambda f: f.slide_index, reverse=True)

        for fix in sorted_fixes:
            idx = fix.slide_index
            if idx < 0 or idx >= len(result):
                continue

            if fix.action == "split" and fix.split_at is not None:
                # Split slide into two
                original = result[idx]
                if original.bulletPoint and original.bulletPoint.description:
                    items = original.bulletPoint.description
                    split_point = min(fix.split_at + 1, len(items))

                    # First part
                    first_items = items[:split_point]
                    first_slide = SchemaSlideInput(
                        mainTitle=original.mainTitle,
                        bulletPoint=BulletPointContent(
                            title=original.bulletPoint.title,
                            description=first_items,
                        ) if first_items else None,
                        tables=original.tables,
                    )

                    # Second part
                    second_items = items[split_point:]
                    second_title = f"{original.mainTitle} (cont.)" if original.mainTitle else None
                    second_slide = SchemaSlideInput(
                        mainTitle=second_title,
                        bulletPoint=BulletPointContent(
                            title="",
                            description=second_items,
                        ) if second_items else None,
                        tables=None,
                    )

                    # Replace original with two slides
                    result[idx:idx+1] = [first_slide, second_slide]

            elif fix.action == "merge_with_next":
                if idx + 1 < len(result):
                    merged = self._merge_slides(result[idx], result[idx + 1])
                    result[idx:idx+2] = [merged]

            elif fix.action == "merge_with_prev":
                if idx > 0:
                    merged = self._merge_slides(result[idx - 1], result[idx])
                    result[idx-1:idx+1] = [merged]

            elif fix.action == "reorganize" and fix.items_to_move:
                # For reorganize, we'd need more complex logic
                # For now, just update title if provided
                if fix.new_title:
                    result[idx] = SchemaSlideInput(
                        mainTitle=fix.new_title,
                        bulletPoint=result[idx].bulletPoint,
                        tables=result[idx].tables,
                    )

        return result

    def _merge_slides(
        self, slide1: SchemaSlideInput, slide2: SchemaSlideInput
    ) -> SchemaSlideInput:
        """Merge two slides into one."""
        # Use first slide's title, or second's if first doesn't have one
        merged_title = slide1.mainTitle or slide2.mainTitle

        # Merge bullet points
        merged_items = []
        if slide1.bulletPoint:
            merged_items.extend(slide1.bulletPoint.description)
        if slide2.bulletPoint:
            merged_items.extend(slide2.bulletPoint.description)

        merged_bullet = None
        if merged_items:
            merged_bullet = BulletPointContent(
                title=slide1.bulletPoint.title if slide1.bulletPoint else "",
                description=merged_items,
            )

        # Merge tables
        merged_tables = []
        if slide1.tables:
            merged_tables.extend(slide1.tables)
        if slide2.tables:
            merged_tables.extend(slide2.tables)

        return SchemaSlideInput(
            mainTitle=merged_title,
            bulletPoint=merged_bullet,
            tables=merged_tables if merged_tables else None,
        )

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

    def _calculate_table_height(self, table_markdown: str) -> int:
        """Calculate the height a table will occupy."""
        from utils.markdown_table_parser import parse_markdown_table
        rows = parse_markdown_table(table_markdown)
        if not rows:
            return 0
        return self.TABLE_MARGIN + len(rows) * self.TABLE_ROW_HEIGHT

    def _calculate_current_height(self, slide_data: dict) -> int:
        """Calculate the current content height of a slide."""
        height = 0

        # Bullets height
        height += len(slide_data["bullets"]) * self.BULLET_ITEM_HEIGHT

        # Tables height
        for table_md in slide_data["tables"]:
            height += self._calculate_table_height(table_md)

        return height

    def _would_exceed_height(self, slide_data: dict, additional_height: int) -> bool:
        """Check if adding content would exceed the slide height."""
        current = self._calculate_current_height(slide_data)
        return (current + additional_height) > self.MAX_CONTENT_HEIGHT

    def _split_slide_and_continue(
        self, slides: list, current_slide: dict
    ) -> dict:
        """Split current slide and create continuation slide with same title."""
        if self._has_content(current_slide):
            slides.append(self._build_slide(current_slide))

        # Create new slide with continuation title
        old_title = current_slide.get("main_title", "")
        new_slide = self._create_empty_slide_data()
        if old_title:
            # Remove existing "(cont.)" suffix before adding new one
            base_title = old_title.replace(" (cont.)", "")
            new_slide["main_title"] = f"{base_title} (cont.)"

        return new_slide

    def _split_into_slides(self, blocks: List[ParsedBlock]) -> List[SchemaSlideInput]:
        """Split blocks into slides based on content height."""
        slides = []
        current_slide = self._create_empty_slide_data()

        for block in blocks:
            # Skip level 1 title (presentation title)
            if block.type == "title" and block.level == 1:
                continue

            # Thematic break forces new slide
            if block.type == "thematic_break":
                if self._has_content(current_slide):
                    slides.append(self._build_slide(current_slide))
                current_slide = self._create_empty_slide_data()
                continue

            # Level 2 heading starts new slide
            if block.type == "title" and block.level == 2:
                if self._has_content(current_slide):
                    slides.append(self._build_slide(current_slide))
                current_slide = self._create_empty_slide_data()
                current_slide["main_title"] = block.content
                continue

            # Level 3+ heading becomes bullet item
            if block.type == "title" and block.level >= 3:
                # Check if adding this would exceed height
                if self._would_exceed_height(current_slide, self.BULLET_ITEM_HEIGHT):
                    current_slide = self._split_slide_and_continue(slides, current_slide)

                current_slide["bullets"].append(
                    BulletItem(
                        text=block.content,
                        structure=PptxStructureModel(level=0, isList=False),
                    )
                )
                continue

            # Bullet points
            if block.type == "bullet":
                # Check if adding this would exceed height
                if self._would_exceed_height(current_slide, self.BULLET_ITEM_HEIGHT):
                    current_slide = self._split_slide_and_continue(slides, current_slide)

                current_slide["bullets"].append(
                    BulletItem(
                        text=block.content,
                        structure=PptxStructureModel(level=block.level, isList=True),
                    )
                )
                continue

            # Tables
            if block.type == "table":
                table_height = self._calculate_table_height(block.content)

                # Check if adding this table would exceed height
                if self._would_exceed_height(current_slide, table_height):
                    # If table alone is too big, still add it but on new slide
                    if self._has_content(current_slide):
                        current_slide = self._split_slide_and_continue(slides, current_slide)

                current_slide["tables"].append(block.content)
                continue

            # Paragraphs - treat as bullet points
            if block.type == "paragraph":
                if self._would_exceed_height(current_slide, self.BULLET_ITEM_HEIGHT):
                    current_slide = self._split_slide_and_continue(slides, current_slide)

                current_slide["bullets"].append(
                    BulletItem(
                        text=block.content,
                        structure=PptxStructureModel(level=0, isList=False),
                    )
                )
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
