import os
import json
from pathlib import Path
from fastapi import HTTPException
from models.presentation_layout import PresentationLayoutModel

def get_template_layouts_dir() -> str:
    """Get the path to pre-built template layouts directory."""
    # Calculate project root first (reliable fallback)
    current_file = Path(__file__).resolve()
    # Go up: get_layout_by_name.py -> utils -> fastapi -> servers -> presenton-export-only
    project_root = current_file.parent.parent.parent.parent

    # Try APP_DATA_DIRECTORY first
    app_data_dir = os.environ.get('APP_DATA_DIRECTORY')
    if app_data_dir:
        # Convert to Path for proper handling
        app_data_path = Path(app_data_dir)

        # If it's a relative path, resolve it from project root
        if not app_data_path.is_absolute():
            app_data_path = project_root / app_data_path

        layouts_dir = app_data_path / 'template-layouts'

        # Check if this path exists
        if layouts_dir.exists():
            print(f"[DEBUG] Using APP_DATA_DIRECTORY: {layouts_dir}")
            return str(layouts_dir)
        else:
            print(f"[DEBUG] APP_DATA_DIRECTORY path does not exist: {layouts_dir}, falling back to project root")

    # Fall back to relative path from project root
    layouts_dir = project_root / 'app_data' / 'template-layouts'
    print(f"[DEBUG] Using fallback path: {layouts_dir}")
    return str(layouts_dir)

async def get_layout_by_name(layout_name: str) -> PresentationLayoutModel:
    """
    Get layout by name from pre-built JSON files.
    Run `node prebuild-templates.mjs` to regenerate layout JSON files.
    """
    layouts_dir = get_template_layouts_dir()
    layout_file = os.path.join(layouts_dir, f"{layout_name}.json")
    
    print(f"[DEBUG] Looking for template at: {layout_file}")
    print(f"[DEBUG] File exists: {os.path.exists(layout_file)}")
    
    if not os.path.exists(layout_file):
        # List available templates for debugging
        if os.path.exists(layouts_dir):
            available = os.listdir(layouts_dir)
            print(f"[DEBUG] Available templates: {available}")
        else:
            print(f"[DEBUG] Directory does not exist: {layouts_dir}")
        raise HTTPException(
            status_code=404,
            detail=f"Template '{layout_name}' not found at {layout_file}. Run 'node prebuild-templates.mjs' to generate."
        )
    
    with open(layout_file, 'r', encoding='utf-8') as f:
        layout_json = json.load(f)
    
    return PresentationLayoutModel(**layout_json)
