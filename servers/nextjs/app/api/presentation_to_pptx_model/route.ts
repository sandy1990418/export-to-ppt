import { ApiError } from "@/models/errors";
import { NextRequest, NextResponse } from "next/server";
import { ElementHandle, Page } from "puppeteer";
import { puppeteerPool } from "@/lib/puppeteer-pool";
import {
  extractSlideAttributesBatch,
  getScreenshotElementHandles,
} from "@/lib/dom-batch-extractor";
import {
  ElementAttributes,
  SlideAttributesResult,
} from "@/types/element_attibutes";
import { convertElementAttributesToPptxSlides } from "@/utils/pptx_models_utils";
import { PptxPresentationModel } from "@/types/pptx_models";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import sharp from "sharp";

export async function GET(request: NextRequest) {
  let page: Page | null = null;

  try {
    const id = await getPresentationId(request);
    page = await getPageForPresentation(id);
    const screenshotsDir = getScreenshotsDir();

    const { slides, speakerNotes } = await getSlidesAndSpeakerNotes(page);
    const slides_attributes = await getSlidesAttributes(slides, screenshotsDir);
    await postProcessSlidesAttributes(
      slides_attributes,
      screenshotsDir,
      speakerNotes
    );
    const slides_pptx_models =
      convertElementAttributesToPptxSlides(slides_attributes);
    const presentation_pptx_model: PptxPresentationModel = {
      slides: slides_pptx_models,
    };

    await releasePage(page);

    return NextResponse.json(presentation_pptx_model);
  } catch (error: any) {
    console.error(error);
    await releasePage(page);
    if (error instanceof ApiError) {
      return NextResponse.json(error, { status: 400 });
    }
    return NextResponse.json(
      { detail: `Internal server error: ${error.message}` },
      { status: 500 }
    );
  }
}

async function getPresentationId(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    throw new ApiError("Presentation ID not found");
  }
  return id;
}

