/**
 * Configuration constants for Web Access node
 * Centralized configuration values to avoid hardcoding
 */

/**
 * Maximum number of assets to download in a single operation.
 */
export const MAX_ASSETS = 50;

/**
 * Maximum number of crawl candidates to inspect.
 */
export const MAX_CRAWL_CANDIDATES = 20;

/**
 * Default Crawl4AI base URL.
 * Can be overridden via credentials or node parameter.
 */
export const DEFAULT_CRAWL4AI_BASE_URL = 'http://127.0.0.1:11235';

/**
 * Default HTTP request timeout in milliseconds.
 */
export const DEFAULT_HTTP_TIMEOUT = 30000;

/**
 * Default Puppeteer timeout in milliseconds.
 */
export const DEFAULT_PUPPETEER_TIMEOUT = 45000;

/**
 * Default Crawl4AI request timeout in milliseconds.
 */
export const DEFAULT_CRAWL4AI_TIMEOUT = 60000;

/**
 * Default FlareSolverr timeout in milliseconds.
 */
export const DEFAULT_FLARESOLVERR_TIMEOUT = 60000;

/**
 * Default OpenAI API timeout in milliseconds.
 */
export const DEFAULT_OPENAI_TIMEOUT = 60000;

/**
 * Maximum content length for LLM processing (characters).
 */
export const MAX_CONTENT_LENGTH_FOR_LLM = 30000;

/**
 * Maximum number of products to extract.
 */
export const MAX_PRODUCTS = 100;

/**
 * Maximum number of pages to crawl.
 */
export const MAX_CRAWL_PAGES = 100;

/**
 * Animation settle delay for screenshots (milliseconds).
 */
export const SCREENSHOT_ANIMATION_DELAY = 1000;

/**
 * Allowed URL protocols for security.
 */
export const ALLOWED_PROTOCOLS = ['http:', 'https:'];

/**
 * Blocked URL patterns for security (SSRF prevention).
 */
export const BLOCKED_URL_PATTERNS = [
	/^127\./,
	/^localhost/,
	/^0\.0\.0\.0/,
	/^::1/,
	/^192\.168\./,
	/^10\./,
	/^172\.(1[6-9]|2[0-9]|3[0-1])\./,
];

