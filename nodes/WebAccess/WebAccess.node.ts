import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IBinaryData,
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchResult,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports -- Required for asset bundling in self-hosted deployments
import JSZip from 'jszip';

// Import strategies
import { httpFetch, downloadAsset } from './strategies/http';
import { getPageContent, captureScreenshot, runPageScript, closeBrowser } from './strategies/puppeteer';
import { crawl4aiQuery, crawl4aiCrawl } from './strategies/crawl4ai';
import { openaiExtract, openaiExtractContacts } from './strategies/openai';
import { flareSolverrFetch } from './strategies/flaresolverr';

// Import utilities
import type {
	WebAccessResultJson,
	WebAccessMeta,
	ProcessUrlContext,
	TaskIntent,
	CrawledPage,
	ProductSummary,
	AssetType,
	OpenAIConfig,
} from './utils/types';
import {
	extractEmails,
	extractPhones,
	extractTextContent,
	extractPageTitle,
	extractProductsFromHtml,
	extractAssetUrls,
	getContactPageUrls,
	validateUrl,
} from './utils/extraction';
import {
	inferOperation,
	getFallbackOperations,
	inferTaskIntent,
	generateSubTask,
	scorePageForIntent,
	wantsFullPageScreenshot,
	getAssetTypeFromTask,
} from './utils/taskIntent';
import {
	MAX_ASSETS,
	MAX_CRAWL_CANDIDATES,
	MAX_PRODUCTS,
} from './utils/config';

/**
 * Extract data based on task intent.
 * 
 * Analyzes the task intent and extracts relevant data from HTML and text.
 * Supports email, phone, text dump, and product list extraction.
 * 
 * @param {string} html - HTML content to extract from
 * @param {string} text - Plain text content to extract from
 * @param {TaskIntent} intent - Task intent indicating what to extract
 * @returns {{ success: boolean; data: Record<string, unknown> | null }} Extraction result
 */
function extractByIntent(
	html: string,
	text: string,
	intent: TaskIntent,
): { success: boolean; data: Record<string, unknown> | null } {
	const data: Record<string, unknown> = {};
	let hasData = false;

	// Extract emails
	if (intent.wantsEmail) {
		const emails = extractEmails(html);
		if (emails.length > 0) {
			data.emails = emails;
			data.pageTitle = extractPageTitle(html);
			hasData = true;
		}
	}

	// Extract phones
	if (intent.wantsPhone) {
		const phones = extractPhones(text);
		if (phones.length > 0) {
			data.phones = phones;
			if (!data.pageTitle) data.pageTitle = extractPageTitle(html);
			hasData = true;
		}
	}

	// Extract text dump
	if (intent.wantsTextDump) {
		if (text && text.length > 0) {
			data.text = text;
			data.pageTitle = extractPageTitle(html);
			hasData = true;
		}
	}

	// Extract products
	if (intent.wantsProductList) {
		const products = extractProductsFromHtml(html);
		if (products.length > 0) {
			data.products = products;
			hasData = true;
		}
	}

	return {
		success: hasData,
		data: hasData ? data : null,
	};
}

/**
 * Handle fetchContent operation.
 * 
 * Implements a cost-aware pipeline that tries multiple strategies in order:
 * 1. HTTP fetch (fastest, cheapest)
 * 2. FlareSolverr (if configured, for Cloudflare bypass)
 * 3. Puppeteer (for JS-heavy pages)
 * 4. Crawl4AI BM25 (semantic search, no LLM)
 * 5. LLM extraction (Crawl4AI or OpenAI-compatible, most expensive)
 * 
 * @param {string} url - URL to fetch content from
 * @param {string} task - Task description for extraction
 * @param {boolean} useAI - Whether to allow LLM extraction
 * @param {string} crawl4aiBaseUrl - Crawl4AI service base URL
 * @param {WebAccessMeta} meta - Metadata object to track used strategies
 * @param {string} [aiProvider] - AI provider ('crawl4ai' or 'openai-compatible')
 * @param {string} [aiModel] - AI model name
 * @param {OpenAIConfig} [openAiConfig] - OpenAI-compatible API configuration
 * @param {string} [flareSolverrUrl] - FlareSolverr service URL
 * @returns {Promise<{ json: WebAccessResultJson }>} Result with extracted data
 */
