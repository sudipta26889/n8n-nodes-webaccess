/**
 * Crawl4AI integration strategy for Web Access node
 * Third/fourth stage in the cost-aware pipeline
 * Provides semantic search (BM25) and LLM-based extraction
 */

/* eslint-disable @n8n/community-nodes/no-restricted-globals -- setTimeout/clearTimeout needed for request timeouts */

import type { StrategyResult, CrawledPage, Crawl4AICrawlConfig } from '../utils/types';

// Default timeout for Crawl4AI requests
const DEFAULT_TIMEOUT = 60000;

// Social media domains to exclude from crawling
const SOCIAL_MEDIA_DOMAINS = [
	'facebook.com',
	'twitter.com',
	'x.com',
	'linkedin.com',
	'instagram.com',
	'pinterest.com',
	'tiktok.com',
	'snapchat.com',
	'reddit.com',
	'youtube.com',
];

/**
 * Query Crawl4AI /md endpoint for semantic search or LLM extraction
 */
export async function crawl4aiQuery(
	baseUrl: string,
	targetUrl: string,
	query: string,
	useLlm: boolean,
): Promise<StrategyResult> {
	const endpoint = `${baseUrl.replace(/\/$/, '')}/md`;

	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

		const response = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				url: targetUrl,
				f: useLlm ? 'llm' : 'bm25',
				q: query,
				c: '0',
			}),
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			return {
				success: false,
				data: null,
				error: `Crawl4AI /md request failed: ${response.status} ${response.statusText}`,
			};
		}

		const responseText = await response.text();

		// Try to parse as JSON first
		let responseData: unknown;
		try {
			responseData = JSON.parse(responseText);
		} catch {
			// Not JSON, treat as plain text
			responseData = responseText;
		}

		// Extract content from response
		let content: string;
		if (typeof responseData === 'string') {
			content = responseData;
		} else if (responseData && typeof responseData === 'object') {
			// Try common response field names
			const obj = responseData as Record<string, unknown>;
			content =
				(obj.content as string) ||
				(obj.text as string) ||
				(obj.result as string) ||
				(obj.answer as string) ||
				(obj.markdown as string) ||
				JSON.stringify(responseData);
		} else {
			content = String(responseData);
		}

		return {
			success: true,
			data: { rawContent: content },
			text: content,
		};
	} catch (error) {
		if (error instanceof Error) {
			if (error.name === 'AbortError') {
				return {
					success: false,
					data: null,
					error: `Crawl4AI request timed out after ${DEFAULT_TIMEOUT}ms`,
				};
			}
			return {
				success: false,
				data: null,
				error: `Crawl4AI request failed: ${error.message}`,
			};
		}
		return {
			success: false,
			data: null,
			error: 'Unknown Crawl4AI error',
		};
	}
}

/**
 * Crawl a website using Crawl4AI /crawl endpoint
 * Returns a list of discovered pages
 */
export async function crawl4aiCrawl(
	baseUrl: string,
	targetUrl: string,
	maxPages: number = 100,
): Promise<CrawledPage[]> {
	const endpoint = `${baseUrl.replace(/\/$/, '')}/crawl`;

	const config: Crawl4AICrawlConfig = {
		urls: [targetUrl],
		crawler_config: {
			type: 'CrawlerRunConfig',
			params: {
				scraping_strategy: {
					type: 'LXMLWebScrapingStrategy',
					params: {},
				},
				table_extraction: {
					type: 'DefaultTableExtraction',
					params: {},
				},
				exclude_social_media_domains: SOCIAL_MEDIA_DOMAINS,
				stream: true,
			},
		},
	};

	try {
		const controller = new AbortController();
		// Longer timeout for crawling
		const timeoutId = setTimeout(() => controller.abort(), 120000);

		const response = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(config),
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			console.error(`Crawl4AI /crawl request failed: ${response.status}`);
			return [];
		}

		const pages: CrawledPage[] = [];

		// Handle streaming response
		if (response.body) {
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				// Process complete lines
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (!line.trim()) continue;

					try {
						const data = JSON.parse(line);
						if (data.url) {
							pages.push({
								url: data.url,
								title: data.title || data.metadata?.title,
								snippet: data.content?.substring(0, 200) || data.text?.substring(0, 200),
							});

							if (pages.length >= maxPages) {
								reader.cancel();
								return pages;
							}
						}
					} catch {
						// Skip malformed JSON lines
					}
				}
			}

			// Process remaining buffer
			if (buffer.trim()) {
				try {
					const data = JSON.parse(buffer);
					if (data.url && pages.length < maxPages) {
						pages.push({
							url: data.url,
							title: data.title || data.metadata?.title,
							snippet: data.content?.substring(0, 200) || data.text?.substring(0, 200),
						});
					}
				} catch {
					// Skip
				}
			}
		} else {
			// Non-streaming response
			const responseText = await response.text();

			try {
				const data = JSON.parse(responseText);

				// Handle array response
				if (Array.isArray(data)) {
					for (const item of data) {
						if (item.url && pages.length < maxPages) {
							pages.push({
								url: item.url,
								title: item.title || item.metadata?.title,
								snippet: item.content?.substring(0, 200) || item.text?.substring(0, 200),
							});
						}
					}
				}
				// Handle single object response
				else if (data.url) {
					pages.push({
						url: data.url,
						title: data.title || data.metadata?.title,
						snippet: data.content?.substring(0, 200) || data.text?.substring(0, 200),
					});
				}
				// Handle wrapped response
				else if (data.results && Array.isArray(data.results)) {
					for (const item of data.results) {
						if (item.url && pages.length < maxPages) {
							pages.push({
								url: item.url,
								title: item.title || item.metadata?.title,
								snippet: item.content?.substring(0, 200) || item.text?.substring(0, 200),
							});
						}
					}
				}
			} catch {
				// Response wasn't JSON
			}
		}

		return pages;
	} catch (error) {
		if (error instanceof Error) {
			console.error(`Crawl4AI crawl error: ${error.message}`);
		}
		return [];
	}
}

/**
 * Check if Crawl4AI service is available
 */
export async function isCrawl4AIAvailable(baseUrl: string): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 5000);

		const response = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, {
			method: 'GET',
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		return response.ok;
	} catch {
		return false;
	}
}
