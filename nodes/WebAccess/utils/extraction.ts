/**
 * Extraction utilities for Web Access node
 * Provides robust extraction of emails, phones, products, assets from HTML/text
 */

// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports -- Required for HTML parsing in self-hosted deployments
import * as cheerio from 'cheerio';
import type { ProductSummary, AssetType } from './types';

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
 * Extract email addresses from text or HTML content
 * Deduplicates and filters out obvious junk emails
 */
export function extractEmails(textOrHtml: string): string[] {
	if (!textOrHtml) return [];

	const matches = textOrHtml.match(EMAIL_REGEX) || [];

	// Also look for mailto: links
	const mailtoMatches = textOrHtml.match(/mailto:([^"'\s<>]+)/gi) || [];
	const mailtoEmails = mailtoMatches.map((m) => m.replace(/^mailto:/i, '').split('?')[0]);

	// Combine and deduplicate
	const allEmails = [...matches, ...mailtoEmails];
	const uniqueEmails = [...new Set(allEmails.map((e) => e.toLowerCase()))];

	// Filter out junk
	return uniqueEmails.filter((email) => {
		// Basic validation
		if (email.length < 5 || email.length > 254) return false;
		if (!email.includes('@') || !email.includes('.')) return false;

		// Check against junk patterns
		for (const pattern of JUNK_EMAIL_PATTERNS) {
			if (pattern.test(email)) return false;
		}

		return true;
	});
}

/**
 * Extract phone numbers from text content
 * Filters by reasonable length and deduplicates
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
 * Extract visible text content from HTML
 * Strips tags, scripts, styles, and normalizes whitespace
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
 * Extract page title from HTML
 */
export function extractPageTitle(html: string): string {
	if (!html) return '';

	const $ = cheerio.load(html);
	return $('title').first().text().trim() || $('h1').first().text().trim() || '';
}

/**
 * Extract products from HTML using common e-commerce patterns
 * Best-effort extraction based on DOM heuristics
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
 * Extract asset URLs from HTML based on asset type
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
 * Extract all internal links from HTML (same domain)
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
 * Check if HTML content appears to be blocked (CAPTCHA, 403, etc.)
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