async function handleFetchContent(
	url: string,
	task: string,
	useAI: boolean,
	crawl4aiBaseUrl: string,
	meta: WebAccessMeta,
	aiProvider?: string,
	aiModel?: string,
	openAiConfig?: OpenAIConfig,
	flareSolverrUrl?: string,
): Promise<{ json: WebAccessResultJson }> {
	// Validate URL
	const urlValidation = validateUrl(url);
	if (!urlValidation.valid) {
		return {
			json: {
				url,
				operation: 'fetchContent',
				task,
				success: false,
				data: null,
				error: urlValidation.error || 'Invalid URL',
				meta,
			},
		};
	}

	const intent = inferTaskIntent(task, 'fetchContent');
	let html = '';
	let text = '';
	let wasCloudflareBlocked = false;

	// Stage 1: Try HTTP fetch
	const httpResult = await httpFetch(url);
	if (httpResult.success && httpResult.html) {
		meta.usedHttp = true;
		html = httpResult.html;
		text = httpResult.text || extractTextContent(html);

		// Try to extract based on intent
		const extracted = extractByIntent(html, text, intent);
		if (extracted.success) {
			return {
				json: {
					url,
					operation: 'fetchContent',
					task,
					success: true,
					data: extracted.data,
					meta,
				},
			};
		}
	} else if (httpResult.error?.includes('blocked') || httpResult.error?.includes('CAPTCHA')) {
		wasCloudflareBlocked = true;
	}

	// Stage 1.5: If blocked and FlareSolverr is configured, try it
	if (flareSolverrUrl && (wasCloudflareBlocked || !httpResult.success)) {
		const flareResult = await flareSolverrFetch(url, flareSolverrUrl);
		if (flareResult.success && flareResult.html) {
			meta.usedFlareSolverr = true;
			html = flareResult.html;
			text = flareResult.text || extractTextContent(html);

			const extracted = extractByIntent(html, text, intent);
			if (extracted.success) {
				return {
					json: {
						url,
						operation: 'fetchContent',
						task,
						success: true,
						data: extracted.data,
						meta,
					},
				};
			}
		}
	}

	// Stage 2: Try Puppeteer
	try {
		const puppeteerResult = await getPageContent(url);
		meta.usedPuppeteer = true;
		html = puppeteerResult.html;
		text = puppeteerResult.text;

		const extracted = extractByIntent(html, text, intent);
		if (extracted.success) {
			return {
				json: {
					url,
					operation: 'fetchContent',
					task,
					success: true,
					data: extracted.data,
					meta,
				},
			};
		}
	} catch {
		// Puppeteer failed, continue to next stage
	}

	// Stage 3: Try Crawl4AI BM25 (non-LLM)
	const bm25Result = await crawl4aiQuery(crawl4aiBaseUrl, url, task, false);
	if (bm25Result.success && bm25Result.text) {
		meta.usedCrawl4ai = true;

		const extracted = extractByIntent(bm25Result.text, bm25Result.text, intent);
		if (extracted.success) {
			return {
				json: {
					url,
					operation: 'fetchContent',
					task,
					success: true,
					data: extracted.data,
					meta,
				},
			};
		}
	}

	// Stage 4: Try LLM extraction (only if useAI is true)
	if (useAI) {
		// Use OpenAI-compatible API if configured
		if (aiProvider === 'openai-compatible' && openAiConfig && aiModel) {
			meta.aiProvider = 'openai-compatible';
			meta.aiModel = aiModel;

			// Use page text for LLM extraction
			const contentForLlm = text || extractTextContent(html);

			// For contact extraction, use specialized function
			if (intent.wantsEmail || intent.wantsPhone) {
				const contactResult = await openaiExtractContacts(
					openAiConfig,
					aiModel,
					contentForLlm,
					!!intent.wantsEmail,
					!!intent.wantsPhone,
				);

				if (contactResult.error) {
					meta.llmError = contactResult.error;
				}

				if (contactResult.emails?.length || contactResult.phones?.length) {
					const data: Record<string, unknown> = { pageTitle: extractPageTitle(html) };
					if (contactResult.emails?.length) data.emails = contactResult.emails;
					if (contactResult.phones?.length) data.phones = contactResult.phones;

					return {
						json: {
							url,
							operation: 'fetchContent',
							task,
							success: true,
							data,
							meta,
						},
					};
				}
			}

			// General extraction
			const llmResult = await openaiExtract(openAiConfig, aiModel, contentForLlm, task);
			if (llmResult.error) {
				meta.llmError = llmResult.error;
			}
			if (llmResult.success && llmResult.text) {
				return {
					json: {
						url,
						operation: 'fetchContent',
						task,
						success: true,
						data: {
							rawAnswer: llmResult.text,
							pageTitle: extractPageTitle(html),
						},
						meta,
					},
				};
			}
		} else {
			// Fall back to Crawl4AI LLM
			const llmResult = await crawl4aiQuery(crawl4aiBaseUrl, url, task, true);
			if (llmResult.success && llmResult.text) {
				meta.usedCrawl4aiLlm = true;

				// Try extraction from LLM response
				const extracted = extractByIntent(llmResult.text, llmResult.text, intent);
				if (extracted.success) {
					return {
						json: {
							url,
							operation: 'fetchContent',
							task,
							success: true,
							data: extracted.data,
							meta,
						},
					};
				}

				// Return raw LLM answer
				return {
					json: {
						url,
						operation: 'fetchContent',
						task,
						success: true,
						data: {
							rawAnswer: llmResult.text,
							pageTitle: extractPageTitle(html),
						},
						meta,
					},
				};
			}
		}
	}

	// All stages failed
	return {
		json: {
			url,
			operation: 'fetchContent',
			task,
			success: false,
			data: null,
			error: 'Could not satisfy task from page content.',
			meta,
		},
	};
}

