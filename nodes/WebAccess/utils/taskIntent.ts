/**
 * Task intent inference for Web Access node
 * Interprets natural-language task descriptions to determine extraction goals
 */

import type { TaskIntent, WebAccessOperation, OpenAIConfig } from './types';

/**
 * Use LLM to intelligently detect the best operation for a task.
 * 
 * This provides much smarter detection than keyword matching because it
 * understands natural language semantics.
 * 
 * @param {string} task - Task description from user
 * @param {OpenAIConfig} openAiConfig - OpenAI-compatible API configuration
 * @param {string} model - Model to use for detection
 * @param {number} [callCounter] - Optional counter to track API calls
 * @returns {Promise<WebAccessOperation>} Detected operation type
 */
export async function inferOperationWithLLM(
	task: string,
	openAiConfig: OpenAIConfig,
	model: string,
	callCounter?: { count: number },
): Promise<WebAccessOperation> {
	const systemPrompt = `You are a task classifier for a web access tool. Given a user's task description, classify it into ONE of these operations:

- screenshot: User wants a visual capture/image of the webpage
- downloadAssets: User wants to download files (PDFs, images, CSVs, documents)
- runScript: User wants to execute JavaScript, click buttons, fill forms, or interact with page elements
- crawl: User wants to find information across multiple pages (contact info, product lists, site-wide search)
- fetchContent: User wants to extract text/data from a single page (articles, specific info, text content)

Respond with ONLY the operation name, nothing else. If unsure, respond with "fetchContent".

Examples:
- "Take a screenshot" → screenshot
- "Capture the page visually" → screenshot
- "Download all PDFs" → downloadAssets
- "Get the invoice documents" → downloadAssets
- "Click the submit button" → runScript
- "Fill in the contact form" → runScript
- "Find the company email" → crawl
- "Get all products from this store" → crawl
- "Extract the article text" → fetchContent
- "What is on this page?" → fetchContent`;

		try {
			// Track API call
			if (callCounter) {
				callCounter.count += 1;
			}

			const response = await fetch(`${openAiConfig.baseUrl}/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${openAiConfig.apiKey}`,
				},
				body: JSON.stringify({
					model,
					messages: [
						{ role: 'system', content: systemPrompt },
						{ role: 'user', content: task },
					],
					max_tokens: 20,
					temperature: 0,
				}),
			});

		if (!response.ok) {
			// Fall back to keyword matching
			return inferOperationKeyword(task);
		}

		const data = await response.json() as { choices?: { message?: { content?: string } }[] };
		const result = data.choices?.[0]?.message?.content?.trim().toLowerCase();

		// Validate the response
		const validOperations: WebAccessOperation[] = ['screenshot', 'downloadAssets', 'runScript', 'crawl', 'fetchContent'];
		if (validOperations.includes(result as WebAccessOperation)) {
			return result as WebAccessOperation;
		}

		// Fall back to keyword matching if LLM response is invalid
		return inferOperationKeyword(task);
	} catch {
		// Fall back to keyword matching on any error
		return inferOperationKeyword(task);
	}
}

/**
 * Auto-detect the best operation based on task keywords.
 * 
 * Uses keyword-based heuristics - fast but less smart than LLM.
 * Used as fallback when LLM is not available.
 * 
 * @param {string} task - Task description from user
 * @returns {WebAccessOperation} Detected operation type
 */
