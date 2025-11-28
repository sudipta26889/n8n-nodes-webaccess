import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IBinaryData,
	IDataObject,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports -- Required for asset bundling in self-hosted deployments
import JSZip from 'jszip';

// Import strategies
import { httpFetch, downloadAsset } from './strategies/http';
import { getPageContent, captureScreenshot, runPageScript, closeBrowser } from './strategies/puppeteer';
import { crawl4aiQuery, crawl4aiCrawl } from './strategies/crawl4ai';

// Import utilities
import type {
	WebAccessOperation,
	WebAccessResultJson,
	WebAccessMeta,
	ProcessUrlContext,
	TaskIntent,
	CrawledPage,
	ProductSummary,
	AssetType,
} from './utils/types';
import {
	extractEmails,
	extractPhones,
	extractTextContent,
	extractPageTitle,
	extractProductsFromHtml,
	extractAssetUrls,
} from './utils/extraction';
import {
	inferTaskIntent,
	generateSubTask,
	scoreUrlForIntent,
	wantsFullPageScreenshot,
	getAssetTypeFromTask,
} from './utils/taskIntent';

// Maximum assets to download
const MAX_ASSETS = 50;

// Maximum crawl candidates to inspect
const MAX_CRAWL_CANDIDATES = 20;

/**
 * Extract data based on task intent
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
 * Handle fetchContent operation
 * Pipeline: HTTP → Puppeteer → Crawl4AI BM25 → Crawl4AI LLM (if useAI)
 */
