import re
from typing import List


def parse_markdown_table(markdown: str) -> List[List[str]]:
    """
    Parse a markdown table string into a 2D list of cell values.

    Args:
        markdown: Markdown table string like:
            | col1 | col2 |
            |------|------|
            | val1 | val2 |

    Returns:
        List of rows, where each row is a list of cell values.
        Example: [["col1", "col2"], ["val1", "val2"]]
    """
    if not markdown or not markdown.strip():
        return []

    lines = markdown.strip().split("\n")
    rows = []

    for line in lines:
        line = line.strip()
        if not line:
            continue

        # Skip separator rows (contains only |, -, :, and spaces)
        if re.match(r"^\|[\s\-:|\s]+\|$", line):
            continue

        # Parse cells from the line
        # Remove leading and trailing |
        if line.startswith("|"):
            line = line[1:]
        if line.endswith("|"):
            line = line[:-1]

        # Split by | and strip whitespace from each cell
        cells = [cell.strip() for cell in line.split("|")]

        if cells:
            rows.append(cells)

    return rows