async function getPageForPresentation(id: string): Promise<Page> {
  console.log("[Puppeteer] Getting page from pool...");
  const startTime = Date.now();

  const page = await puppeteerPool.getPage();

  console.log(
    `[Puppeteer] Got page from pool in ${Date.now() - startTime}ms`
  );

  // Listen to page console messages
  page.on("console", (msg) => {
    console.log(`[Page Console] ${msg.type()}: ${msg.text()}`);
  });

  // Listen to page errors
  page.on("pageerror", (error) => {
    console.error(`[Page Error] ${error.message}`);
  });

  // Listen to failed requests
  page.on("requestfailed", (request) => {
    console.error(
      `[Request Failed] ${request.url()}: ${request.failure()?.errorText}`
    );
  });

  // Listen to successful responses for API calls
  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("/api/")) {
      console.log(`[API Response] ${response.status()} ${url}`);
    }
  });

  // Ensure JavaScript is enabled
  await page.setJavaScriptEnabled(true);

  // Clear all browser state for fresh page
  const client = await page.createCDPSession();
  await Promise.all([
    client.send("Network.clearBrowserCache"),
    client.send("Network.clearBrowserCookies"),
    client.send("Storage.clearDataForOrigin", {
      origin: "http://localhost:3000",
      storageTypes: "all",
    }),
  ]);

  // Use networkidle2 to wait for JS chunks to load, with longer timeout
  console.log("[Puppeteer] Navigating to pdf-maker page...");
  await page.goto(`http://localhost:3000/pdf-maker?id=${id}`, {
    waitUntil: "networkidle2",
    timeout: 120000,
  });
  console.log("[Puppeteer] Initial page load complete, reloading for stable render..."); 
  // console.log(
  //   "[Puppeteer] Initial page load complete, waiting for hydration..."
  // );

  // Wait extra time for React hydration to complete
  // await new Promise((resolve) => setTimeout(resolve, 5000));
  await page.reload({ waitUntil: "networkidle2", timeout: 60000 });  
  await new Promise((resolve) => setTimeout(resolve, 2000));       
  console.log("[Puppeteer] Page reloaded, waiting for hydration...");
  console.log("[Puppeteer] Page loaded, waiting for slides...");

  // Wait for slides to be rendered
  // Use a simple, robust approach with manual polling
  const maxWaitTime = 120000; // 120 seconds max
  const pollInterval = 3000; // Check every 3 seconds
  const navStartTime = Date.now();
  let slidesFound = false;
  let checkCount = 0;

  while (Date.now() - navStartTime < maxWaitTime) {
    checkCount++;
    const elapsed = ((Date.now() - navStartTime) / 1000).toFixed(1);

    try {
      const pageState = await page.evaluate(() => {
        const wrapper = document.querySelector("#presentation-slides-wrapper");
        const slides = wrapper
          ? wrapper.querySelectorAll("[data-speaker-note]")
          : [];
        const body = document.body.innerHTML.substring(0, 500); // First 500 chars of body

        return {
          hasWrapper: !!wrapper,
          slideCount: slides.length,
          bodyPreview: body,
          wrapperHTML: wrapper ? wrapper.innerHTML.substring(0, 500) : "null",
        };
      });

      console.log(
        `[Puppeteer] Check #${checkCount} (${elapsed}s):`,
        JSON.stringify(pageState, null, 2)
      );

      if (pageState.slideCount > 0) {
        slidesFound = true;
        console.log(
          `[Puppeteer] Found ${pageState.slideCount} slides after ${elapsed}s`
        );
        break;
      }

      // Wait before checking again (give more time for React and API)
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    } catch (error) {
      console.error("[Puppeteer] Error checking for slides:", error);
      // Continue trying
    }
  }

  if (!slidesFound) {
    console.error("[Puppeteer] Timeout waiting for slides");
    // Take a screenshot for debugging
    try {
      const screenshotPath = `/tmp/puppeteer-error-${id}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`[Puppeteer] Screenshot saved to: ${screenshotPath}`);
    } catch (screenshotError) {
      console.error("[Puppeteer] Failed to take screenshot:", screenshotError);
    }
    throw new ApiError("Presentation slides not found");
  }

  // Give it a moment for any final rendering
  await new Promise((resolve) => setTimeout(resolve, 2000));

  return page;
}

async function releasePage(page: Page | null): Promise<void> {
  if (page) {
    await puppeteerPool.releasePage(page);
  }
}

function getScreenshotsDir() {
  const tempDir = process.env.TEMP_DIRECTORY;
  if (!tempDir) {
    console.warn(
      "TEMP_DIRECTORY environment variable not set, skipping screenshot"
    );
    throw new ApiError("TEMP_DIRECTORY environment variable not set");
  }
  const screenshotsDir = path.join(tempDir, "screenshots");
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }
  return screenshotsDir;
}

async function postProcessSlidesAttributes(
  slidesAttributes: SlideAttributesResult[],
  screenshotsDir: string,
  speakerNotes: string[]
) {
  for (const [index, slideAttributes] of slidesAttributes.entries()) {
    for (const element of slideAttributes.elements) {
      if (element.should_screenshot) {
        const screenshotPath = await screenshotElement(element, screenshotsDir);
        element.imageSrc = screenshotPath;
        element.should_screenshot = false;
        element.objectFit = "cover";
        element.element = undefined;
      }
    }
    slideAttributes.speakerNote = speakerNotes[index];
  }
}

async function screenshotElement(
  element: ElementAttributes,
  screenshotsDir: string
) {
  const screenshotPath = path.join(
    screenshotsDir,
    `${uuidv4()}.png`
  ) as `${string}.png`;

  // For SVG elements, use convertSvgToPng
  if (element.tagName === "svg") {
    const pngBuffer = await convertSvgToPng(element);
    fs.writeFileSync(screenshotPath, pngBuffer);
    return screenshotPath;
  }

  // Hide all elements except the target element and its ancestors
  await element.element?.evaluate(
    (el) => {
      const originalOpacities = new Map();

      const hideAllExcept = (targetElement: Element) => {
        const allElements = document.querySelectorAll("*");

        allElements.forEach((elem) => {
          const computedStyle = window.getComputedStyle(elem);
          originalOpacities.set(elem, computedStyle.opacity);

          if (
            targetElement === elem ||
            targetElement.contains(elem) ||
            elem.contains(targetElement)
          ) {
            (elem as HTMLElement).style.opacity = computedStyle.opacity || "1";
            return;
          }

          (elem as HTMLElement).style.opacity = "0";
        });
      };

      hideAllExcept(el);

      (el as any).__restoreStyles = () => {
        originalOpacities.forEach((opacity, elem) => {
          (elem as HTMLElement).style.opacity = opacity;
        });
      };
    },
    element.opacity,
    element.font?.color
  );

  const screenshot = await element.element?.screenshot({
    path: screenshotPath,
  });
  if (!screenshot) {
    throw new ApiError("Failed to screenshot element");
  }

  await element.element?.evaluate((el) => {
    if ((el as any).__restoreStyles) {
      (el as any).__restoreStyles();
    }
  });

  return screenshotPath;
}

const convertSvgToPng = async (element_attibutes: ElementAttributes) => {
  const svgHtml =
    (await element_attibutes.element?.evaluate((el) => {
      // Apply font color
      const fontColor = window.getComputedStyle(el).color;
      (el as HTMLElement).style.color = fontColor;

      return el.outerHTML;
    })) || "";

  const svgBuffer = Buffer.from(svgHtml);
  const pngBuffer = await sharp(svgBuffer)
    .resize(
      Math.round(element_attibutes.position!.width!),
      Math.round(element_attibutes.position!.height!)
    )
    .toFormat("png")
    .toBuffer();
  return pngBuffer;
};

async function getSlidesAttributes(
  slides: ElementHandle<Element>[],
  screenshotsDir: string
): Promise<SlideAttributesResult[]> {
  console.log(`[DOM Extraction] Starting batch extraction for ${slides.length} slides...`);
  const startTime = Date.now();

  const slideAttributes: SlideAttributesResult[] = [];

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const slideStartTime = Date.now();

    // Extract all attributes in a single evaluate call
    const batchResult = await extractSlideAttributesBatch(slide);

    // Get ElementHandles for elements that need screenshots
    if (batchResult.screenshotElements.length > 0) {
      const handles = await getScreenshotElementHandles(slide, batchResult.screenshotElements);

      // Attach ElementHandles to elements that need screenshots
      for (const element of batchResult.elements) {
        if (element.should_screenshot && element._elementPath) {
          const handle = handles.get(element._elementPath);
          if (handle) {
            element.element = handle;
          }
        }
        // Clean up internal properties
        delete element._elementPath;
        delete element._depth;
        delete element._skipChildren;
      }
    } else {
      // Clean up internal properties
      for (const element of batchResult.elements) {
        delete element._elementPath;
        delete element._depth;
        delete element._skipChildren;
      }
    }

    slideAttributes.push({
      elements: batchResult.elements as ElementAttributes[],
      backgroundColor: batchResult.backgroundColor,
    });

    console.log(`[DOM Extraction] Slide ${i + 1}/${slides.length} extracted in ${Date.now() - slideStartTime}ms (${batchResult.elements.length} elements)`);
  }

  console.log(`[DOM Extraction] Total extraction time: ${Date.now() - startTime}ms`);
  return slideAttributes;
}

async function getSlidesAndSpeakerNotes(page: Page) {
  const slides_wrapper = await getSlidesWrapper(page);
  const speakerNotes = await getSpeakerNotes(slides_wrapper);
  const slides = await slides_wrapper.$$(":scope > div > div");
  return { slides, speakerNotes };
}

async function getSlidesWrapper(page: Page): Promise<ElementHandle<Element>> {
  const slides_wrapper = await page.$("#presentation-slides-wrapper");
  if (!slides_wrapper) {
    throw new ApiError("Presentation slides not found");
  }
  return slides_wrapper;
}

async function getSpeakerNotes(slides_wrapper: ElementHandle<Element>) {
  return await slides_wrapper.evaluate((el) => {
    return Array.from(el.querySelectorAll("[data-speaker-note]")).map(
      (el) => el.getAttribute("data-speaker-note") || ""
    );
  });
}
