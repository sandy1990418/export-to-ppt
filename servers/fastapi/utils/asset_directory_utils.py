import os
from utils.get_env import get_app_data_directory_env


def get_absolute_app_data_directory():
    """Get absolute path to app_data directory"""
    app_data_dir = get_app_data_directory_env() or "app_data"

    # If already absolute, return as is
    if os.path.isabs(app_data_dir):
        return app_data_dir

    # Convert relative path to absolute (relative to project root)
    current_file = os.path.abspath(__file__)
    # Go up: utils -> fastapi -> servers -> project_root
    project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(current_file))))
    return os.path.join(project_root, app_data_dir)


def get_images_directory():
    images_directory = os.path.join(get_absolute_app_data_directory(), "images")
    os.makedirs(images_directory, exist_ok=True)
    return images_directory


def get_exports_directory():
    export_directory = os.path.join(get_absolute_app_data_directory(), "exports")
    os.makedirs(export_directory, exist_ok=True)
    return export_directory

def get_uploads_directory():
    uploads_directory = os.path.join(get_absolute_app_data_directory(), "uploads")
    os.makedirs(uploads_directory, exist_ok=True)
    return uploads_directory
