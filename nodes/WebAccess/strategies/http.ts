/**
 * HTTP-based fetching strategy for Web Access node
 * First stage in the cost-aware pipeline
 */

/* eslint-disable @n8n/community-nodes/no-restricted-globals -- setTimeout/clearTimeout needed for request timeouts */

import type { StrategyResult, HttpFetchOptions } from '../utils/types';
import { extractTextContent, isBlockedContent } from '../utils/extraction';

// Default timeout in milliseconds
const DEFAULT_TIMEOUT = 30000;

// Default user agent
const DEFAULT_USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Fetch a URL using HTTP and return the HTML content
 * Handles redirects, timeouts, and common error codes
 */
export async function httpFetch(url: string, options: HttpFetchOptions = {}): Promise<StrategyResult> {
	const { timeout = DEFAULT_TIMEOUT, userAgent = DEFAULT_USER_AGENT } = options;

	try {
		// Create abort controller for timeout
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeout);

		const response = await fetch(url, {
			method: 'GET',
			headers: {
				'User-Agent': userAgent,
				Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
				'Accept-Language': 'en-US,en;q=0.5',
				'Accept-Encoding': 'gzip, deflate',
				Connection: 'keep-alive',
				'Upgrade-Insecure-Requests': '1',
			},
			redirect: 'follow',
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		// Check for error status codes
		if (!response.ok) {
			if (response.status === 403) {
				return {
					success: false,
					data: null,
					error: 'Access forbidden (403) - site may be blocking automated requests',
				};
			}
			if (response.status === 429) {
				return {
					success: false,
					data: null,
					error: 'Rate limited (429) - too many requests',
				};
			}
			if (response.status === 404) {
				return {
					success: false,
					data: null,
					error: 'Page not found (404)',
				};
			}
			return {
				success: false,
				data: null,
				error: `HTTP error: ${response.status} ${response.statusText}`,
			};
		}

		// Get content type
		const contentType = response.headers.get('content-type') || '';

		// Check if it's HTML
		if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
			return {
				success: false,
				data: null,
				error: `Non-HTML content type: ${contentType}`,
			};
		}

		// Get HTML content
		const html = await response.text();

		// Check if content is blocked/empty
		if (!html || html.trim().length === 0) {
			return {
				success: false,
				data: null,
				error: 'Empty response body',
			};
		}

		if (isBlockedContent(html)) {
			return {
				success: false,
				data: null,
				html,
				error: 'Content appears to be blocked (CAPTCHA, rate limit, etc.)',
			};
		}

		// Extract text content
		const text = extractTextContent(html);

		return {
			success: true,
			data: null, // Data will be populated by the caller based on task
			html,
			text,
		};
	} catch (error) {
		// Handle specific error types
		if (error instanceof Error) {
			if (error.name === 'AbortError') {
				return {
					success: false,
					data: null,
					error: `Request timed out after ${timeout}ms`,
				};
			}
			if (error.message.includes('ENOTFOUND') || error.message.includes('getaddrinfo')) {
				return {
					success: false,
					data: null,
					error: 'Domain not found - check the URL',
				};
			}
			if (error.message.includes('ECONNREFUSED')) {
				return {
					success: false,
					data: null,
					error: 'Connection refused by server',
				};
			}
			if (error.message.includes('certificate') || error.message.includes('SSL')) {
				return {
					success: false,
					data: null,
					error: 'SSL/TLS certificate error',
				};
			}
			return {
				success: false,
				data: null,
				error: `HTTP fetch failed: ${error.message}`,
			};
		}

		return {
			success: false,
			data: null,
			error: 'Unknown HTTP fetch error',
		};
	}
}

/**
 * Download a binary asset via HTTP
 * Returns the buffer and mime type
 */
export async function downloadAsset(
	url: string,
	options: HttpFetchOptions = {},
): Promise<{ buffer: Buffer; mimeType: string } | null> {
	const { timeout = DEFAULT_TIMEOUT, userAgent = DEFAULT_USER_AGENT } = options;

	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeout);

		const response = await fetch(url, {
			method: 'GET',
			headers: {
				'User-Agent': userAgent,
			},
			redirect: 'follow',
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			return null;
		}

		const arrayBuffer = await response.arrayBuffer();
		const buffer = Buffer.from(arrayBuffer);
		const mimeType = response.headers.get('content-type') || 'application/octet-stream';

		return { buffer, mimeType };
	} catch {
		return null;
	}
}
