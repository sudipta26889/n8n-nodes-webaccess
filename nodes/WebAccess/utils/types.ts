/**
 * Shared TypeScript type definitions for Web Access node
 */

// Operation types
export type WebAccessOperation = 'fetchContent' | 'screenshot' | 'downloadAssets' | 'crawl' | 'runScript';

// Task intent inference result
export interface TaskIntent {
	wantsEmail?: boolean;
	wantsPhone?: boolean;
	wantsTextDump?: boolean;
	wantsProductList?: boolean;
	wantsPdf?: boolean;
	wantsImages?: boolean;
	wantsCsv?: boolean;
}

// Product summary for e-commerce extraction
export interface ProductSummary {
	name: string;
	url: string;
	price?: string;
}

// Strategy result (used internally between stages)
export interface StrategyResult {
	success: boolean;
	data: Record<string, unknown> | null;
	html?: string;
	text?: string;
	error?: string;
}

// Puppeteer page content result
export interface PuppeteerPageContent {
	html: string;
	text: string;
}

// Crawled page info from Crawl4AI
export interface CrawledPage {
	url: string;
	title?: string;
	snippet?: string;
}

// Meta information for output
export interface WebAccessMeta {
	usedHttp?: boolean;
	usedPuppeteer?: boolean;
	usedCrawl4ai?: boolean;
	usedCrawl4aiLlm?: boolean;
	aiProvider?: string;
	aiModel?: string;
}

// Main output JSON structure
export interface WebAccessResultJson {
	url: string;
	operation: WebAccessOperation;
	task: string;
	success: boolean;
	data: Record<string, unknown> | null;
	error?: string;
	meta?: WebAccessMeta;
}

// Processing context passed to processUrl
export interface ProcessUrlContext {
	url: string;
	operation: WebAccessOperation;
	task: string;
	useAI: boolean;
	aiProvider?: string;
	aiModel?: string;
	crawl4aiBaseUrl: string;
}

// Internal processing result (includes optional binary)
export interface ProcessUrlResult {
	json: WebAccessResultJson;
	binary?: Record<string, BinaryData>;
}

// Binary data structure for n8n
export interface BinaryData {
	data: Buffer | string;
	mimeType: string;
	fileName?: string;
}

// fetchContent data shape
export interface FetchContentData {
	emails?: string[];
	phones?: string[];
	text?: string;
	pageTitle?: string;
	rawAnswer?: string;
}

// crawl operation data shapes
export interface CrawlEmailData {
	emails: string[];
	pages: Array<{
		url: string;
		emails: string[];
	}>;
}

export interface CrawlProductData {
	products: ProductSummary[];
	sourcePages: string[];
}

// screenshot data shape
export interface ScreenshotData {
	fullPage: boolean;
}

// downloadAssets data shape
export interface DownloadAssetsData {
	assetsCount: number;
	assetType: string;
	zipped: boolean;
}

// Asset types for download
export type AssetType = 'pdf' | 'image' | 'csv';

// HTTP fetch options
export interface HttpFetchOptions {
	timeout?: number;
	userAgent?: string;
}

// Puppeteer options
export interface PuppeteerOptions {
	timeout?: number;
	waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
}

// Crawl4AI query options
export interface Crawl4AIQueryOptions {
	useLlm: boolean;
}

// Crawl4AI crawl config
export interface Crawl4AICrawlConfig {
	urls: string[];
	crawler_config: {
		type: string;
		params: {
			scraping_strategy: {
				type: string;
				params: Record<string, unknown>;
			};
			table_extraction: {
				type: string;
				params: Record<string, unknown>;
			};
			exclude_social_media_domains: string[];
			stream: boolean;
		};
	};
}