export function inferOperationKeyword(task: string): WebAccessOperation {
	const lowerTask = task.toLowerCase().trim();

	// Screenshot detection
	if (
		lowerTask.includes('screenshot') ||
		lowerTask.includes('screen shot') ||
		lowerTask.includes('capture') ||
		lowerTask.includes('visual') ||
		lowerTask.includes('image of the page') ||
		lowerTask.includes('picture of')
	) {
		return 'screenshot';
	}

	// Download assets detection
	if (
		lowerTask.includes('download') ||
		lowerTask.includes('get pdf') ||
		lowerTask.includes('get the pdf') ||
		lowerTask.includes('fetch pdf') ||
		lowerTask.includes('save pdf') ||
		lowerTask.includes('get image') ||
		lowerTask.includes('get all image') ||
		lowerTask.includes('download image') ||
		lowerTask.includes('save image') ||
		lowerTask.includes('get csv') ||
		lowerTask.includes('download csv') ||
		lowerTask.includes('get file') ||
		lowerTask.includes('download file')
	) {
		return 'downloadAssets';
	}

	// Run script detection
	if (
		lowerTask.includes('run script') ||
		lowerTask.includes('execute script') ||
		lowerTask.includes('run javascript') ||
		lowerTask.includes('execute javascript') ||
		lowerTask.includes('run code') ||
		lowerTask.includes('click button') ||
		lowerTask.includes('fill form') ||
		lowerTask.includes('submit form') ||
		lowerTask.includes('interact with')
	) {
		return 'runScript';
	}

	// Crawl detection - multi-page scenarios
	if (
		lowerTask.includes('crawl') ||
		lowerTask.includes('spider') ||
		lowerTask.includes('all pages') ||
		lowerTask.includes('entire site') ||
		lowerTask.includes('whole site') ||
		lowerTask.includes('across the site') ||
		lowerTask.includes('from the website') ||
		lowerTask.includes('find contact') ||
		lowerTask.includes('find email') ||
		lowerTask.includes('find phone') ||
		lowerTask.includes('list all products') ||
		lowerTask.includes('get all products') ||
		lowerTask.includes('product catalog') ||
		lowerTask.includes('product list')
	) {
		return 'crawl';
	}

	// Default to fetchContent for single-page extraction
	return 'fetchContent';
}

/**
 * Infer operation - uses LLM if available, otherwise keyword matching.
 * 
 * @param {string} task - Task description from user
 * @param {OpenAIConfig} [openAiConfig] - Optional OpenAI config for LLM detection
 * @param {string} [model] - Optional model name
 * @param {number} [callCounter] - Optional counter to track API calls
 * @returns {Promise<WebAccessOperation>} Detected operation type
 */
export async function inferOperation(
	task: string,
	openAiConfig?: OpenAIConfig,
	model?: string,
	callCounter?: { count: number },
): Promise<WebAccessOperation> {
	// If LLM is available, use it for smarter detection
	if (openAiConfig && model) {
		return inferOperationWithLLM(task, openAiConfig, model, callCounter);
	}

	// Fall back to keyword matching
	return inferOperationKeyword(task);
}

/**
 * Get fallback operations for when the primary operation fails.
 * 
 * Returns an ordered list of operations to try after the primary one fails.
 * Logic:
 * - crawl fails → try fetchContent (maybe data is on the first page)
 * - screenshot fails → no fallback (screenshot-specific)
 * - downloadAssets fails → no fallback (asset-specific)
 * - runScript fails → no fallback (script-specific)
 * - fetchContent fails → try crawl (maybe need to look at other pages)
 * 
 * @param {WebAccessOperation} failedOperation - The operation that failed
 * @returns {WebAccessOperation[]} List of fallback operations to try
 */
export function getFallbackOperations(failedOperation: WebAccessOperation): WebAccessOperation[] {
	switch (failedOperation) {
		case 'crawl':
			// Crawl failed - try single page extraction
			return ['fetchContent'];
		case 'fetchContent':
			// Single page failed - try crawling for more pages
			return ['crawl'];
		case 'screenshot':
		case 'downloadAssets':
		case 'runScript':
			// These are specific operations, no good fallback
			return [];
		default:
			return [];
	}
}

/**
 * Infer what the user wants to extract based on task description and operation.
 * 
 * Uses keyword-based heuristics to determine extraction goals (emails, phones,
 * products, text, assets, etc.).
 * 
 * @param {string} task - Task description from user
 * @param {WebAccessOperation} operation - Operation type (fetchContent, crawl, etc.)
 * @returns {TaskIntent} Intent object indicating what to extract
 */
