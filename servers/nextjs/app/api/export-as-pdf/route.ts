import path from "path";
import fs from "fs";
import { Page } from "puppeteer";

import { sanitizeFilename } from "@/app/(presentation-generator)/utils/others";
import { NextResponse, NextRequest } from "next/server";
import { puppeteerPool } from "@/lib/puppeteer-pool";

function getAbsoluteAppDataDirectory(): string {
  const appDataDir = process.env.APP_DATA_DIRECTORY || "app_data";

  // If already absolute, return as is
  if (path.isAbsolute(appDataDir)) {
    return appDataDir;
  }

  // Convert relative path to absolute (relative to project root)
  // Next.js runs from servers/nextjs, so go up 2 levels to reach project root
  const cwd = process.cwd(); // servers/nextjs
  const projectRoot = path.resolve(cwd, "../..");
  return path.join(projectRoot, appDataDir);
}

export async function POST(req: NextRequest) {
  let page: Page | null = null;

  try {
    const { id, title } = await req.json();
    if (!id) {
      return NextResponse.json(
        { error: "Missing Presentation ID" },
        { status: 400 }
      );
    }

    console.log("[PDF Export] Starting export for id:", id);
    const startTime = Date.now();

    page = await puppeteerPool.getPage();
    console.log(
      `[PDF Export] Got page from pool in ${Date.now() - startTime}ms`
    );

    // Ensure JavaScript is enabled
    await page.setJavaScriptEnabled(true);

    // Clear all browser state for fresh page
    const cdpClient = await page.createCDPSession();
    await Promise.all([
      cdpClient.send("Network.clearBrowserCache"),
      cdpClient.send("Network.clearBrowserCookies"),
      cdpClient.send("Storage.clearDataForOrigin", {
        origin: "http://localhost:3000",
        storageTypes: "all",
      }),
    ]);

    console.log("[PDF Export] Navigating to pdf-maker page...");

    // Use networkidle2 and longer timeout for JS chunks to load
    await page.goto(`http://localhost:3000/pdf-maker?id=${id}`, {
      waitUntil: "networkidle2",
      timeout: 120000,
    });

    // Wait for React hydration
    await new Promise((resolve) => setTimeout(resolve, 5000));

    console.log("[PDF Export] Page loaded, waiting for slides...");

    // Wait for slides to be rendered
    const maxWaitTime = 120000;
    const pollInterval = 3000;
    const navStartTime = Date.now();
    let slidesFound = false;

    while (Date.now() - navStartTime < maxWaitTime) {
      const slideCount = await page.evaluate(() => {
        const wrapper = document.querySelector("#presentation-slides-wrapper");
        const slides = wrapper
          ? wrapper.querySelectorAll("[data-speaker-note]")
          : [];
        return slides.length;
      });

      if (slideCount > 0) {
        slidesFound = true;
        console.log(`[PDF Export] Found ${slideCount} slides`);
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    if (!slidesFound) {
      console.error("[PDF Export] Timeout waiting for slides");
      await puppeteerPool.releasePage(page);
      return NextResponse.json(
        { error: "Timeout waiting for slides to render" },
        { status: 500 }
      );
    }

    // Extra wait for images and fonts to load
    await new Promise((resolve) => setTimeout(resolve, 3000));

    console.log("[PDF Export] Generating PDF...");

    const pdfBuffer = await page.pdf({
      width: "1280px",
      height: "720px",
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });

    await puppeteerPool.releasePage(page);
    page = null;

    const sanitizedTitle = sanitizeFilename(title ?? "presentation");
    const appDataDirectory = getAbsoluteAppDataDirectory();

    console.log("[PDF Export] Using app data directory:", appDataDirectory);

    const destinationPath = path.join(
      appDataDirectory,
      "exports",
      `${sanitizedTitle}.pdf`
    );

    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.promises.writeFile(destinationPath, pdfBuffer);

    console.log("[PDF Export] PDF saved to:", destinationPath);

    return NextResponse.json({
      success: true,
      path: destinationPath,
    });
  } catch (error: any) {
    console.error("[PDF Export] Error:", error);
    if (page) {
      await puppeteerPool.releasePage(page);
    }
    return NextResponse.json(
      { error: `PDF export failed: ${error.message}` },
      { status: 500 }
    );
  }
}
