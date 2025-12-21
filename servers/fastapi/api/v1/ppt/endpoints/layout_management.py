from fastapi import APIRouter

LAYOUT_MANAGEMENT_ROUTER = APIRouter(prefix="/template-management", tags=["Layout Management"])


@LAYOUT_MANAGEMENT_ROUTER.get("/summary")
async def get_all_templates_summary():
    # Return empty list for custom templates as we are in export-only mode
    return []
