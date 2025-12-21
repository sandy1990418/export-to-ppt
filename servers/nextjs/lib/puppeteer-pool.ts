import puppeteer, { Browser, Page } from "puppeteer";

const PUPPETEER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-web-security",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-features=TranslateUI",
  "--disable-ipc-flooding-protection",
  "--disable-software-rasterizer",
  "--disable-extensions",
];

const PROTOCOL_TIMEOUT = 300000;
const BROWSER_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

class PuppeteerPool {
  private browser: Browser | null = null;
  private browserPromise: Promise<Browser> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private activePages = 0;

  private async createBrowser(): Promise<Browser> {
    console.log("[PuppeteerPool] Launching new browser instance...");
    const startTime = Date.now();

    const browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      headless: true,
      args: PUPPETEER_ARGS,
      protocolTimeout: PROTOCOL_TIMEOUT,
    });

    console.log(
      `[PuppeteerPool] Browser launched in ${Date.now() - startTime}ms`
    );

    browser.on("disconnected", () => {
      console.log("[PuppeteerPool] Browser disconnected");
      this.browser = null;
      this.browserPromise = null;
    });

    return browser;
  }

  async getBrowser(): Promise<Browser> {
    // Clear idle timer since we're using the browser
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    // If browser exists and is connected, return it
    if (this.browser && this.browser.connected) {
      return this.browser;
    }

    // If browser is being created, wait for it
    if (this.browserPromise) {
      return this.browserPromise;
    }

    // Create new browser
    this.browserPromise = this.createBrowser();
    this.browser = await this.browserPromise;
    this.browserPromise = null;

    return this.browser;
  }

  async getPage(): Promise<Page> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    this.activePages++;

    // Setup page defaults
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    page.setDefaultNavigationTimeout(300000);
    page.setDefaultTimeout(300000);

    return page;
  }

  async releasePage(page: Page): Promise<void> {
    try {
      if (!page.isClosed()) {
        await page.close();
      }
    } catch (error) {
      console.error("[PuppeteerPool] Error closing page:", error);
    }

    this.activePages--;

    // Set idle timer to close browser after period of inactivity
    if (this.activePages === 0) {
      this.scheduleIdleShutdown();
    }
  }

  private scheduleIdleShutdown(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(async () => {
      if (this.activePages === 0 && this.browser) {
        console.log("[PuppeteerPool] Closing idle browser...");
        try {
          await this.browser.close();
        } catch (error) {
          console.error("[PuppeteerPool] Error closing browser:", error);
        }
        this.browser = null;
        this.browserPromise = null;
      }
    }, BROWSER_IDLE_TIMEOUT);
  }

  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch (error) {
        console.error("[PuppeteerPool] Error closing browser:", error);
      }
      this.browser = null;
      this.browserPromise = null;
    }
  }

  getStats(): { activePages: number; browserConnected: boolean } {
    return {
      activePages: this.activePages,
      browserConnected: this.browser?.connected ?? false,
    };
  }
}

// Singleton instance
export const puppeteerPool = new PuppeteerPool();

// Graceful shutdown
if (typeof process !== "undefined") {
  const shutdown = async () => {
    console.log("[PuppeteerPool] Shutting down...");
    await puppeteerPool.close();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