/**
 * Handle screenshot operation.
 * 
 * Captures a screenshot of the specified URL using Puppeteer.
 * Supports both viewport and full-page screenshots.
 * 
 * @param {string} url - URL to screenshot
 * @param {string} task - Task description (may indicate full page)
 * @param {WebAccessMeta} meta - Metadata object to track used strategies
 * @returns {Promise<{ json: WebAccessResultJson; binary?: Record<string, IBinaryData> }>} Result with screenshot binary data
 */
async function handleScreenshot(
	url: string,
	task: string,
	meta: WebAccessMeta,
): Promise<{ json: WebAccessResultJson; binary?: Record<string, IBinaryData> }> {
	// Validate URL
	const urlValidation = validateUrl(url);
	if (!urlValidation.valid) {
		return {
			json: {
				url,
				operation: 'screenshot',
				task,
				success: false,
				data: null,
				error: urlValidation.error || 'Invalid URL',
				meta,
			},
		};
	}

	const fullPage = wantsFullPageScreenshot(task);
	meta.usedPuppeteer = true;

	try {
		const screenshotBuffer = await captureScreenshot(url, fullPage);

		return {
			json: {
				url,
				operation: 'screenshot',
				task,
				success: true,
				data: {
					fullPage,
				},
				meta,
			},
			binary: {
				screenshot: {
					data: screenshotBuffer.toString('base64'),
					mimeType: 'image/png',
					fileName: 'screenshot.png',
				},
			},
		};
	} catch (error) {
		return {
			json: {
				url,
				operation: 'screenshot',
				task,
				success: false,
				data: null,
				error: `Failed to capture screenshot: ${error instanceof Error ? error.message : 'Unknown error'}`,
				meta,
			},
		};
	}
}

/**
 * Handle downloadAssets operation.
 * 
 * Downloads assets (PDFs, images, CSV files) from a webpage.
 * Supports multi-page crawling when assets aren't found on the initial page.
 * 
 * @param {string} url - URL to download assets from
 * @param {string} task - Task description indicating asset type
 * @param {string} crawl4aiBaseUrl - Crawl4AI service base URL
 * @param {WebAccessMeta} meta - Metadata object to track used strategies
 * @returns {Promise<{ json: WebAccessResultJson; binary?: Record<string, IBinaryData> }>} Result with downloaded assets
 */
async function handleDownloadAssets(
	url: string,
	task: string,
	crawl4aiBaseUrl: string,
	meta: WebAccessMeta,
): Promise<{ json: WebAccessResultJson; binary?: Record<string, IBinaryData> }> {
	// Validate URL
	const urlValidation = validateUrl(url);
	if (!urlValidation.valid) {
		return {
			json: {
				url,
				operation: 'downloadAssets',
				task,
				success: false,
				data: null,
				error: urlValidation.error || 'Invalid URL',
				meta,
			},
		};
	}

	const assetType = getAssetTypeFromTask(task) || 'pdf';
	const allAssetUrls: string[] = [];
	const seenUrls = new Set<string>();
	let html = '';

	// STEP 1: Try the initial page
	const httpResult = await httpFetch(url);
	if (httpResult.success && httpResult.html) {
		meta.usedHttp = true;
		html = httpResult.html;
	} else {
		// Try Puppeteer if HTTP failed
		try {
			const puppeteerResult = await getPageContent(url);
			meta.usedPuppeteer = true;
			html = puppeteerResult.html;
		} catch {
			return {
				json: {
					url,
					operation: 'downloadAssets',
					task,
					success: false,
					data: null,
					error: 'Could not fetch page content to find assets.',
					meta,
				},
			};
		}
	}

	// Extract asset URLs from initial page
	const initialAssets = extractAssetUrls(html, url, assetType as AssetType);
	for (const assetUrl of initialAssets) {
		if (!seenUrls.has(assetUrl)) {
			seenUrls.add(assetUrl);
			allAssetUrls.push(assetUrl);
		}
	}

	// STEP 2: If no assets found on initial page, try crawling
	if (allAssetUrls.length === 0) {
		meta.usedCrawl4ai = true;
		const crawledPages = await crawl4aiCrawl(crawl4aiBaseUrl, url);

		// Check up to 10 crawled pages for assets
		const pagesToCheck = crawledPages.slice(0, 10);

		for (const page of pagesToCheck) {
			let pageHtml = '';

			// Fetch page content
			const pageHttpResult = await httpFetch(page.url);
			if (pageHttpResult.success && pageHttpResult.html) {
				pageHtml = pageHttpResult.html;
			} else {
				try {
					const pagePuppeteerResult = await getPageContent(page.url);
					pageHtml = pagePuppeteerResult.html;
				} catch {
					continue;
				}
			}

			// Extract assets from this page
			const pageAssets = extractAssetUrls(pageHtml, page.url, assetType as AssetType);
			for (const assetUrl of pageAssets) {
				if (!seenUrls.has(assetUrl)) {
					seenUrls.add(assetUrl);
					allAssetUrls.push(assetUrl);

					// Stop if we found enough assets
					if (allAssetUrls.length >= MAX_ASSETS) break;
				}
			}

			if (allAssetUrls.length >= MAX_ASSETS) break;
		}
	}

	// Limit total assets
	const assetUrls = allAssetUrls.slice(0, MAX_ASSETS);

	if (assetUrls.length === 0) {
		return {
			json: {
				url,
				operation: 'downloadAssets',
				task,
				success: false,
				data: null,
				error: `No ${assetType} assets found on the page or crawled pages.`,
				meta,
			},
		};
	}

	// Download assets
	const downloadedAssets: Array<{ name: string; buffer: Buffer; mimeType: string }> = [];

	for (const assetUrl of assetUrls) {
		const downloaded = await downloadAsset(assetUrl);
		if (downloaded) {
			const urlPath = new URL(assetUrl).pathname;
			const fileName = urlPath.split('/').pop() || `asset_${downloadedAssets.length}`;
			downloadedAssets.push({
				name: fileName,
				buffer: downloaded.buffer,
				mimeType: downloaded.mimeType,
			});
		}
	}

	if (downloadedAssets.length === 0) {
		return {
			json: {
				url,
				operation: 'downloadAssets',
				task,
				success: false,
				data: null,
				error: 'Failed to download any assets.',
				meta,
			},
		};
	}

	// Single asset: return directly
	if (downloadedAssets.length === 1) {
		const asset = downloadedAssets[0];
		return {
			json: {
				url,
				operation: 'downloadAssets',
				task,
				success: true,
				data: {
					assetsCount: 1,
					assetType,
					zipped: false,
				},
				meta,
			},
			binary: {
				asset: {
					data: asset.buffer.toString('base64'),
					mimeType: asset.mimeType,
					fileName: asset.name,
				},
			},
		};
	}

	// Multiple assets: create ZIP
	const zip = new JSZip();
	for (const asset of downloadedAssets) {
		zip.file(asset.name, asset.buffer);
	}

	const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

	return {
		json: {
			url,
			operation: 'downloadAssets',
			task,
			success: true,
			data: {
				assetsCount: downloadedAssets.length,
				assetType,
				zipped: true,
			},
			meta,
		},
		binary: {
			assetsZip: {
				data: zipBuffer.toString('base64'),
				mimeType: 'application/zip',
				fileName: 'assets.zip',
			},
		},
	};
}

