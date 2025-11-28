/**
 * Agent Tools
 * 
 * Defines the tools available to the agentic LLM for web access tasks.
 * Each tool has a description for the LLM and an execute function.
 */

import { acquireContent, type AcquiredContent, type AcquireOptions } from '../stages/acquire';
import { extractInternalLinks } from '../utils/extraction';
import { crawl4aiCrawl } from '../strategies/crawl4ai';
import type { CrawledPage } from '../utils/types';

/**
 * Tool parameter definition.
 */
export interface ToolParam {
	name: string;
	type: 'string' | 'number' | 'boolean';
	description: string;
	required: boolean;
	default?: string | number | boolean;
}

/**
 * Tool definition.
 */
export interface AgentTool {
	name: string;
	description: string;
	params: ToolParam[];
}

/**
 * Tool call from LLM.
 */
export interface ToolCall {
	tool: string;
	params: Record<string, unknown>;
}

/**
 * Result of a tool execution.
 */
export interface ToolResult {
	success: boolean;
	data?: unknown;
	content?: AcquiredContent;
	pages?: CrawledPage[];
	error?: string;
}

/**
 * Context for tool execution.
 */
export interface ToolContext {
	flareSolverrUrl?: string;
	crawl4aiBaseUrl?: string;
	acquiredContent: Map<string, AcquiredContent>;
}

/**
 * Available tools for the agent.
 */
export const AGENT_TOOLS: AgentTool[] = [
	{
		name: 'scrape_url',
		description: 'Scrape content from a URL. Use this to get HTML and text content from a webpage.',
		params: [
			{
				name: 'url',
				type: 'string',
				description: 'The full URL to scrape (must include https://)',
				required: true,
			},
			{
				name: 'method',
				type: 'string',
				description: 'Scraping method: "http" (fast, default), "flaresolverr" (bypasses Cloudflare), "puppeteer" (renders JavaScript)',
				required: false,
				default: 'http',
			},
		],
	},
	{
		name: 'crawl_links',
		description: 'Discover and list internal links from a webpage. Use this to find related pages like /about, /contact, /products.',
		params: [
			{
				name: 'url',
				type: 'string',
				description: 'The base URL to crawl from',
				required: true,
			},
			{
				name: 'max_pages',
				type: 'number',
				description: 'Maximum number of pages to discover (default 10)',
				required: false,
				default: 10,
			},
		],
	},
	{
		name: 'complete',
		description: 'Return the final result. Call this when you have gathered enough information to answer the task.',
		params: [
			{
				name: 'result',
				type: 'string',
				description: 'Your complete text answer to the task. Be detailed and comprehensive.',
				required: true,
			},
		],
	},
];

/**
 * Execute a tool call.
 * 
 * @param {ToolCall} call - Tool call from LLM
 * @param {ToolContext} context - Execution context
 * @returns {Promise<ToolResult>} Result of tool execution
 */
export async function executeTool(
	call: ToolCall,
	context: ToolContext,
): Promise<ToolResult> {
	switch (call.tool) {
		case 'scrape_url':
			return executeScrapeTool(call.params, context);
		case 'crawl_links':
			return executeCrawlLinksTool(call.params, context);
		case 'complete':
			return executeCompleteTool(call.params);
		default:
			return {
				success: false,
				error: `Unknown tool: ${call.tool}`,
			};
	}
}

/**
 * Execute the scrape_url tool.
 */
async function executeScrapeTool(
	params: Record<string, unknown>,
	context: ToolContext,
): Promise<ToolResult> {
	const url = params.url as string;
	if (!url) {
		return { success: false, error: 'url parameter is required' };
	}

	const method = (params.method as string) || 'http';
	const validMethods = ['http', 'flaresolverr', 'puppeteer'];
	if (!validMethods.includes(method)) {
		return { success: false, error: `Invalid method: ${method}. Use one of: ${validMethods.join(', ')}` };
	}

	// Check if already scraped
	if (context.acquiredContent.has(url)) {
		const existing = context.acquiredContent.get(url)!;
		return {
			success: true,
			content: existing,
			data: {
				alreadyScraped: true,
				textPreview: existing.text.slice(0, 500),
			},
		};
	}

	const options: AcquireOptions = {
		flareSolverrUrl: context.flareSolverrUrl,
		preferredMethod: method as 'http' | 'flaresolverr' | 'puppeteer',
	};

	const content = await acquireContent(url, options);

	if (content.success) {
		context.acquiredContent.set(url, content);
		return {
			success: true,
			content,
			data: {
				method: content.method,
				textLength: content.text.length,
				textPreview: content.text.slice(0, 1000),
			},
		};
	}

	return {
		success: false,
		error: content.error || 'Failed to scrape URL',
	};
}

/**
 * Execute the crawl_links tool.
 */
async function executeCrawlLinksTool(
	params: Record<string, unknown>,
	context: ToolContext,
): Promise<ToolResult> {
	const url = params.url as string;
	if (!url) {
		return { success: false, error: 'url parameter is required' };
	}

	const maxPages = (params.max_pages as number) || 10;

	// Try Crawl4AI if available
	if (context.crawl4aiBaseUrl) {
		try {
			const pages = await crawl4aiCrawl(context.crawl4aiBaseUrl, url, maxPages);
			if (pages.length > 0) {
				return {
					success: true,
					pages,
					data: {
						pagesFound: pages.length,
						pages: pages.slice(0, maxPages).map(p => ({
							url: p.url,
							title: p.title,
						})),
					},
				};
			}
		} catch {
			// Fall through to HTML parsing
		}
	}

	// Fallback: Get page content and extract links
	let content = context.acquiredContent.get(url);
	if (!content) {
		content = await acquireContent(url, { flareSolverrUrl: context.flareSolverrUrl });
		if (content.success) {
			context.acquiredContent.set(url, content);
		}
	}

	if (content && content.html) {
		const links = extractInternalLinks(content.html, url);
		const pages = links.slice(0, maxPages).map(linkUrl => ({
			url: linkUrl,
			title: undefined,
		}));

		return {
			success: true,
			pages,
			data: {
				pagesFound: links.length,
				pages: pages.map(p => ({ url: p.url })),
			},
		};
	}

	return {
		success: false,
		error: 'Could not crawl links from URL',
	};
}

/**
 * Execute the complete tool.
 */
function executeCompleteTool(params: Record<string, unknown>): ToolResult {
	const result = params.result as string;
	if (!result) {
		return { success: false, error: 'result parameter is required' };
	}

	return {
		success: true,
		data: { result },
	};
}

/**
 * Format tools as a description for the LLM.
 */
export function formatToolsForLLM(): string {
	return AGENT_TOOLS.map(tool => {
		const paramsStr = tool.params.map(p => 
			`  - ${p.name} (${p.type}${p.required ? ', required' : ', optional'}): ${p.description}`
		).join('\n');
		return `${tool.name}: ${tool.description}\n${paramsStr}`;
	}).join('\n\n');
}