export function inferTaskIntent(task: string, operation: WebAccessOperation): TaskIntent {
	const lowerTask = task.toLowerCase().trim();
	const intent: TaskIntent = {};

	// Email detection
	if (
		lowerTask.includes('email') ||
		lowerTask.includes('e-mail') ||
		lowerTask.includes('contact email') ||
		lowerTask.includes('mailto') ||
		lowerTask.includes('mail address')
	) {
		intent.wantsEmail = true;
	}

	// Phone detection
	if (
		lowerTask.includes('phone') ||
		lowerTask.includes('telephone') ||
		lowerTask.includes(' tel ') ||
		lowerTask.includes(' tel.') ||
		lowerTask.includes('contact number') ||
		lowerTask.includes('mobile') ||
		lowerTask.includes('call us')
	) {
		intent.wantsPhone = true;
	}

	// Text dump detection (for fetchContent)
	if (operation === 'fetchContent') {
		if (
			lowerTask.includes('all text') ||
			lowerTask.includes('page text') ||
			lowerTask.includes('content') ||
			lowerTask.includes('full content') ||
			lowerTask.includes('full text') ||
			lowerTask.includes('extract text') ||
			lowerTask.includes('get text')
		) {
			intent.wantsTextDump = true;
		}
	}

	// Product list detection
	if (
		lowerTask.includes('product') ||
		lowerTask.includes('item') ||
		lowerTask.includes('wallet') ||
		lowerTask.includes('bag') ||
		lowerTask.includes('shoe') ||
		lowerTask.includes('watch') ||
		lowerTask.includes('catalog') ||
		lowerTask.includes('catalogue') ||
		lowerTask.includes('listing') ||
		lowerTask.includes('collection')
	) {
		intent.wantsProductList = true;
	}

	// PDF detection (for downloadAssets)
	if (operation === 'downloadAssets') {
		if (lowerTask.includes('pdf') || lowerTask.includes('document')) {
			intent.wantsPdf = true;
		}

		// Image detection
		if (
			lowerTask.includes('image') ||
			lowerTask.includes('picture') ||
			lowerTask.includes('photo') ||
			lowerTask.includes('img')
		) {
			intent.wantsImages = true;
		}

		// CSV detection
		if (
			lowerTask.includes('csv') ||
			lowerTask.includes('spreadsheet') ||
			lowerTask.includes('data file')
		) {
			intent.wantsCsv = true;
		}
	}

	// Default to text dump if no specific intent and operation is fetchContent
	if (operation === 'fetchContent' && !intent.wantsEmail && !intent.wantsPhone && !intent.wantsTextDump && !intent.wantsProductList) {
		intent.wantsTextDump = true;
	}

	return intent;
}

/**
 * Generate a sub-task for crawl candidate inspection based on parent task.
 * 
 * Creates a focused sub-task for extracting specific information from
 * individual pages during crawling.
 * 
 * @param {string} parentTask - Original task description
 * @param {TaskIntent} intent - Task intent indicating what to extract
 * @returns {string} Sub-task description for page-level extraction
 */
export function generateSubTask(parentTask: string, intent: TaskIntent): string {
	if (intent.wantsEmail) {
		return 'Find contact email address on this page.';
	}

	if (intent.wantsPhone) {
		return 'Find phone number or contact number on this page.';
	}

	if (intent.wantsProductList) {
		return 'List all products on this page with name, URL, and price if visible.';
	}

	// Default: return original task
	return parentTask;
}

/**
 * Score a crawled page based on task intent for candidate selection.
 * 
 * Combines URL, title, and snippet signals for better ranking.
 * Higher score = more likely to be relevant to the task.
 * 
 * @param {{ url: string; title?: string; snippet?: string }} page - Page information to score
 * @param {TaskIntent} intent - Task intent indicating what to extract
 * @returns {number} Relevance score (higher is better)
 */
