/**
 * Puppeteer-based browser automation strategy for Web Access node
 * Second stage in the cost-aware pipeline, used for JS-heavy pages
 */

/* eslint-disable @n8n/community-nodes/no-restricted-globals -- setTimeout needed for animation settling */
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports -- Required for browser automation in self-hosted deployments
import puppeteer, { type Browser, type Page } from 'puppeteer';
import type { PuppeteerPageContent, PuppeteerOptions } from '../utils/types';
import { DEFAULT_PUPPETEER_TIMEOUT } from '../utils/config';

// Declare browser globals for page.evaluate() contexts
// These don't exist in Node.js but are available when code runs in browser
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const document: any;
declare const window: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

// Default timeout in milliseconds
const DEFAULT_TIMEOUT = DEFAULT_PUPPETEER_TIMEOUT;

// Default headless mode - run headless unless explicitly disabled via env
const DEFAULT_HEADLESS = process.env.PUPPETEER_HEADLESS
	? process.env.PUPPETEER_HEADLESS === 'true'
	: true;

// Singleton browser instance for reuse
let browserInstance: Browser | null = null;

/**
 * Get or create a browser instance.
 * 
 * Creates a Puppeteer browser instance with appropriate configuration.
 * Browser is reused across requests for better performance.
 * 
 * @returns {Promise<Browser>} A Puppeteer browser instance
 */
async function getBrowser(): Promise<Browser> {
	if (browserInstance && browserInstance.connected) {
		return browserInstance;
	}

	browserInstance = await puppeteer.launch({
		headless: DEFAULT_HEADLESS,
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
 * Close the browser instance.
 * 
 * Properly closes the browser and cleans up resources.
 * Should be called when done with browser operations.
 * 
 * @returns {Promise<void>} Promise that resolves when browser is closed
 */
export async function closeBrowser(): Promise<void> {
	if (browserInstance) {
		try {
			await browserInstance.close();
		} catch {
			// Ignore errors during cleanup
		} finally {
			browserInstance = null;
		}
	}
}

/**
 * Create a new page with standard configuration.
 * 
 * Sets up viewport, user agent, timeouts, and request interception
 * for optimal page loading and resource management.
 * 
 * @param {Browser} browser - The Puppeteer browser instance
 * @param {number} timeout - Timeout in milliseconds for page operations
 * @returns {Promise<Page>} A configured Puppeteer page instance
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
		const action =
			['font'].includes(resourceType) ? request.abort() : request.continue();
		// Ignore failures that occur when the page is already closed
		void action.catch(() => {});
	});

	return page;
}

/**
 * Get page content (HTML and visible text) using Puppeteer.
 * 
 * Navigates to the URL, waits for page to load, and extracts
 * both HTML and visible text content.
 * 
 * @param {string} url - The URL to fetch content from
 * @param {PuppeteerOptions} options - Optional configuration (timeout, waitUntil)
 * @returns {Promise<PuppeteerPageContent>} Object containing html and text content
 * @throws {Error} If navigation fails or timeout is exceeded
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
 * Capture a screenshot of the page.
 * 
 * Navigates to the URL and captures a screenshot, optionally
 * including the full scrollable page.
 * 
 * @param {string} url - The URL to screenshot
 * @param {boolean} fullPage - Whether to capture full scrollable page
 * @param {PuppeteerOptions} options - Optional configuration (timeout, waitUntil)
 * @returns {Promise<Buffer>} PNG image buffer
 * @throws {Error} If navigation fails or screenshot capture fails
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
 * Run a custom script in the page context.
 * 
 * Navigates to the URL and executes a user-provided JavaScript script
 * in the browser context. The script receives a pageContext object
 * with location, html, and text properties.
 * 
 * @param {string} url - The URL to navigate to
 * @param {string} scriptBody - JavaScript code to execute
 * @param {PuppeteerOptions} options - Optional configuration (timeout, waitUntil)
 * @returns {Promise<T>} The result of script execution
 * @throws {Error} If navigation fails, script execution fails, or script is invalid
 */
export async function runPageScript<T = unknown>(
	url: string,
	scriptBody: string,
	options: PuppeteerOptions = {},
): Promise<T> {
	const { timeout = DEFAULT_TIMEOUT, waitUntil = 'networkidle2' } = options;

	// Validate script input
	if (!scriptBody || typeof scriptBody !== 'string' || scriptBody.trim().length === 0) {
		throw new Error('Script body must be a non-empty string');
	}

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
	} catch (error) {
		if (error instanceof Error) {
			throw new Error(`Script execution failed: ${error.message}`);
		}
		throw error;
	} finally {
		await page.close();
	}
}

/**
 * Check if Puppeteer is available and working.
 * 
 * Attempts to create a browser instance to verify Puppeteer
 * is properly installed and configured.
 * 
 * @returns {Promise<boolean>} True if Puppeteer is available, false otherwise
 */
export async function isPuppeteerAvailable(): Promise<boolean> {
	try {
		const browser = await getBrowser();
		return browser.connected;
	} catch {
		return false;
	}
}
