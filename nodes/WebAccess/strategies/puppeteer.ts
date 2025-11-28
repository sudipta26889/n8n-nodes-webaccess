/**
 * Puppeteer-based browser automation strategy for Web Access node
 * Second stage in the cost-aware pipeline, used for JS-heavy pages
 */

/* eslint-disable @n8n/community-nodes/no-restricted-globals -- setTimeout needed for animation settling */
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports -- Required for browser automation in self-hosted deployments
import puppeteer, { type Browser, type Page } from 'puppeteer';
import type { PuppeteerPageContent, PuppeteerOptions } from '../utils/types';

// Declare browser globals for page.evaluate() contexts
// These don't exist in Node.js but are available when code runs in browser
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const document: any;
declare const window: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

// Default timeout in milliseconds
const DEFAULT_TIMEOUT = 45000;

// Singleton browser instance for reuse
let browserInstance: Browser | null = null;

/**
 * Get or create a browser instance
 */
async function getBrowser(): Promise<Browser> {
	if (browserInstance && browserInstance.connected) {
		return browserInstance;
	}

	browserInstance = await puppeteer.launch({
		headless: true,
		args: [
			'--no-sandbox',
			'--disable-setuid-sandbox',
			'--disable-dev-shm-usage',
			'--disable-accelerated-2d-canvas',
			'--disable-gpu',
			'--window-size=1920,1080',
		],
	});

	return browserInstance;
}

/**
 * Close the browser instance
 */
export async function closeBrowser(): Promise<void> {
	if (browserInstance) {
		await browserInstance.close();
		browserInstance = null;
	}
}

/**
 * Create a new page with standard configuration
 */
async function createPage(browser: Browser, timeout: number): Promise<Page> {
	const page = await browser.newPage();

	// Set viewport
	await page.setViewport({ width: 1920, height: 1080 });

	// Set user agent
	await page.setUserAgent(
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	);

	// Set default timeout
	page.setDefaultTimeout(timeout);
	page.setDefaultNavigationTimeout(timeout);

	// Block unnecessary resources to speed up loading
	await page.setRequestInterception(true);
	page.on('request', (request) => {
		const resourceType = request.resourceType();
		// Block fonts and some media to speed up
		if (['font'].includes(resourceType)) {
			request.abort();
		} else {
			request.continue();
		}
	});

	return page;
}

/**
 * Get page content (HTML and visible text) using Puppeteer
 */
export async function getPageContent(
	url: string,
	options: PuppeteerOptions = {},
): Promise<PuppeteerPageContent> {
	const { timeout = DEFAULT_TIMEOUT, waitUntil = 'networkidle2' } = options;

	const browser = await getBrowser();
	const page = await createPage(browser, timeout);

	try {
		// Navigate to page
		await page.goto(url, {
			waitUntil,
			timeout,
		});

		// Get HTML content
		const html = await page.content();

		// Get visible text (runs in browser context)
		const text = await page.evaluate(() => {
			return document.body?.innerText || '';
		});

		return { html, text };
	} finally {
		await page.close();
	}
}

/**
 * Capture a screenshot of the page
 */
export async function captureScreenshot(
	url: string,
	fullPage: boolean,
	options: PuppeteerOptions = {},
): Promise<Buffer> {
	const { timeout = DEFAULT_TIMEOUT, waitUntil = 'networkidle2' } = options;

	const browser = await getBrowser();
	const page = await createPage(browser, timeout);

	try {
		// Navigate to page
		await page.goto(url, {
			waitUntil,
			timeout,
		});

		// Wait a bit for any animations to settle
		await new Promise((resolve) => setTimeout(resolve, 1000));

		// Take screenshot
		const screenshot = await page.screenshot({
			fullPage,
			type: 'png',
		});

		// Ensure we return a Buffer
		return Buffer.from(screenshot);
	} finally {
		await page.close();
	}
}

/**
 * Run a custom script in the page context
 */
export async function runPageScript<T = unknown>(
	url: string,
	scriptBody: string,
	options: PuppeteerOptions = {},
): Promise<T> {
	const { timeout = DEFAULT_TIMEOUT, waitUntil = 'networkidle2' } = options;

	const browser = await getBrowser();
	const page = await createPage(browser, timeout);

	try {
		// Navigate to page
		await page.goto(url, {
			waitUntil,
			timeout,
		});

		// Execute the script in the browser context
		const result = await page.evaluate((script: string) => {
			// Build pageContext object (runs in browser context)
			const pageContext = {
				location: window.location.href,
				html: document.documentElement?.outerHTML || '',
				text: document.body?.innerText || '',
			};

			// Create and execute the function
			const fn = new Function('pageContext', script);
			return fn(pageContext);
		}, scriptBody);

		return result as T;
	} finally {
		await page.close();
	}
}

/**
 * Check if Puppeteer is available and working
 */
export async function isPuppeteerAvailable(): Promise<boolean> {
	try {
		const browser = await getBrowser();
		return browser.connected;
	} catch {
		return false;
	}
}