export function scorePageForIntent(page: { url: string; title?: string; snippet?: string }, intent: TaskIntent): number {
	const lowerUrl = page.url.toLowerCase();
	const lowerTitle = (page.title || '').toLowerCase();
	const lowerSnippet = (page.snippet || '').toLowerCase();
	let score = 0;

	if (intent.wantsEmail || intent.wantsPhone) {
		// Contact-related patterns
		const contactPatterns = [
			'contact',
			'contacts',
			'about',
			'about-us',
			'aboutus',
			'stores',
			'store',
			'location',
			'locations',
			'head-office',
			'head_office',
			'headquarters',
			'support',
			'help',
			'customer-service',
			'customerservice',
			'reach-us',
			'get-in-touch',
			'find-us',
		];

		for (const pattern of contactPatterns) {
			// URL match (strong signal)
			if (lowerUrl.includes(pattern)) {
				score += 10;
			}
			// Title match (medium signal)
			if (lowerTitle.includes(pattern)) {
				score += 7;
			}
			// Snippet match (weak signal)
			if (lowerSnippet.includes(pattern)) {
				score += 3;
			}
		}
	}

	if (intent.wantsProductList) {
		// Product-related patterns
		const productPatterns = [
			'product',
			'products',
			'shop',
			'store',
			'catalog',
			'catalogue',
			'collection',
			'collections',
			'category',
			'categories',
			'men',
			'mens',
			'women',
			'womens',
			'wallet',
			'wallets',
			'bag',
			'bags',
			'leather',
			'accessories',
		];

		for (const pattern of productPatterns) {
			// URL match (strong signal)
			if (lowerUrl.includes(pattern)) {
				score += 10;
			}
			// Title match (medium signal)
			if (lowerTitle.includes(pattern)) {
				score += 7;
			}
			// Snippet match (weak signal)
			if (lowerSnippet.includes(pattern)) {
				score += 3;
			}
		}
	}

	// Penalize certain URLs
	const penaltyPatterns = [
		'login',
		'signin',
		'sign-in',
		'register',
		'signup',
		'sign-up',
		'cart',
		'checkout',
		'account',
		'privacy',
		'terms',
		'cookie',
		'sitemap',
		'rss',
		'feed',
	];

	for (const pattern of penaltyPatterns) {
		if (lowerUrl.includes(pattern)) {
			score -= 20;
		}
	}

	return score;
}


/**
 * Detect if task implies full-page screenshot.
 * 
 * Checks task description for keywords indicating full-page screenshot is desired.
 * 
 * @param {string} task - Task description
 * @returns {boolean} True if full-page screenshot is requested
 */
export function wantsFullPageScreenshot(task: string): boolean {
	const lowerTask = task.toLowerCase();
	return (
		lowerTask.includes('full') ||
		lowerTask.includes('entire') ||
		lowerTask.includes('whole page') ||
		lowerTask.includes('complete page') ||
		lowerTask.includes('all of')
	);
}

/**
 * Determine asset type from task for downloadAssets operation.
 * 
 * Analyzes task description to determine what type of assets to download.
 * 
 * @param {string} task - Task description
 * @returns {'pdf' | 'image' | 'csv' | null} Asset type or null if not specified
 */
export function getAssetTypeFromTask(task: string): 'pdf' | 'image' | 'csv' | null {
	const lowerTask = task.toLowerCase();

	if (lowerTask.includes('pdf') || lowerTask.includes('document')) {
		return 'pdf';
	}

	if (
		lowerTask.includes('image') ||
		lowerTask.includes('picture') ||
		lowerTask.includes('photo') ||
		lowerTask.includes('img')
	) {
		return 'image';
	}

	if (lowerTask.includes('csv') || lowerTask.includes('spreadsheet')) {
		return 'csv';
	}

	return null;
}