/**
 * Crawl for contact information (emails/phones).
 * 
 * Strategy: 1) Try common contact page URLs directly (faster), 2) Try crawled candidates.
 * 
 * @param {string} baseUrl - Base URL to crawl from
 * @param {string} task - Task description
 * @param {string} subTask - Sub-task for individual page extraction
 * @param {CrawledPage[]} candidates - List of candidate pages from crawling
 * @param {boolean} useAI - Whether to allow LLM extraction
 * @param {string} crawl4aiBaseUrl - Crawl4AI service base URL
 * @param {TaskIntent} intent - Task intent indicating what to extract
 * @param {WebAccessMeta} meta - Metadata object to track used strategies
 * @param {string} [aiProvider] - AI provider
 * @param {string} [aiModel] - AI model name
 * @param {OpenAIConfig} [openAiConfig] - OpenAI-compatible API configuration
 * @param {string} [flareSolverrUrl] - FlareSolverr service URL
 * @returns {Promise<{ json: WebAccessResultJson }>} Result with contact information
 */
async function crawlForContact(
	baseUrl: string,
	task: string,
	subTask: string,
	candidates: CrawledPage[],
	useAI: boolean,
	crawl4aiBaseUrl: string,
	intent: TaskIntent,
	meta: WebAccessMeta,
	aiProvider?: string,
	aiModel?: string,
	openAiConfig?: OpenAIConfig,
	flareSolverrUrl?: string,
): Promise<{ json: WebAccessResultJson }> {
	const allEmails: string[] = [];
	const allPhones: string[] = [];
	const pages: Array<{ url: string; emails?: string[]; phones?: string[] }> = [];
	const pagesChecked: string[] = [];

	// Helper to check if we've found what we need
	const hasFoundWhatWeNeed = (): boolean => {
		const emailSatisfied = !intent.wantsEmail || allEmails.length > 0;
		const phoneSatisfied = !intent.wantsPhone || allPhones.length > 0;
		return emailSatisfied && phoneSatisfied;
	};

	// STEP 1: Try common contact page URLs directly first (faster than crawling)
	const contactUrls = getContactPageUrls(baseUrl);
	for (const contactUrl of contactUrls) {
		if (hasFoundWhatWeNeed()) break;

		pagesChecked.push(contactUrl);
		try {
			const result = await handleFetchContent(
				contactUrl,
				subTask,
				useAI,
				crawl4aiBaseUrl,
				{ ...meta },
				aiProvider,
				aiModel,
				openAiConfig,
				flareSolverrUrl,
			);

			if (result.json.success && result.json.data) {
				const pageData: { url: string; emails?: string[]; phones?: string[] } = {
					url: contactUrl,
				};

				if (intent.wantsEmail && result.json.data.emails) {
					const emails = result.json.data.emails as string[];
					if (emails.length > 0) {
						pageData.emails = emails;
						allEmails.push(...emails);
					}
				}

				if (intent.wantsPhone && result.json.data.phones) {
					const phones = result.json.data.phones as string[];
					if (phones.length > 0) {
						pageData.phones = phones;
						allPhones.push(...phones);
					}
				}

				if (pageData.emails || pageData.phones) {
					pages.push(pageData);
				}
			}
		} catch {
			// URL doesn't exist or failed, continue to next
		}
	}

	// STEP 2: If still need more data, try crawled candidates
	if (!hasFoundWhatWeNeed()) {
		for (const candidate of candidates) {
			if (hasFoundWhatWeNeed()) break;

			// Skip if we already checked this URL
			if (pagesChecked.includes(candidate.url)) continue;
			pagesChecked.push(candidate.url);

			const result = await handleFetchContent(
				candidate.url,
				subTask,
				useAI,
				crawl4aiBaseUrl,
				meta,
				aiProvider,
				aiModel,
				openAiConfig,
				flareSolverrUrl,
			);

			// Merge meta flags from candidate processing
			if (result.json.meta) {
				Object.assign(meta, result.json.meta);
			}

			if (result.json.success && result.json.data) {
				const pageData: { url: string; emails?: string[]; phones?: string[] } = {
					url: candidate.url,
				};

				if (intent.wantsEmail && result.json.data.emails) {
					const emails = result.json.data.emails as string[];
					if (emails.length > 0) {
						pageData.emails = emails;
						allEmails.push(...emails);
					}
				}

				if (intent.wantsPhone && result.json.data.phones) {
					const phones = result.json.data.phones as string[];
					if (phones.length > 0) {
						pageData.phones = phones;
						allPhones.push(...phones);
					}
				}

				if (pageData.emails || pageData.phones) {
					pages.push(pageData);
				}
			}
		}
	}

	const uniqueEmails = [...new Set(allEmails)];
	const uniquePhones = [...new Set(allPhones)];

	// Add debug info to meta
	const debugMeta = {
		...meta,
		pagesChecked: pagesChecked.length,
		pagesWithData: pages.length,
	};

	if (uniqueEmails.length === 0 && uniquePhones.length === 0) {
		return {
			json: {
				url: baseUrl,
				operation: 'crawl',
				task,
				success: false,
				data: null,
				error: `No contact information found. Checked ${pagesChecked.length} pages.`,
				meta: debugMeta,
			},
		};
	}

	const data: Record<string, unknown> = { pages };
	if (intent.wantsEmail) data.emails = uniqueEmails;
	if (intent.wantsPhone) data.phones = uniquePhones;

	return {
		json: {
			url: baseUrl,
			operation: 'crawl',
			task,
			success: true,
			data,
			meta: debugMeta,
		},
	};
}

