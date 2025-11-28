/**
 * Extraction utilities for Web Access node
 * Provides robust extraction of emails, phones, products, assets from HTML/text
 */

// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports -- Required for HTML parsing in self-hosted deployments
import * as cheerio from 'cheerio';
import type { ProductSummary, AssetType } from './types';
import { ALLOWED_PROTOCOLS, BLOCKED_URL_PATTERNS } from './config';

// Email regex - comprehensive pattern for common email formats
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Phone regex - supports various formats with optional country codes
const PHONE_REGEX = /(?:\+?[1-9]\d{0,2}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{3,4}/g;

// Common junk email patterns to filter out
const JUNK_EMAIL_PATTERNS = [
	/^[a-f0-9]{32}@/i, // MD5-like hashes
	/@example\.com$/i,
	/@test\.com$/i,
	/@localhost$/i,
	/noreply@/i,
	/no-reply@/i,
	/@sentry\./i,
	/@wixpress\.com$/i,
	/\.png@/i,
	/\.jpg@/i,
	/\.gif@/i,
];

// Asset extensions by type
const ASSET_EXTENSIONS: Record<AssetType, string[]> = {
	pdf: ['.pdf'],
	image: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg', '.bmp'],
	csv: ['.csv'],
};

/**
 * Validate URL for security (SSRF prevention).
 * 
 * Checks that the URL uses allowed protocols and doesn't match
 * blocked patterns (localhost, private IPs, etc.).
 * 
 * @param {string} url - The URL to validate
 * @returns {{ valid: boolean; error?: string }} Validation result
 */
export function validateUrl(url: string): { valid: boolean; error?: string } {
	if (!url || typeof url !== 'string') {
		return { valid: false, error: 'URL must be a non-empty string' };
	}

	try {
		const urlObj = new URL(url);

		// Check protocol
		if (!ALLOWED_PROTOCOLS.includes(urlObj.protocol)) {
			return { valid: false, error: `Protocol ${urlObj.protocol} is not allowed. Only http: and https: are permitted.` };
		}

		// Check for blocked patterns
		const hostname = urlObj.hostname.toLowerCase();
		for (const pattern of BLOCKED_URL_PATTERNS) {
			if (pattern.test(hostname)) {
				return { valid: false, error: 'URL matches blocked pattern (localhost or private IP)' };
			}
		}

		return { valid: true };
	} catch (error) {
		return { valid: false, error: `Invalid URL format: ${error instanceof Error ? error.message : 'Unknown error'}` };
	}
}

/**
 * Check if an email matches junk patterns.
 * 
 * Filters out common junk email patterns like test emails, noreply addresses, etc.
 * 
 * @param {string} email - Email address to check
 * @returns {boolean} True if email matches junk patterns
 */
function isJunkEmail(email: string): boolean {
	for (const pattern of JUNK_EMAIL_PATTERNS) {
		if (pattern.test(email)) return true;
	}
	return false;
}

/**
 * Extract email addresses from text or HTML content.
 * 
 * Handles obfuscated emails (e.g., "user [at] domain [dot] com") and deduplicates results.
 * Filters out junk emails and validates format.
 * 
 * @param {string} textOrHtml - Text or HTML content to extract emails from
 * @returns {string[]} Array of unique email addresses
 */
export function extractEmails(textOrHtml: string): string[] {
	if (!textOrHtml) return [];

	const emails = new Set<string>();

	// First, decode common obfuscation patterns
	const decoded = textOrHtml
		// HTML entities
		.replace(/&#64;/g, '@')
		.replace(/&#46;/g, '.')
		.replace(/&commat;/g, '@')
		.replace(/&period;/g, '.')
		// Common text obfuscation
		.replace(/\s*\[at\]\s*/gi, '@')
		.replace(/\s*\(at\)\s*/gi, '@')
		.replace(/\s*\{at\}\s*/gi, '@')
		.replace(/\s*@\s*/g, '@') // spaces around @
		.replace(/\s*\[dot\]\s*/gi, '.')
		.replace(/\s*\(dot\)\s*/gi, '.')
		.replace(/\s*\{dot\}\s*/gi, '.')
		// Variations
		.replace(/\s*\[AT\]\s*/g, '@')
		.replace(/\s*\[DOT\]\s*/g, '.')
		.replace(/\bat\b/gi, (match, offset, str) => {
			// Only replace 'at' if it looks like email context
			const before = str.substring(Math.max(0, offset - 20), offset);
			const after = str.substring(offset + match.length, offset + match.length + 20);
			if (/[a-z0-9]$/i.test(before) && /^[a-z0-9]/i.test(after)) {
				return '@';
			}
			return match;
		});

	// Extract from mailto: links (highest quality)
	const mailtoMatches = decoded.match(/mailto:([^"'\s<>?#]+)/gi) || [];
	mailtoMatches.forEach((m) => {
		const email = m.replace(/^mailto:/i, '').split('?')[0].split('#')[0];
		if (email.includes('@') && email.includes('.') && !isJunkEmail(email)) {
			emails.add(email.toLowerCase().trim());
		}
	});

	// Extract from href attributes containing email-like patterns
	const hrefMatches = decoded.match(/href=["'][^"']*@[^"']*["']/gi) || [];
	hrefMatches.forEach((m) => {
		const emailMatch = m.match(EMAIL_REGEX);
		if (emailMatch) {
			emailMatch.forEach((email) => {
				if (!isJunkEmail(email)) {
					emails.add(email.toLowerCase().trim());
				}
			});
		}
	});

	// Extract standard email patterns
	const standardMatches = decoded.match(EMAIL_REGEX) || [];
	standardMatches.forEach((email) => {
		if (!isJunkEmail(email)) {
			emails.add(email.toLowerCase().trim());
		}
	});

	// Filter results
	return Array.from(emails).filter((email) => {
		// Basic validation
		if (email.length < 5 || email.length > 254) return false;
		if (!email.includes('@') || !email.includes('.')) return false;
		// Must have valid TLD
		const parts = email.split('.');
		const tld = parts[parts.length - 1];
		if (tld.length < 2 || tld.length > 10) return false;
		return true;
	});
}

/**
 * Generate common contact page URLs for a website.
 * 
 * Creates a list of common contact page URL patterns based on the base URL.
 * Used for faster contact information discovery without full crawling.
 * 
 * @param {string} baseUrl - Base URL of the website
 * @returns {string[]} Array of potential contact page URLs
 */
export function getContactPageUrls(baseUrl: string): string[] {
	try {
		const url = new URL(baseUrl);
		const base = `${url.protocol}//${url.host}`;
		return [
			`${base}/contact`,
			`${base}/contact-us`,
			`${base}/contactus`,
			`${base}/contact.html`,
			`${base}/pages/contact`,
			`${base}/pages/contact-us`,
			`${base}/about`,
			`${base}/about-us`,
			`${base}/aboutus`,
			`${base}/pages/about`,
			`${base}/pages/about-us`,
			`${base}/support`,
			`${base}/help`,
			`${base}/customer-service`,
			`${base}/customer-care`,
			`${base}/info`,
			`${base}/information`,
			`${base}/get-in-touch`,
			`${base}/reach-us`,
		];
	} catch {
		return [];
	}
}

/**
 * Extract phone numbers from text content.
 * 
 * Filters by reasonable length (7-15 digits) and deduplicates results.
 * Removes formatting characters for consistency.
 * 
 * @param {string} text - Text content to extract phones from
 * @returns {string[]} Array of unique phone numbers
 */
export function extractPhones(text: string): string[] {
	if (!text) return [];

	const matches = text.match(PHONE_REGEX) || [];

	// Clean and deduplicate
	const cleaned = matches
		.map((phone) => phone.replace(/[-.\s()]/g, '')) // Remove formatting
		.filter((phone) => {
			// Must be 7-15 digits (international standard)
			const digitsOnly = phone.replace(/\D/g, '');
			return digitsOnly.length >= 7 && digitsOnly.length <= 15;
		});

	return [...new Set(cleaned)];
}

/**
 * Extract visible text content from HTML.
 * 
 * Strips tags, scripts, styles, and normalizes whitespace.
 * Removes hidden elements and returns clean text content.
 * 
 * @param {string} html - HTML content to extract text from
 * @returns {string} Extracted and normalized text content
 */
export function extractTextContent(html: string): string {
	if (!html) return '';

	const $ = cheerio.load(html);

	// Remove scripts, styles, and hidden elements
	$('script, style, noscript, iframe, svg, [hidden], [style*="display:none"], [style*="display: none"]').remove();

	// Get text content
	const text = $('body').text() || $.root().text();

	// Normalize whitespace
	return text.replace(/\s+/g, ' ').trim();
}

/**
 * Extract page title from HTML.
 * 
 * Extracts the page title from <title> tag or falls back to first <h1>.
 * 
 * @param {string} html - HTML content to extract title from
 * @returns {string} Page title or empty string if not found
 */
export function extractPageTitle(html: string): string {
	if (!html) return '';

	const $ = cheerio.load(html);
	return $('title').first().text().trim() || $('h1').first().text().trim() || '';
}

/**
 * Extract products from HTML using common e-commerce patterns.
 * 
 * Best-effort extraction based on DOM heuristics. Looks for product cards,
 * product links, names, and prices using common CSS selectors.
 * 
 * @param {string} html - HTML content to extract products from
 * @param {string} [baseUrl] - Base URL for resolving relative product URLs
 * @returns {ProductSummary[]} Array of extracted products
 */
export function extractProductsFromHtml(html: string, baseUrl?: string): ProductSummary[] {
	if (!html) return [];

	const $ = cheerio.load(html);
	const products: ProductSummary[] = [];
	const seenUrls = new Set<string>();

	// Common product card selectors
	const productSelectors = [
		'[class*="product"]',
		'[class*="item"]',
		'[class*="card"]',
		'[data-product]',
		'[data-item]',
		'article',
		'.grid-item',
		'.collection-item',
	];

	for (const selector of productSelectors) {
		$(selector).each((_, element) => {
			const $el = $(element);

			// Find product link
			const $link = $el.find('a[href*="/product"], a[href*="/item"], a[href*="/p/"]').first();
			if ($link.length === 0) {
				// Try any link with reasonable href
				const $anyLink = $el.find('a[href]').first();
				if ($anyLink.length === 0) return;
			}

			const linkEl = $link.length > 0 ? $link : $el.find('a[href]').first();
			let href = linkEl.attr('href') || '';

			// Skip if no href or already seen
			if (!href || seenUrls.has(href)) return;

			// Make absolute URL
			if (baseUrl && !href.startsWith('http')) {
				try {
					href = new URL(href, baseUrl).href;
				} catch {
					return;
				}
			}

			// Find product name
			const nameSelectors = [
				'[class*="title"]',
				'[class*="name"]',
				'h2',
				'h3',
				'h4',
				'.product-title',
				'.item-name',
			];
			let name = '';
			for (const nameSel of nameSelectors) {
				const $name = $el.find(nameSel).first();
				if ($name.length > 0) {
					name = $name.text().trim();
					if (name) break;
				}
			}
			if (!name) {
				name = linkEl.text().trim() || linkEl.attr('title') || '';
			}

			// Skip if no meaningful name
			if (!name || name.length < 2) return;

			// Find price
			const priceSelectors = ['[class*="price"]', '[data-price]', '.amount', '.money'];
			let price: string | undefined;
			for (const priceSel of priceSelectors) {
				const $price = $el.find(priceSel).first();
				if ($price.length > 0) {
					price = $price.text().trim();
					if (price) break;
				}
			}

			seenUrls.add(href);
			products.push({ name, url: href, price });
		});

		// Stop if we found products
		if (products.length > 0) break;
	}

	return products;
}

/**
 * Extract asset URLs from HTML based on asset type.
 * 
 * Finds links and images matching the specified asset type (PDF, image, CSV).
 * Resolves relative URLs to absolute URLs.
 * 
 * @param {string} html - HTML content to extract asset URLs from
 * @param {string} baseUrl - Base URL for resolving relative URLs
 * @param {AssetType} assetType - Type of assets to extract ('pdf', 'image', 'csv')
 * @returns {string[]} Array of absolute asset URLs
 */
export function extractAssetUrls(html: string, baseUrl: string, assetType: AssetType): string[] {
	if (!html) return [];

	const $ = cheerio.load(html);
	const extensions = ASSET_EXTENSIONS[assetType];
	const urls: string[] = [];
	const seenUrls = new Set<string>();

	// Check all links
	$('a[href]').each((_, element) => {
		const href = $(element).attr('href');
		if (!href) return;

		const lowerHref = href.toLowerCase();
		const hasExtension = extensions.some((ext) => lowerHref.endsWith(ext));

		if (hasExtension) {
			try {
				const absoluteUrl = new URL(href, baseUrl).href;
				if (!seenUrls.has(absoluteUrl)) {
					seenUrls.add(absoluteUrl);
					urls.push(absoluteUrl);
				}
			} catch {
				// Invalid URL, skip
			}
		}
	});

	// For images, also check img src
	if (assetType === 'image') {
		$('img[src]').each((_, element) => {
			const src = $(element).attr('src');
			if (!src) return;

			try {
				const absoluteUrl = new URL(src, baseUrl).href;
				if (!seenUrls.has(absoluteUrl)) {
					seenUrls.add(absoluteUrl);
					urls.push(absoluteUrl);
				}
			} catch {
				// Invalid URL, skip
			}
		});
	}

	return urls;
}

/**
 * Extract all internal links from HTML (same domain).
 * 
 * Finds all links that belong to the same domain as the base URL.
 * Filters out anchors, javascript: links, and mailto: links.
 * 
 * @param {string} html - HTML content to extract links from
 * @param {string} baseUrl - Base URL for domain comparison
 * @returns {string[]} Array of internal link URLs
 */
export function extractInternalLinks(html: string, baseUrl: string): string[] {
	if (!html) return [];

	const $ = cheerio.load(html);
	const links: string[] = [];
	const seenUrls = new Set<string>();

	let baseDomain: string;
	try {
		baseDomain = new URL(baseUrl).hostname;
	} catch {
		return [];
	}

	$('a[href]').each((_, element) => {
		const href = $(element).attr('href');
		if (!href) return;

		try {
			const absoluteUrl = new URL(href, baseUrl);

			// Check same domain
			if (absoluteUrl.hostname !== baseDomain) return;

			// Skip anchors, javascript, mailto
			if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return;

			const urlStr = absoluteUrl.href;
			if (!seenUrls.has(urlStr)) {
				seenUrls.add(urlStr);
				links.push(urlStr);
			}
		} catch {
			// Invalid URL, skip
		}
	});

	return links;
}

/**
 * Check if HTML content appears to be blocked (CAPTCHA, 403, etc.).
 * 
 * Detects common blocking patterns like CAPTCHA pages, Cloudflare challenges,
 * access denied pages, and suspiciously short content.
 * 
 * @param {string} html - HTML content to check
 * @returns {boolean} True if content appears to be blocked
 */
export function isBlockedContent(html: string): boolean {
	if (!html) return true;

	const lowerHtml = html.toLowerCase();

	const blockIndicators = [
		'captcha',
		'cloudflare',
		'access denied',
		'403 forbidden',
		'blocked',
		'rate limit',
		'too many requests',
		'please verify',
		'are you a robot',
		'human verification',
	];

	for (const indicator of blockIndicators) {
		if (lowerHtml.includes(indicator)) {
			return true;
		}
	}

	// Also check if content is suspiciously short
	const text = extractTextContent(html);
	if (text.length < 100 && lowerHtml.includes('<!doctype')) {
		return true;
	}

	return false;
}
