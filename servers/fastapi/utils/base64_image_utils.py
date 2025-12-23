"""
Utility functions for handling base64 encoded images.
"""
import base64
import hashlib
import os
import re
from typing import Dict, Any, List
from concurrent.futures import ThreadPoolExecutor

from utils.asset_directory_utils import get_images_directory
from utils.dict_utils import get_dict_paths_with_key, get_dict_at_path, set_dict_at_path

# Cache for deduplication: hash -> saved file path
_base64_cache: Dict[str, str] = {}


def is_base64_image(value: Any) -> bool:
    """Check if a value is a base64 encoded image."""
    return isinstance(value, str) and value.startswith("data:image/")


def _get_base64_hash(base64_data: str) -> str:
    """Get a short hash of base64 data for deduplication."""
    # Only hash the actual data part, not the header
    data_start = base64_data.find(",") + 1
    # Use first 1000 chars + last 1000 chars for fast hashing of large images
    data = base64_data[data_start:]
    if len(data) > 2000:
        data = data[:1000] + data[-1000:]
    return hashlib.md5(data.encode()).hexdigest()[:16]


def save_base64_image(base64_string: str, output_dir: str = None) -> str:
    """
    Save a base64 encoded image to a file with deduplication.

    Args:
        base64_string: Base64 encoded image string (e.g., "data:image/png;base64,...")
        output_dir: Directory to save the image. Defaults to images directory.

    Returns:
        Path to the saved image file (relative path like /app_data/images/xxx.png)
    """
    # Check cache for deduplication
    img_hash = _get_base64_hash(base64_string)
    if img_hash in _base64_cache:
        return _base64_cache[img_hash]

    if output_dir is None:
        output_dir = get_images_directory()

    # Parse the base64 string: data:image/png;base64,iVBORw0KGgo...
    match = re.match(r"data:image/([\w+]+);base64,(.+)", base64_string, re.DOTALL)
    if not match:
        raise ValueError("Invalid base64 image format")

    image_format = match.group(1)
    image_data = match.group(2)

    # Map common formats
    format_map = {"jpeg": "jpg", "svg+xml": "svg"}
    ext = format_map.get(image_format, image_format)

    # Use hash as filename for deduplication
    filename = f"{img_hash}.{ext}"
    filepath = os.path.join(output_dir, filename)

    # Skip if file already exists (same content)
    if not os.path.exists(filepath):
        image_bytes = base64.b64decode(image_data)
        with open(filepath, "wb") as f:
            f.write(image_bytes)

    result_path = f"/app_data/images/{filename}"
    _base64_cache[img_hash] = result_path
    return result_path


def _process_single_image(args: tuple) -> tuple:
    """Process a single base64 image. Used for parallel processing."""
    path, parent_dict, key = args
    value = parent_dict.get(key)

    if not is_base64_image(value):
        return (path, None)

    try:
        file_path = save_base64_image(value)
        return (path, file_path)
    except Exception as e:
        print(f"Warning: Failed to save base64 image: {e}")
        return (path, None)


def process_base64_images_in_dict(data: Dict[str, Any], key: str = "__image_url__") -> int:
    """
    Find all base64 images in a dictionary and save them to files.
    Uses parallel processing for multiple images and deduplication.
    Modifies the dictionary in-place.

    Args:
        data: Dictionary to process
        key: Key to look for (default: __image_url__)

    Returns:
        Number of images processed
    """
    paths = get_dict_paths_with_key(data, key)
    if not paths:
        return 0

    # Collect all images to process
    to_process = []
    for path in paths:
        parent_dict = get_dict_at_path(data, path)
        if is_base64_image(parent_dict.get(key)):
            to_process.append((path, parent_dict, key))

    if not to_process:
        return 0

    # Process in parallel if multiple images
    if len(to_process) > 1:
        with ThreadPoolExecutor(max_workers=min(4, len(to_process))) as executor:
            results = list(executor.map(_process_single_image, to_process))
    else:
        results = [_process_single_image(to_process[0])]

    # Apply results
    count = 0
    for (path, parent_dict, _), (_, file_path) in zip(to_process, results):
        if file_path:
            parent_dict[key] = file_path
            set_dict_at_path(data, path, parent_dict)
            count += 1

    return count
