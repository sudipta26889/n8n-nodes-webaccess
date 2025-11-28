/**
 * Task intent inference for Web Access node
 * Interprets natural-language task descriptions to determine extraction goals
 */

import type { TaskIntent, WebAccessOperation } from './types';

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