/**
 * Crawl for products.
 * 
 * Uses full pipeline (HTTP → Puppeteer → Crawl4AI BM25 → LLM) for each candidate page.
 * 
 * @param {string} baseUrl - Base URL to crawl from
 * @param {string} task - Task description
 * @param {CrawledPage[]} candidates - List of candidate pages from crawling
 * @param {boolean} useAI - Whether to allow LLM extraction
 * @param {string} crawl4aiBaseUrl - Crawl4AI service base URL
 * @param {WebAccessMeta} meta - Metadata object to track used strategies
 * @param {string} [aiProvider] - AI provider
 * @param {string} [aiModel] - AI model name
 * @param {OpenAIConfig} [openAiConfig] - OpenAI-compatible API configuration
 * @param {string} [flareSolverrUrl] - FlareSolverr service URL
 * @returns {Promise<{ json: WebAccessResultJson }>} Result with product list
 */
async function crawlForProducts(
	baseUrl: string,
	task: string,
	candidates: CrawledPage[],
	useAI: boolean,
	crawl4aiBaseUrl: string,
	meta: WebAccessMeta,
	aiProvider?: string,
	aiModel?: string,
	openAiConfig?: OpenAIConfig,
	flareSolverrUrl?: string,
): Promise<{ json: WebAccessResultJson }> {
	const allProducts: ProductSummary[] = [];
	const sourcePages: string[] = [];
	const seenUrls = new Set<string>();

	for (const candidate of candidates) {
		// Use full pipeline for each candidate page
		const result = await handleFetchContent(
			candidate.url,
			task,
			useAI,
			crawl4aiBaseUrl,
			meta,
			aiProvider,
			aiModel,
			openAiConfig,
			flareSolverrUrl,
		);

		// Merge meta flags from candidate processing
		if (result.json.meta) {
			Object.assign(meta, result.json.meta);
		}

		// Extract products from successful result
		if (result.json.success && result.json.data) {
			const products = result.json.data.products as ProductSummary[] | undefined;

			if (products && products.length > 0) {
				sourcePages.push(candidate.url);

				for (const product of products) {
					if (!seenUrls.has(product.url)) {
						seenUrls.add(product.url);
						allProducts.push(product);
					}
				}
			}
		}

		// Stop if we have enough products
		if (allProducts.length >= MAX_PRODUCTS) break;
	}

	if (allProducts.length === 0) {
		return {
			json: {
				url: baseUrl,
				operation: 'crawl',
				task,
				success: false,
				data: null,
				error: 'No products found.',
				meta,
			},
		};
	}

	return {
		json: {
			url: baseUrl,
			operation: 'crawl',
			task,
			success: true,
			data: {
				products: allProducts,
				sourcePages,
			},
			meta,
		},
	};
}

