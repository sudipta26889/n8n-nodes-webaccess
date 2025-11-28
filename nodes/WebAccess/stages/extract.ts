/**
 * Stage 2: Non-LLM Extraction
 * 
 * Attempts to extract data from acquired content using pattern matching,
 * regex, and DOM parsing. Tracks what was attempted for LLM context.
 */

import type { AcquiredContent } from './acquire';
import {
	extractEmails,
	extractPhones,
	extractTextContent,
	extractPageTitle,
	extractProductsFromHtml,
} from '../utils/extraction';

/**
 * Result of a non-LLM extraction attempt.
 */
export interface ExtractionAttempt {
	/** Whether extraction was successful */
	success: boolean;
	/** Extracted data if successful */
	data: ExtractionData | null;
	/** List of extraction methods that were tried */
	whatWasTried: string[];
	/** Human-readable reason for the result */
	reason: string;
	/** Detected intent from task */
	detectedIntent: DetectedIntent;
}

/**
 * Extracted data structure.
 */
export interface ExtractionData {
	/** Page title */
	title?: string;
	/** Extracted text (for text-based tasks) */
	text?: string;
	/** Extracted email addresses */
	emails?: string[];
	/** Extracted phone numbers */
	phones?: string[];
	/** Extracted products */
	products?: Array<{ name: string; url: string; price?: string }>;
	/** Raw data for unstructured extraction */
	raw?: string;
}

/**
 * Detected intent from task description.
 */
export interface DetectedIntent {
	wantsEmail: boolean;
	wantsPhone: boolean;
	wantsProducts: boolean;
	wantsText: boolean;
	wantsScreenshot: boolean;
	wantsDownload: boolean;
	isResearch: boolean;
	isGeneral: boolean;
	/** Complex multi-step task that requires LLM */
	isComplexTask: boolean;
	/** Task requires navigation/pagination */
	requiresNavigation: boolean;
	/** Task asks for structured data extraction */
	wantsStructuredData: boolean;
}

/**
 * Detect user intent from task description.
 * 
 * Analyzes the task to determine what kind of extraction is needed.
 * 
 * @param {string} task - Task description
 * @returns {DetectedIntent} Detected intent flags
 */