async function handleFetchContent(
	url: string,
	task: string,
	useAI: boolean,
	crawl4aiBaseUrl: string,
	meta: WebAccessMeta,
): Promise<{ json: WebAccessResultJson }> {
	const intent = inferTaskIntent(task, 'fetchContent');
	let html = '';
	let text = '';

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

	// Stage 4: Try Crawl4AI LLM (only if useAI is true)
	if (useAI) {
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
 * Handle screenshot operation
 */
async function handleScreenshot(
	url: string,
	task: string,
	meta: WebAccessMeta,
): Promise<{ json: WebAccessResultJson; binary?: Record<string, IBinaryData> }> {
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
 * Handle downloadAssets operation
 */
async function handleDownloadAssets(
	url: string,
	task: string,
	meta: WebAccessMeta,
): Promise<{ json: WebAccessResultJson; binary?: Record<string, IBinaryData> }> {
	const assetType = getAssetTypeFromTask(task) || 'pdf';
	let html = '';

	// Get page HTML via HTTP first
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

	// Extract asset URLs
	const assetUrls = extractAssetUrls(html, url, assetType as AssetType).slice(0, MAX_ASSETS);

	if (assetUrls.length === 0) {
		return {
			json: {
				url,
				operation: 'downloadAssets',
				task,
				success: false,
				data: null,
				error: `No ${assetType} assets found on the page.`,
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
 * Crawl for contact information (emails/phones)
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
): Promise<{ json: WebAccessResultJson }> {
	const allEmails: string[] = [];
	const allPhones: string[] = [];
	const pages: Array<{ url: string; emails?: string[]; phones?: string[] }> = [];

	for (const candidate of candidates) {
		// Fetch each candidate page
		const result = await handleFetchContent(
			candidate.url,
			subTask,
			useAI,
			crawl4aiBaseUrl,
			{ ...meta },
		);

		if (result.json.success && result.json.data) {
			const pageData: { url: string; emails?: string[]; phones?: string[] } = {
				url: candidate.url,
			};

			if (intent.wantsEmail && result.json.data.emails) {
				const emails = result.json.data.emails as string[];
				pageData.emails = emails;
				allEmails.push(...emails);

				// Stop early if we found emails
				if (allEmails.length > 0) {
					pages.push(pageData);
					break;
				}
			}

			if (intent.wantsPhone && result.json.data.phones) {
				const phones = result.json.data.phones as string[];
				pageData.phones = phones;
				allPhones.push(...phones);
			}

			if (pageData.emails || pageData.phones) {
				pages.push(pageData);
			}
		}
	}

	const uniqueEmails = [...new Set(allEmails)];
	const uniquePhones = [...new Set(allPhones)];

	if (uniqueEmails.length === 0 && uniquePhones.length === 0) {
		return {
			json: {
				url: baseUrl,
				operation: 'crawl',
				task,
				success: false,
				data: null,
				error: 'No contact information found.',
				meta,
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
			meta,
		},
	};
}

/**
 * Crawl for products
 */
async function crawlForProducts(
	baseUrl: string,
	task: string,
	candidates: CrawledPage[],
	meta: WebAccessMeta,
): Promise<{ json: WebAccessResultJson }> {
	const allProducts: ProductSummary[] = [];
	const sourcePages: string[] = [];
	const seenUrls = new Set<string>();

	for (const candidate of candidates) {
		// Get page content
		let html = '';

		const httpResult = await httpFetch(candidate.url);
		if (httpResult.success && httpResult.html) {
			html = httpResult.html;
		} else {
			try {
				const puppeteerResult = await getPageContent(candidate.url);
				html = puppeteerResult.html;
			} catch {
				continue;
			}
		}

		// Extract products
		const products = extractProductsFromHtml(html, candidate.url);

		if (products.length > 0) {
			sourcePages.push(candidate.url);

			for (const product of products) {
				if (!seenUrls.has(product.url)) {
					seenUrls.add(product.url);
					allProducts.push(product);
				}
			}
		}

		// Stop if we have enough products
		if (allProducts.length >= 100) break;
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
 * Handle crawl operation
 */
async function handleCrawl(
	url: string,
	task: string,
	useAI: boolean,
	crawl4aiBaseUrl: string,
	meta: WebAccessMeta,
): Promise<{ json: WebAccessResultJson }> {
	const intent = inferTaskIntent(task, 'crawl');
	meta.usedCrawl4ai = true;

	// Crawl the site
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

	// Score and sort candidates
	const scoredPages = crawledPages
		.map((page) => ({
			...page,
			score: scoreUrlForIntent(page.url, intent),
		}))
		.sort((a, b) => b.score - a.score)
		.slice(0, MAX_CRAWL_CANDIDATES);

	// Generate sub-task
	const subTask = generateSubTask(task, intent);

	// Process based on intent
	if (intent.wantsEmail || intent.wantsPhone) {
		return crawlForContact(url, task, subTask, scoredPages, useAI, crawl4aiBaseUrl, intent, meta);
	}

	if (intent.wantsProductList) {
		return crawlForProducts(url, task, scoredPages, meta);
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
 * Handle runScript operation
 */
async function handleRunScript(
	url: string,
	task: string,
	meta: WebAccessMeta,
): Promise<{ json: WebAccessResultJson }> {
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
 * Process a single URL based on operation
 */
async function processUrl(
	context: ProcessUrlContext,
): Promise<{ json: WebAccessResultJson; binary?: Record<string, IBinaryData> }> {
	const { url, operation, task, useAI, aiProvider, aiModel, crawl4aiBaseUrl } = context;

	const meta: WebAccessMeta = {
		aiProvider,
		aiModel,
	};

	switch (operation) {
		case 'fetchContent':
			return handleFetchContent(url, task, useAI, crawl4aiBaseUrl, meta);

		case 'screenshot':
			return handleScreenshot(url, task, meta);

		case 'downloadAssets':
			return handleDownloadAssets(url, task, meta);

		case 'crawl':
			return handleCrawl(url, task, useAI, crawl4aiBaseUrl, meta);

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
	description: INodeTypeDescription = {
		displayName: 'Web Access',
		name: 'webAccess',
		icon: { light: 'file:webaccess.svg', dark: 'file:webaccess.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Cost-aware universal web access (HTTP, Puppeteer, Crawl4AI)',
		defaults: {
			name: 'Web Access',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'webAccessApi',
				required: false,
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
				description: 'One or more URLs to process',
			},
			// Operation selection
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Crawl',
						value: 'crawl',
						description: 'Crawl a website and extract information',
						action: 'Crawl website starting from URL',
					},
					{
						name: 'Download Assets',
						value: 'downloadAssets',
						description: 'Download assets (PDFs, images, etc.) from the page',
						action: 'Download assets from URL',
					},
					{
						name: 'Fetch Content',
						value: 'fetchContent',
						description: 'Fetch and extract content from a page',
						action: 'Fetch content from URL',
					},
					{
						name: 'Run Script',
						value: 'runScript',
						description: 'Run a custom JavaScript script on the page',
						action: 'Run script on URL',
					},
					{
						name: 'Screenshot',
						value: 'screenshot',
						description: 'Capture a screenshot of the page',
						action: 'Capture screenshot of URL',
					},
				],
				default: 'fetchContent',
				required: true,
			},
			// Task parameter
			{
				displayName: 'Task',
				name: 'task',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				default: '',
				required: true,
				description: 'Natural-language instruction describing what to do with the URLs',
				placeholder: 'e.g., "Find contact email" or "Download all PDFs"',
			},
			// useAI toggle
			{
				displayName: 'Allow LLM (Advanced Extraction)',
				name: 'useAI',
				type: 'boolean',
				default: false,
				description: 'Whether to allow LLM-based extraction via Crawl4AI as a last resort',
			},
			// AI Provider (shown when useAI is true)
			{
				displayName: 'AI Provider',
				name: 'aiProvider',
				type: 'options',
				options: [
					{
						name: 'Crawl4AI Internal',
						value: 'crawl4ai',
					},
					{
						name: 'OpenAI-Compatible (Future)',
						value: 'openai-compatible',
					},
				],
				default: 'crawl4ai',
				displayOptions: {
					show: {
						useAI: [true],
					},
				},
				description: 'AI provider for LLM extraction (informational only in v1)',
			},
			// AI Model (shown when useAI is true)
			{
				displayName: 'AI Model',
				name: 'aiModel',
				type: 'string',
				default: '',
				placeholder: 'e.g., gpt-4-mini',
				displayOptions: {
					show: {
						useAI: [true],
					},
				},
				description: 'AI model to use (informational only in v1)',
			},
			// Crawl4AI Base URL
			{
				displayName: 'Crawl4AI Base URL',
				name: 'crawl4aiBaseUrl',
				type: 'string',
				default: 'http://157.173.126.92:11235',
				required: true,
				description: 'Base URL for the Crawl4AI HTTP API',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnItems: INodeExecutionData[] = [];

		// Read global parameters
		const crawl4aiBaseUrl = this.getNodeParameter('crawl4aiBaseUrl', 0) as string;
		const useAI = this.getNodeParameter('useAI', 0) as boolean;
		const aiProvider = useAI ? (this.getNodeParameter('aiProvider', 0) as string) : undefined;
		const aiModel = useAI ? (this.getNodeParameter('aiModel', 0) as string) : undefined;

		try {
			for (let i = 0; i < items.length; i++) {
				const operation = this.getNodeParameter('operation', i) as WebAccessOperation;
				const task = this.getNodeParameter('task', i) as string;
				const urlsParam = this.getNodeParameter('urls', i) as string | string[];
				const urls = Array.isArray(urlsParam) ? urlsParam : [urlsParam];

				for (const url of urls) {
					if (!url || !url.trim()) continue;

					try {
						const context: ProcessUrlContext = {
							url: url.trim(),
							operation,
							task,
							useAI,
							aiProvider,
							aiModel,
							crawl4aiBaseUrl,
						};

						const result = await processUrl(context);

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