/**
 * Handle crawl operation.
 * 
 * Crawls a website to discover and extract data from multiple pages.
 * Supports contact extraction (emails/phones) and product listing.
 * 
 * @param {string} url - Starting URL for crawling
 * @param {string} task - Task description
 * @param {boolean} useAI - Whether to allow LLM extraction
 * @param {string} crawl4aiBaseUrl - Crawl4AI service base URL
 * @param {WebAccessMeta} meta - Metadata object to track used strategies
 * @param {string} [aiProvider] - AI provider
 * @param {string} [aiModel] - AI model name
 * @param {OpenAIConfig} [openAiConfig] - OpenAI-compatible API configuration
 * @param {string} [flareSolverrUrl] - FlareSolverr service URL
 * @returns {Promise<{ json: WebAccessResultJson }>} Result with crawled data
 */
async function handleCrawl(
	url: string,
	task: string,
	useAI: boolean,
	crawl4aiBaseUrl: string,
	meta: WebAccessMeta,
	aiProvider?: string,
	aiModel?: string,
	openAiConfig?: OpenAIConfig,
	flareSolverrUrl?: string,
): Promise<{ json: WebAccessResultJson }> {
	// Validate URL
	const urlValidation = validateUrl(url);
	if (!urlValidation.valid) {
		return {
			json: {
				url,
				operation: 'crawl',
				task,
				success: false,
				data: null,
				error: urlValidation.error || 'Invalid URL',
				meta,
			},
		};
	}

	const intent = inferTaskIntent(task, 'crawl');
	const subTask = generateSubTask(task, intent);

	// For contact extraction, try direct URLs first before crawling
	// This is much faster and often sufficient
	if (intent.wantsEmail || intent.wantsPhone) {
		// First attempt: try common contact pages directly without crawling
		const quickResult = await crawlForContact(
			url, task, subTask, [], useAI, crawl4aiBaseUrl, intent, { ...meta },
			aiProvider, aiModel, openAiConfig, flareSolverrUrl,
		);

		// If we found data, return early
		if (quickResult.json.success) {
			return quickResult;
		}

		// If direct URLs didn't work, now try crawling for more candidates
		meta.usedCrawl4ai = true;
		const crawledPages = await crawl4aiCrawl(crawl4aiBaseUrl, url);

		if (crawledPages.length > 0) {
			// Score and sort candidates using URL, title, and snippet
			const scoredPages = crawledPages
				.map((page) => ({
					...page,
					score: scorePageForIntent(page, intent),
				}))
				.sort((a, b) => b.score - a.score)
				.slice(0, MAX_CRAWL_CANDIDATES);

			return crawlForContact(
				url, task, subTask, scoredPages, useAI, crawl4aiBaseUrl, intent, meta,
				aiProvider, aiModel, openAiConfig, flareSolverrUrl,
			);
		}

		// Crawl failed, return the quickResult (which has the error message)
		return quickResult;
	}

	// For other operations, crawl first
	meta.usedCrawl4ai = true;
	const crawledPages = await crawl4aiCrawl(crawl4aiBaseUrl, url);

	if (crawledPages.length === 0) {
		return {
			json: {
				url,
				operation: 'crawl',
				task,
				success: false,
				data: null,
				error: 'Could not crawl the website.',
				meta,
			},
		};
	}

	// Score and sort candidates using URL, title, and snippet
	const scoredPages = crawledPages
		.map((page) => ({
			...page,
			score: scorePageForIntent(page, intent),
		}))
		.sort((a, b) => b.score - a.score)
		.slice(0, MAX_CRAWL_CANDIDATES);

	if (intent.wantsProductList) {
		return crawlForProducts(
			url, task, scoredPages, useAI, crawl4aiBaseUrl, meta,
			aiProvider, aiModel, openAiConfig, flareSolverrUrl,
		);
	}

	// Default: return crawled pages info
	return {
		json: {
			url,
			operation: 'crawl',
			task,
			success: true,
			data: {
				pagesFound: crawledPages.length,
				pages: crawledPages.slice(0, 20).map((p) => ({
					url: p.url,
					title: p.title,
				})),
			},
			meta,
		},
	};
}

/**
 * Handle runScript operation.
 * 
 * Executes custom JavaScript in the browser context on the specified URL.
 * 
 * @param {string} url - URL to run script on
 * @param {string} task - JavaScript code to execute
 * @param {WebAccessMeta} meta - Metadata object to track used strategies
 * @returns {Promise<{ json: WebAccessResultJson }>} Result with script execution output
 */