export function detectIntent(task: string): DetectedIntent {
	const lowerTask = task.toLowerCase().trim();

	const wantsEmail = 
		lowerTask.includes('email') ||
		lowerTask.includes('e-mail') ||
		lowerTask.includes('contact') ||
		lowerTask.includes('mailto');

	const wantsPhone = 
		lowerTask.includes('phone') ||
		lowerTask.includes('telephone') ||
		lowerTask.includes('call') ||
		lowerTask.includes('mobile') ||
		lowerTask.includes('number');

	const wantsProducts = 
		lowerTask.includes('product') ||
		lowerTask.includes('item') ||
		lowerTask.includes('catalog') ||
		lowerTask.includes('price') ||
		lowerTask.includes('shop') ||
		lowerTask.includes('store') ||
		lowerTask.includes('buy');

	const wantsText = 
		lowerTask.includes('text') ||
		lowerTask.includes('content') ||
		lowerTask.includes('article') ||
		lowerTask.includes('read') ||
		lowerTask.includes('extract');

	const wantsScreenshot = 
		lowerTask.includes('screenshot') ||
		lowerTask.includes('capture') ||
		lowerTask.includes('image of') ||
		lowerTask.includes('picture of');

	const wantsDownload = 
		lowerTask.includes('download') ||
		lowerTask.includes('pdf') ||
		lowerTask.includes('file') ||
		lowerTask.includes('save');

	const isResearch = 
		lowerTask.includes('research') ||
		lowerTask.includes('learn about') ||
		lowerTask.includes('tell me about') ||
		lowerTask.includes('information about') ||
		lowerTask.includes('details') ||
		lowerTask.includes('overview') ||
		lowerTask.includes('summary');

	// Detect complex multi-step tasks
	const isComplexTask = 
		/\bthen\b/.test(lowerTask) ||                    // "first X, then Y"
		/\band\s+then\b/.test(lowerTask) ||              // "do X and then Y"
		/\bfirst\b.*\bthen\b/.test(lowerTask) ||         // "first do X, then Y"
		/\bafter\b.*\b(do|get|extract)\b/.test(lowerTask) || // "after X, do Y"
		(lowerTask.match(/,/g) || []).length >= 2 ||     // Multiple comma-separated steps
		/\b(step|steps)\s*\d/i.test(lowerTask) ||        // "step 1, step 2"
		/\ball\b.*\bfrom\b.*\bpage\b/i.test(lowerTask);  // "all X from page"

	// Detect navigation/pagination requirements
	const requiresNavigation = 
		lowerTask.includes('pagination') ||
		lowerTask.includes('next page') ||
		lowerTask.includes('next button') ||
		lowerTask.includes('follow') ||
		lowerTask.includes('navigate') ||
		lowerTask.includes('click') ||
		lowerTask.includes('page 2') ||
		lowerTask.includes('page 3') ||
		/\bpage\s+\d+\b/.test(lowerTask) ||              // "page N"
		/\bpages?\s+\d+\s*(to|-)\s*\d+\b/.test(lowerTask); // "pages 1-5"

	// Detect structured data with relationships
	const wantsStructuredData = 
		/\bwith\s+(their|the|its)\b/.test(lowerTask) ||  // "quotes with their authors"
		/\b(and|with)\s+(author|tag|price|name|date|title)s?\b/.test(lowerTask) || // "X with authors/tags"
		/\b\d+\s+(quote|item|product|record|result)s?\b/.test(lowerTask) || // "10 quotes"
		/\ball\s+(quote|item|product|record|result|link)s?\b/.test(lowerTask); // "all quotes"

	// General if no specific intent detected
	const isGeneral = !wantsEmail && !wantsPhone && !wantsProducts && 
		!wantsText && !wantsScreenshot && !wantsDownload && !isResearch &&
		!isComplexTask && !requiresNavigation && !wantsStructuredData;

	return {
		wantsEmail,
		wantsPhone,
		wantsProducts,
		wantsText,
		wantsScreenshot,
		wantsDownload,
		isResearch,
		isGeneral,
		isComplexTask,
		requiresNavigation,
		wantsStructuredData,
	};
}

/**
 * Attempt non-LLM extraction from acquired content.
 * 
 * Tries pattern matching and DOM parsing based on detected intent.
 * Tracks what was attempted for context if LLM fallback is needed.
 * 
 * @param {AcquiredContent} content - Acquired content from Stage 1
 * @param {string} task - Task description
 * @returns {ExtractionAttempt} Extraction result with tracking info
 */
