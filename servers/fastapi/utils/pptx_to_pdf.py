import os
import subprocess


async def convert_pptx_to_pdf(pptx_path: str, output_dir: str) -> str:
    """
    Convert a PPTX file to PDF using LibreOffice.

    Args:
        pptx_path: Path to the input PPTX file.
        output_dir: Directory where the PDF will be saved.

    Returns:
        Path to the generated PDF file.

    Raises:
        Exception: If conversion fails or times out.
    """
    os.makedirs(output_dir, exist_ok=True)

    try:
        result = subprocess.run(
            [
                "libreoffice",
                "--headless",
                "--convert-to",
                "pdf",
                "--outdir",
                output_dir,
                pptx_path,
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=500,
        )

        print(f"LibreOffice PDF conversion output: {result.stdout}")
        if result.stderr:
            print(f"LibreOffice PDF conversion warnings: {result.stderr}")

    except subprocess.TimeoutExpired:
        raise Exception("LibreOffice PDF conversion timed out after 500 seconds")
    except subprocess.CalledProcessError as e:
        error_msg = e.stderr if e.stderr else str(e)
        raise Exception(f"LibreOffice PDF conversion failed: {error_msg}")

    # Find the generated PDF file (LibreOffice uses original filename with .pdf extension)
    pdf_files = [f for f in os.listdir(output_dir) if f.endswith(".pdf")]
    if not pdf_files:
        raise Exception("LibreOffice failed to generate PDF file")

    # Get the most recently created PDF (in case there are multiple)
    pdf_files.sort(key=lambda f: os.path.getmtime(os.path.join(output_dir, f)), reverse=True)
    pdf_path = os.path.join(output_dir, pdf_files[0])

    print(f"Generated PDF: {pdf_path}")
    return pdf_path