async function handleRunScript(
	url: string,
	task: string,
	meta: WebAccessMeta,
): Promise<{ json: WebAccessResultJson }> {
	// Validate URL
	const urlValidation = validateUrl(url);
	if (!urlValidation.valid) {
		return {
			json: {
				url,
				operation: 'runScript',
				task,
				success: false,
				data: null,
				error: urlValidation.error || 'Invalid URL',
				meta,
			},
		};
	}

	meta.usedPuppeteer = true;

	try {
		const result = await runPageScript(url, task);

		return {
			json: {
				url,
				operation: 'runScript',
				task,
				success: true,
				data: result as Record<string, unknown>,
				meta,
			},
		};
	} catch (error) {
		return {
			json: {
				url,
				operation: 'runScript',
				task,
				success: false,
				data: null,
				error: `Script execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
				meta,
			},
		};
	}
}

/**
 * Process a single URL based on operation.
 * 
 * Routes the request to the appropriate handler based on the operation type.
 * 
 * @param {ProcessUrlContext} context - Processing context with URL, operation, and configuration
 * @returns {Promise<{ json: WebAccessResultJson; binary?: Record<string, IBinaryData> }>} Processing result
 */
async function processUrl(
	context: ProcessUrlContext,
): Promise<{ json: WebAccessResultJson; binary?: Record<string, IBinaryData> }> {
	const { url, operation, task, useAI, aiProvider, aiModel, crawl4aiBaseUrl, openAiConfig, flareSolverrUrl } = context;

	const meta: WebAccessMeta = {
		aiProvider,
		aiModel,
	};

	switch (operation) {
		case 'fetchContent':
			return handleFetchContent(url, task, useAI, crawl4aiBaseUrl, meta, aiProvider, aiModel, openAiConfig, flareSolverrUrl);

		case 'screenshot':
			return handleScreenshot(url, task, meta);

		case 'downloadAssets':
			return handleDownloadAssets(url, task, crawl4aiBaseUrl, meta);

		case 'crawl':
			return handleCrawl(url, task, useAI, crawl4aiBaseUrl, meta, aiProvider, aiModel, openAiConfig, flareSolverrUrl);

		case 'runScript':
			return handleRunScript(url, task, meta);

		default:
			return {
				json: {
					url,
					operation,
					task,
					success: false,
					data: null,
					error: `Unknown operation: ${operation}`,
					meta,
				},
			};
	}
}

export class WebAccess implements INodeType {
	methods = {
		listSearch: {
			async listModels(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				try {
					const credentials = await this.getCredentials('openAICompatibleApi');
					const baseUrl = (credentials.baseUrl as string) || 'https://api.openai.com/v1';
					const apiKey = credentials.apiKey as string;

					const response = await this.helpers.httpRequest({
						method: 'GET',
						url: `${baseUrl}/models`,
						headers: {
							Authorization: `Bearer ${apiKey}`,
						},
					});

					// OpenAI API returns { data: [{ id, object, created, owned_by }] }
					const models = response.data || [];

					// Sort models alphabetically
					const sortedModels = models
						.map((model: { id: string; owned_by?: string }) => ({
							name: model.id,
							value: model.id,
							description: model.owned_by ? `Owned by: ${model.owned_by}` : undefined,
						}))
						.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));

					// Filter if search term provided
					const filteredModels = filter
						? sortedModels.filter((model: { name: string }) =>
								model.name.toLowerCase().includes(filter.toLowerCase()),
							)
						: sortedModels;

					return {
						results: filteredModels,
					};
				} catch (error) {
					// Return empty list on error with helpful message
					return {
						results: [
							{
								name: 'Error Loading Models - Check Credentials',
								value: 'gpt-4o-mini',
								description: error instanceof Error ? error.message : 'Unknown error',
							},
						],
					};
				}
			},
		},
	};

	description: INodeTypeDescription = {
		displayName: 'Web Access',
		name: 'webAccess',
		icon: { light: 'file:webaccess.svg', dark: 'file:webaccess.dark.svg' },
		group: ['transform'],
		version: 4,
		subtitle: '={{$parameter["task"]}}',
		description: 'Smart web access - just describe what you want. Auto-detects whether to fetch content, crawl multiple pages, download files, or take screenshots based on your task.',
		defaults: {
			name: 'Web Access',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'webAccessApi',
				required: true,
			},
			{
				name: 'openAICompatibleApi',
				required: false,
				displayOptions: {
					show: {
						aiProvider: ['openai-compatible'],
					},
				},
			},
		],
		properties: [
			// URLs parameter
			{
				displayName: 'URLs',
				name: 'urls',
				type: 'string',
				typeOptions: {
					multipleValues: true,
				},
				default: [],
				required: true,
				description: 'Website URL(s) to access',
			},
			// Task parameter - the main input that drives everything
			{
				displayName: 'Task',
				name: 'task',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				default: '',
				required: true,
				 
				description: 'Describe what you want. The system auto-detects the right approach. Examples: "Find contact email", "Download all PDFs", "Take screenshot", "Get product list", "Extract article text".',
				placeholder: 'e.g., "Find contact email" or "Download all PDFs"',
			},
			// AI Provider selection - also acts as LLM enable/disable
			{
				displayName: 'LLM Provider',
				name: 'aiProvider',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'None (Disable LLM)',
						value: 'none',
						description: 'Do not use LLM extraction - rely on pattern matching only',
					},
					{
						name: 'Crawl4AI Internal',
						value: 'crawl4ai',
						description: 'Use the built-in LLM in Crawl4AI service',
					},
					{
						name: 'OpenAI-Compatible',
						value: 'openai-compatible',
						description: 'Use OpenAI, OpenRouter, Groq, Together AI, or any OpenAI-compatible API',
					},
				],
				default: 'none',
				description: 'AI provider for LLM extraction',
			},
			// AI Model dropdown with dynamic list (shown when openai-compatible is selected)
			{
				displayName: 'Model',
				name: 'aiModel',
				type: 'resourceLocator',
				default: { mode: 'id', value: 'gpt-4o-mini' },
				displayOptions: {
					show: {
						aiProvider: ['openai-compatible'],
					},
				},
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: {
							searchListMethod: 'listModels',
							searchable: true,
						},
					},
					{
						displayName: 'ID',
						name: 'id',
						type: 'string',
						placeholder: 'e.g., gpt-4o-mini',
					},
				],
				description: 'The model to use for extraction. Select from list or enter model ID manually.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnItems: INodeExecutionData[] = [];

		// Read Web Access credentials
		const webAccessCredentials = await this.getCredentials('webAccessApi');
		const crawl4aiBaseUrl = webAccessCredentials.crawl4aiBaseUrl as string;
		const flareSolverrUrl = (webAccessCredentials.flareSolverrUrl as string) || undefined;

		// Read AI provider setting
		const aiProvider = this.getNodeParameter('aiProvider', 0) as string;
		const useAI = aiProvider !== 'none';

		// Get AI model - handle both string and resourceLocator formats
		let aiModel: string | undefined;
		if (aiProvider === 'openai-compatible') {
			const aiModelParam = this.getNodeParameter('aiModel', 0) as string | { value: string };
			aiModel = typeof aiModelParam === 'string' ? aiModelParam : aiModelParam?.value;
		}

		// Get OpenAI credentials if using openai-compatible provider
		let openAiConfig: { apiKey: string; baseUrl: string } | undefined;
		if (aiProvider === 'openai-compatible') {
			try {
				const credentials = await this.getCredentials('openAICompatibleApi');
				openAiConfig = {
					apiKey: credentials.apiKey as string,
					baseUrl: (credentials.baseUrl as string) || 'https://api.openai.com/v1',
				};
			} catch (error) {
				throw new NodeOperationError(
					this.getNode(),
					`Failed to load OpenAI-Compatible API credentials. Please configure the credential in the node settings. Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
				);
			}
		}

		try {
			for (let i = 0; i < items.length; i++) {
				const task = this.getNodeParameter('task', i) as string;
				const urlsParam = this.getNodeParameter('urls', i) as string | string[];
				const urls = Array.isArray(urlsParam) ? urlsParam : [urlsParam];

				// Auto-detect operation from task description
				// Use LLM for smarter detection if available, otherwise keyword matching
				const operation = await inferOperation(task, openAiConfig, aiModel);

				for (const url of urls) {
					if (!url || !url.trim()) continue;

					try {
						// Try the detected operation first
						const detectedOperation = operation;
						let result = await processUrl({
							url: url.trim(),
							operation: detectedOperation,
							task,
							useAI,
							aiProvider,
							aiModel,
							crawl4aiBaseUrl,
							openAiConfig,
							flareSolverrUrl,
						});

						// Add detected operation to meta
						result.json.meta = {
							...result.json.meta,
							detectedOperation,
						};

						// If failed, try fallback operations
						if (!result.json.success) {
							const fallbacks = getFallbackOperations(detectedOperation);
							for (const fallbackOp of fallbacks) {
								const fallbackResult = await processUrl({
									url: url.trim(),
									operation: fallbackOp,
									task,
									useAI,
									aiProvider,
									aiModel,
									crawl4aiBaseUrl,
									openAiConfig,
									flareSolverrUrl,
								});

								if (fallbackResult.json.success) {
									// Fallback succeeded - use this result
									result = fallbackResult;
									// Add info about the fallback
									result.json.meta = {
										...result.json.meta,
										detectedOperation,
										originalOperation: detectedOperation,
										fallbackOperation: fallbackOp,
									};
									break;
								}
							}
						}

						const outputItem: INodeExecutionData = {
							json: result.json as unknown as IDataObject,
						};

						if (result.binary) {
							outputItem.binary = result.binary;
						}

						returnItems.push(outputItem);
					} catch (error) {
						if (this.continueOnFail()) {
							returnItems.push({
								json: {
									url,
									operation,
									task,
									success: false,
									data: null,
									error: error instanceof Error ? error.message : 'Unknown error',
								},
							});
						} else {
							throw new NodeOperationError(this.getNode(), error as Error, {
								itemIndex: i,
							});
						}
					}
				}
			}
		} finally {
			// Clean up Puppeteer browser
			await closeBrowser();
		}

		return [returnItems];
	}
}