export function tryNonLlmExtraction(
	content: AcquiredContent,
	task: string,
): ExtractionAttempt {
	const whatWasTried: string[] = [];
	const intent = detectIntent(task);
	const data: ExtractionData = {};
	let foundData = false;

	// Always extract title
	data.title = extractPageTitle(content.html);
	whatWasTried.push('page_title_extraction');

	// Extract based on intent
	if (intent.wantsEmail || intent.isResearch || intent.isGeneral) {
		whatWasTried.push('email_regex_extraction');
		const emails = extractEmails(content.html);
		if (emails.length > 0) {
			data.emails = emails;
			foundData = true;
		}
	}

	if (intent.wantsPhone || intent.isResearch || intent.isGeneral) {
		whatWasTried.push('phone_regex_extraction');
		const phones = extractPhones(content.text);
		if (phones.length > 0) {
			data.phones = phones;
			foundData = true;
		}
	}

	if (intent.wantsProducts) {
		whatWasTried.push('product_dom_extraction');
		const products = extractProductsFromHtml(content.html, content.url);
		if (products.length > 0) {
			data.products = products;
			foundData = true;
		}
	}

	if (intent.wantsText) {
		whatWasTried.push('text_content_extraction');
		const text = extractTextContent(content.html);
		if (text.length > 0) {
			data.text = text;
			foundData = true;
		}
	}

	// For research/general tasks, include text content
	if (intent.isResearch || intent.isGeneral) {
		whatWasTried.push('text_content_extraction');
		data.text = content.text || extractTextContent(content.html);
	}

	// Determine success and reason
	if (intent.wantsEmail && (!data.emails || data.emails.length === 0)) {
		return {
			success: false,
			data: foundData ? data : null,
			whatWasTried,
			reason: 'No email addresses found in content',
			detectedIntent: intent,
		};
	}

	if (intent.wantsPhone && (!data.phones || data.phones.length === 0)) {
		return {
			success: false,
			data: foundData ? data : null,
			whatWasTried,
			reason: 'No phone numbers found in content',
			detectedIntent: intent,
		};
	}

	if (intent.wantsProducts && (!data.products || data.products.length === 0)) {
		return {
			success: false,
			data: foundData ? data : null,
			whatWasTried,
			reason: 'No products found in content',
			detectedIntent: intent,
		};
	}

	// Complex multi-step tasks require LLM
	if (intent.isComplexTask) {
		return {
			success: false,
			data,
			whatWasTried,
			reason: 'Complex multi-step task requires LLM orchestration',
			detectedIntent: intent,
		};
	}

	// Navigation/pagination tasks require LLM agent
	if (intent.requiresNavigation) {
		return {
			success: false,
			data,
			whatWasTried,
			reason: 'Task requires navigation/pagination which needs LLM agent',
			detectedIntent: intent,
		};
	}

	// Structured data extraction needs LLM understanding
	if (intent.wantsStructuredData) {
		return {
			success: false,
			data,
			whatWasTried,
			reason: 'Structured data extraction with relationships requires LLM',
			detectedIntent: intent,
		};
	}

	// Research tasks always need LLM for synthesis
	if (intent.isResearch) {
		return {
			success: false,
			data,
			whatWasTried,
			reason: 'Research task requires LLM synthesis of content',
			detectedIntent: intent,
		};
	}

	// General tasks with specific asks need LLM
	if (intent.isGeneral && task.includes('?')) {
		return {
			success: false,
			data,
			whatWasTried,
			reason: 'Question-based task requires LLM to answer',
			detectedIntent: intent,
		};
	}

	// Screenshot/download tasks are handled separately
	if (intent.wantsScreenshot) {
		return {
			success: false,
			data: null,
			whatWasTried: ['intent_detection'],
			reason: 'Screenshot task requires Puppeteer, not extraction',
			detectedIntent: intent,
		};
	}

	if (intent.wantsDownload) {
		return {
			success: false,
			data: null,
			whatWasTried: ['intent_detection'],
			reason: 'Download task requires asset extraction, not text extraction',
			detectedIntent: intent,
		};
	}

	// If we found data for the intent, success
	if (foundData) {
		return {
			success: true,
			data,
			whatWasTried,
			reason: 'Successfully extracted requested data',
			detectedIntent: intent,
		};
	}

	// Default: need LLM
	return {
		success: false,
		data: { text: content.text },
		whatWasTried,
		reason: 'Could not extract specific data, LLM needed for interpretation',
		detectedIntent: intent,
	};
}

/**
 * Format extraction data as text response.
 * 
 * Converts structured extraction data into a human-readable text format.
 * 
 * @param {ExtractionData} data - Extracted data
 * @returns {string} Formatted text response
 */
export function formatExtractionAsText(data: ExtractionData): string {
	const parts: string[] = [];

	if (data.title) {
		parts.push(`Page: ${data.title}`);
	}

	if (data.emails && data.emails.length > 0) {
		parts.push(`\nEmail${data.emails.length > 1 ? 's' : ''}: ${data.emails.join(', ')}`);
	}

	if (data.phones && data.phones.length > 0) {
		parts.push(`\nPhone${data.phones.length > 1 ? 's' : ''}: ${data.phones.join(', ')}`);
	}

	if (data.products && data.products.length > 0) {
		parts.push(`\n\nProducts found: ${data.products.length}`);
		data.products.slice(0, 10).forEach((p, i) => {
			parts.push(`${i + 1}. ${p.name}${p.price ? ` - ${p.price}` : ''}`);
			parts.push(`   ${p.url}`);
		});
		if (data.products.length > 10) {
			parts.push(`... and ${data.products.length - 10} more`);
		}
	}

	if (parts.length === 0 && data.text) {
		// Just return text content if no structured data
		return data.text.slice(0, 5000);
	}

	return parts.join('\n');
}

