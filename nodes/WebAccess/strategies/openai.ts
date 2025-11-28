/**
 * OpenAI-compatible API strategy for Web Access node
 * Handles LLM-based extraction using any OpenAI-compatible API
 */

import type { OpenAIConfig } from '../utils/types';
import { DEFAULT_OPENAI_TIMEOUT, MAX_CONTENT_LENGTH_FOR_LLM } from '../utils/config';

// Default timeout in milliseconds
const DEFAULT_TIMEOUT = DEFAULT_OPENAI_TIMEOUT;

/**
 * Response structure from OpenAI chat completions API
 */
interface ChatCompletionResponse {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: Array<{
		index: number;
		message: {
			role: string;
			content: string;
		};
		finish_reason: string;
	}>;
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

/**
 * Extract information from text using OpenAI-compatible API.
 * 
 * Uses chat completions API to extract information based on task description.
 * 
 * @param {OpenAIConfig} config - OpenAI-compatible API configuration
 * @param {string} model - Model name to use
 * @param {string} pageContent - Web page content to extract from
 * @param {string} task - Task description for extraction
 * @returns {Promise<{ success: boolean; text?: string; error?: string }>} Extraction result
 */
export async function openaiExtract(
	config: OpenAIConfig,
	model: string,
	pageContent: string,
	task: string,
): Promise<{ success: boolean; text?: string; error?: string }> {
	const { apiKey, baseUrl } = config;

	// Truncate content if too long (most models have context limits)
	const truncatedContent =
		pageContent.length > MAX_CONTENT_LENGTH_FOR_LLM
			? pageContent.substring(0, MAX_CONTENT_LENGTH_FOR_LLM) + '\n\n[Content truncated...]'
			: pageContent;

	const systemPrompt = `You are a data extraction assistant. Your task is to extract specific information from web page content based on the user's request.

Rules:
- Only return the requested information, no explanations
- If extracting emails, return them one per line
- If extracting phone numbers, return them one per line
- If the requested information is not found, respond with "NOT_FOUND"
- Be concise and precise`;

	const userPrompt = `Task: ${task}

Web page content:
${truncatedContent}

Extract the requested information:`;

	try {
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model,
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: userPrompt },
				],
				temperature: 0.1,
				max_tokens: 2000,
			}),
			signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
		});

		if (!response.ok) {
			const errorText = await response.text();
			return {
				success: false,
				error: `OpenAI API error (${response.status}): ${errorText}`,
			};
		}

		const data = (await response.json()) as ChatCompletionResponse;
		const content = data.choices?.[0]?.message?.content?.trim();

		if (!content || content === 'NOT_FOUND') {
			return {
				success: false,
				error: 'LLM could not find the requested information',
			};
		}

		return {
			success: true,
			text: content,
		};
	} catch (error) {
		return {
			success: false,
			error: `OpenAI API call failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
		};
	}
}

/**
 * Extract contact information (emails/phones) using OpenAI.
 * 
 * Specialized function for extracting contact information with structured JSON output.
 * 
 * @param {OpenAIConfig} config - OpenAI-compatible API configuration
 * @param {string} model - Model name to use
 * @param {string} pageContent - Web page content to extract from
 * @param {boolean} wantsEmail - Whether to extract email addresses
 * @param {boolean} wantsPhone - Whether to extract phone numbers
 * @returns {Promise<{ emails?: string[]; phones?: string[]; error?: string }>} Contact extraction result
 */
export async function openaiExtractContacts(
	config: OpenAIConfig,
	model: string,
	pageContent: string,
	wantsEmail: boolean,
	wantsPhone: boolean,
): Promise<{ emails?: string[]; phones?: string[]; error?: string }> {
	const { apiKey, baseUrl } = config;

	// Truncate content if too long
	const truncatedContent =
		pageContent.length > MAX_CONTENT_LENGTH_FOR_LLM
			? pageContent.substring(0, MAX_CONTENT_LENGTH_FOR_LLM) + '\n\n[Content truncated...]'
			: pageContent;

	const requestedInfo: string[] = [];
	if (wantsEmail) requestedInfo.push('email addresses');
	if (wantsPhone) requestedInfo.push('phone numbers');

	const systemPrompt = `You are a contact information extraction assistant. Extract contact details from web page content.

Output format:
- Return valid JSON object with "emails" array and/or "phones" array
- Each email should be a valid email address
- Each phone should be in a consistent format
- If nothing found, return empty arrays
- Example: {"emails": ["contact@example.com"], "phones": ["+1-555-123-4567"]}`;

	const userPrompt = `Extract ${requestedInfo.join(' and ')} from this web page content:

${truncatedContent}

Return only valid JSON:`;

	try {
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model,
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: userPrompt },
				],
				temperature: 0.1,
				max_tokens: 1000,
			}),
			signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
		});

		if (!response.ok) {
			const errorText = await response.text();
			return {
				error: `OpenAI API error (${response.status}): ${errorText}`,
			};
		}

		const data = (await response.json()) as ChatCompletionResponse;
		const content = data.choices?.[0]?.message?.content?.trim();

		if (!content) {
			return { error: 'Empty response from LLM' };
		}

		// Try to parse JSON from response
		try {
			// Handle potential markdown code blocks
			const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
			const jsonStr = jsonMatch[1] || content;
			const parsed = JSON.parse(jsonStr) as { emails?: string[]; phones?: string[] };

			return {
				emails: parsed.emails || [],
				phones: parsed.phones || [],
			};
		} catch {
			// If JSON parsing fails, try to extract from plain text
			const emails: string[] = [];
			const phones: string[] = [];

			// Simple email regex extraction
			const emailMatches = content.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
			if (emailMatches) {
				emails.push(...emailMatches);
			}

			// Simple phone regex extraction
			const phoneMatches = content.match(
				/(?:\+?[1-9]\d{0,2}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{3,4}/g,
			);
			if (phoneMatches) {
				phones.push(...phoneMatches);
			}

			return { emails, phones };
		}
	} catch (error) {
		return {
			error: `OpenAI API call failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
		};
	}
}
