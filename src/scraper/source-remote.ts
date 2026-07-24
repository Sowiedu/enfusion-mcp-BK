import { chromium, type Page } from "playwright";
import { logger } from "../utils/logger.js";

const BASE_URL = "https://community.bistudio.com/wikidata/external-data/arma-reforger";
const SUBDIR = {
  enfusion: "EnfusionScriptAPIPublic",
  arma: "ArmaReforgerScriptAPIPublic",
} as const;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CHALLENGE_TITLE = /just a moment|attention required|verifying/i;
const CHALLENGE_BODY = /Just a moment|cf-browser-verification|challenge-platform/i;
const CLEARANCE_TIMEOUT_MS = 30_000;

export type ApiSource = "enfusion" | "arma";

export interface RemoteFetcher {
  get(source: ApiSource, filename: string): Promise<string | null>;
  close(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForClearance(page: Page): Promise<boolean> {
  const deadline = Date.now() + CLEARANCE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const title = await page.title();
      if (!CHALLENGE_TITLE.test(title)) {
        return true;
      }
    } catch (error) {
      logger.warn(`Failed to check Cloudflare clearance: ${error}`);
      return false;
    }

    await delay(1_000);
  }

  return false;
}

async function solveChallenge(page: Page, url: string): Promise<boolean> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (error) {
    logger.warn(`Failed to open ${url} in browser: ${error}`);
    return false;
  }

  return waitForClearance(page);
}

export async function createRemoteFetcher(): Promise<RemoteFetcher> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();
  const primeUrl = `${BASE_URL}/${SUBDIR.arma}/index.html`;

  if (!(await solveChallenge(page, primeUrl))) {
    logger.warn("Cloudflare clearance was not confirmed while priming the remote scraper");
  }

  return {
    async get(source: ApiSource, filename: string): Promise<string | null> {
      const url = `${BASE_URL}/${SUBDIR[source]}/${filename}`;

      for (let attempt = 1; attempt <= 3; attempt++) {
        let needsClearance = false;

        try {
          const response = await context.request.get(url, { timeout: 30_000 });

          if (response.status() === 404) {
            return null;
          }

          if (response.ok()) {
            const body = await response.text();
            if (!CHALLENGE_BODY.test(body)) {
              return body;
            }
            needsClearance = true;
          } else if (response.status() === 403 || response.status() === 503) {
            needsClearance = true;
          }
        } catch (error) {
          logger.warn(`Failed to fetch ${url} (attempt ${attempt}/3): ${error}`);
        }

        if (needsClearance && !(await solveChallenge(page, url))) {
          logger.warn(`Cloudflare clearance was not confirmed for ${url}`);
        }
      }

      logger.warn(`Failed to fetch ${url} after 3 attempts`);
      return null;
    },

    async close(): Promise<void> {
      await browser.close();
    },
  };
}
