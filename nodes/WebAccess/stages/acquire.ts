/**
 * Stage 1: Content Acquisition
 * 
 * Acquires web content using a fallback chain of strategies:
 * 1. HTTP fetch (fastest, cheapest)
 * 2. FlareSolverr (if HTTP fails due to Cloudflare)
 * 3. Puppeteer (for JS rendering or as final fallback)
 */

import { httpFetch } from '../strategies/http';
import { flareSolverrFetch } from '../strategies/flaresolverr';
import { getPageContent, closeBrowser } from '../strategies/puppeteer';
import { validateUrl } from '../utils/extraction';

/**
 * Represents acquired content from a URL.
 */
export interface AcquiredContent {
	/** The URL that was scraped */
	url: string;
	/** Raw HTML content */
	html: string;
	/** Extracted text content */
	text: string;
	/** Method used to acquire content */
	method: 'http' | 'flaresolverr' | 'puppeteer';
	/** Time taken to acquire content in milliseconds */
	scrapeTime: number;
	/** Whether acquisition was successful */
	success: boolean;
	/** Error message if acquisition failed */
	error?: string;
}

/**
 * Options for content acquisition.
 */
export interface AcquireOptions {
	/** FlareSolverr service URL (optional) */
	flareSolverrUrl?: string;
	/** Whether to skip FlareSolverr even if configured */
	skipFlareSolverr?: boolean;
	/** Whether to skip Puppeteer */
	skipPuppeteer?: boolean;
	/** Preferred method to start with */
	preferredMethod?: 'http' | 'flaresolverr' | 'puppeteer';
}

/**
 * Acquire content from a URL using fallback chain.
 * 
 * Tries HTTP first (fastest), then FlareSolverr (if configured and needed),
 * then Puppeteer (for JS rendering).
 * 
 * @param {string} url - URL to acquire content from
 * @param {AcquireOptions} options - Acquisition options
 * @returns {Promise<AcquiredContent>} Acquired content with metadata
 */
export async function acquireContent(
	url: string,
	options: AcquireOptions = {},
): Promise<AcquiredContent> {
	const startTime = Date.now();

	// Validate URL first
	const urlValidation = validateUrl(url);
	if (!urlValidation.valid) {
		return {
			url,
			html: '',
			text: '',
			method: 'http',
			scrapeTime: Date.now() - startTime,
			success: false,
			error: urlValidation.error || 'Invalid URL',
		};
	}

	const { flareSolverrUrl, skipFlareSolverr, skipPuppeteer, preferredMethod } = options;

	// If a specific method is preferred, try it first
	if (preferredMethod) {
		const result = await tryMethod(url, preferredMethod, flareSolverrUrl);
		if (result.success) {
			return {
				...result,
				scrapeTime: Date.now() - startTime,
			};
		}
	}

	// Stage 1: Try HTTP fetch (fastest, cheapest)
	if (preferredMethod !== 'http') {
		const httpResult = await tryMethod(url, 'http', flareSolverrUrl);
		if (httpResult.success) {
			return {
				...httpResult,
				scrapeTime: Date.now() - startTime,
			};
		}

		// Stage 2: Try FlareSolverr if configured
		// Try FlareSolverr whenever HTTP fails (not just on blocked patterns)
		// FlareSolverr handles Cloudflare, rate limits, and other protections
		if (!skipFlareSolverr && flareSolverrUrl) {
			const flareResult = await tryMethod(url, 'flaresolverr', flareSolverrUrl);
			if (flareResult.success) {
				return {
					...flareResult,
					scrapeTime: Date.now() - startTime,
				};
			}
		}
	}

	// Stage 3: Try Puppeteer as final fallback
	if (!skipPuppeteer && preferredMethod !== 'puppeteer') {
		const puppeteerResult = await tryMethod(url, 'puppeteer', flareSolverrUrl);
		return {
			...puppeteerResult,
			scrapeTime: Date.now() - startTime,
		};
	}

	// All methods failed
	return {
		url,
		html: '',
		text: '',
		method: 'http',
		scrapeTime: Date.now() - startTime,
		success: false,
		error: 'All acquisition methods failed',
	};
}

/**
 * Try a specific acquisition method.
 * 
 * @param {string} url - URL to fetch
 * @param {'http' | 'flaresolverr' | 'puppeteer'} method - Method to use
 * @param {string} [flareSolverrUrl] - FlareSolverr URL if using that method
 * @returns {Promise<AcquiredContent>} Result of the attempt
 */
async function tryMethod(
	url: string,
	method: 'http' | 'flaresolverr' | 'puppeteer',
	flareSolverrUrl?: string,
): Promise<Omit<AcquiredContent, 'scrapeTime'>> {
	try {
		switch (method) {
			case 'http': {
				const result = await httpFetch(url);
				if (result.success && result.html) {
					return {
						url,
						html: result.html,
						text: result.text || '',
						method: 'http',
						success: true,
					};
				}
				return {
					url,
					html: result.html || '',
					text: result.text || '',
					method: 'http',
					success: false,
					error: result.error || 'HTTP fetch returned no content',
				};
			}

			case 'flaresolverr': {
				if (!flareSolverrUrl) {
					return {
						url,
						html: '',
						text: '',
						method: 'flaresolverr',
						success: false,
						error: 'FlareSolverr URL not configured',
					};
				}
				const result = await flareSolverrFetch(url, flareSolverrUrl);
				if (result.success && result.html) {
					return {
						url,
						html: result.html,
						text: result.text || '',
						method: 'flaresolverr',
						success: true,
					};
				}
				return {
					url,
					html: result.html || '',
					text: result.text || '',
					method: 'flaresolverr',
					success: false,
					error: result.error || 'FlareSolverr returned no content',
				};
			}

			case 'puppeteer': {
				const result = await getPageContent(url);
				return {
					url,
					html: result.html,
					text: result.text,
					method: 'puppeteer',
					success: true,
				};
			}

			default:
				return {
					url,
					html: '',
					text: '',
					method: 'http',
					success: false,
					error: `Unknown method: ${method}`,
				};
		}
	} catch (error) {
		return {
			url,
			html: '',
			text: '',
			method,
			success: false,
			error: error instanceof Error ? error.message : 'Unknown error',
		};
	}
}

/**
 * Acquire content from multiple URLs.
 * 
 * @param {string[]} urls - URLs to acquire content from
 * @param {AcquireOptions} options - Acquisition options
 * @returns {Promise<Map<string, AcquiredContent>>} Map of URL to acquired content
 */
export async function acquireMultipleContent(
	urls: string[],
	options: AcquireOptions = {},
): Promise<Map<string, AcquiredContent>> {
	const results = new Map<string, AcquiredContent>();

	for (const url of urls) {
		const content = await acquireContent(url, options);
		results.set(url, content);
	}

	return results;
}

/**
 * Clean up resources after content acquisition.
 * 
 * Should be called after all content acquisition is complete.
 */
export async function cleanupAcquisition(): Promise<void> {
	await closeBrowser();
}

