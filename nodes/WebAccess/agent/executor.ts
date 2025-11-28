/**
 * Agent Executor
 * 
 * Implements the ReAct (Reasoning + Acting) loop for agentic web access.
 * The LLM thinks step-by-step and calls tools to gather information.
 */

import type { AcquiredContent } from '../stages/acquire';
import type { ExtractionAttempt } from '../stages/extract';
import type { OpenAIConfig } from '../utils/types';
import {
	executeTool,
	type ToolCall,
	type ToolContext,
} from './tools';
import {
	buildSystemPrompt,
	buildUserPrompt,
	buildForcedCompletionPrompt,
	parseLLMResponse,
	type ScratchpadEntry,
	type PromptContext,
} from './prompts';
import { estimateCostPerCall, formatCost } from '../utils/cost';

/**
 * Result of agent execution.
 */
export interface AgentResult {
	/** Whether execution was successful */
	success: boolean;
	/** Text result from the agent */
	text: string;
	/** Number of iterations used */
	iterations: number;
	/** Number of LLM API calls made */
	llmCalls: number;
	/** URLs that were scraped */
	sources: string[];
	/** Estimated cost */
	estimatedCost: string;
	/** Error if failed */
	error?: string;
}

/**
 * Options for agent execution.
 */
export interface AgentOptions {
	/** Maximum iterations (default 5) */
	maxIterations?: number;
	/** FlareSolverr URL for bypassing Cloudflare */
	flareSolverrUrl?: string;
	/** Crawl4AI base URL */
	crawl4aiBaseUrl?: string;
}

/**
 * Call the LLM with a prompt.
 * 
 * @param {string} systemPrompt - System prompt
 * @param {string} userPrompt - User prompt
 * @param {OpenAIConfig} config - OpenAI-compatible API config
 * @param {string} model - Model name
 * @returns {Promise<string>} LLM response
 */
async function callLLM(
	systemPrompt: string,
	userPrompt: string,
	config: OpenAIConfig,
	model: string,
): Promise<string> {
	const response = await fetch(`${config.baseUrl}/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${config.apiKey}`,
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
		signal: AbortSignal.timeout(60000),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`LLM API error (${response.status}): ${errorText}`);
	}

	const data = await response.json() as {
		choices?: { message?: { content?: string } }[];
	};

	return data.choices?.[0]?.message?.content || '';
}

/**
 * Call LLM for forced completion when max iterations reached.
 * 
 * @param {string} task - Original task
 * @param {Map<string, AcquiredContent>} content - All acquired content
 * @param {OpenAIConfig} config - API config
 * @param {string} model - Model name
 * @returns {Promise<string>} Synthesized result
 */
async function forcedCompletion(
	task: string,
	content: Map<string, AcquiredContent>,
	config: OpenAIConfig,
	model: string,
): Promise<string> {
	const prompt = buildForcedCompletionPrompt(task, content);
	
	try {
		const response = await fetch(`${config.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: [
					{ role: 'system', content: 'You are a helpful research assistant. Synthesize information and provide comprehensive, detailed answers. Never return empty responses.' },
					{ role: 'user', content: prompt },
				],
				temperature: 0.3,
				max_tokens: 3000,
			}),
			signal: AbortSignal.timeout(60000),
		});

		if (!response.ok) {
			// Fallback: Return raw content summary
			return buildFallbackSummary(task, content);
		}

		const data = await response.json() as {
			choices?: { message?: { content?: string } }[];
		};

		const result = data.choices?.[0]?.message?.content?.trim();
		
		// If LLM returned empty, use fallback
		if (!result) {
			return buildFallbackSummary(task, content);
		}
		
		return result;
	} catch {
		// On any error, return fallback
		return buildFallbackSummary(task, content);
	}
}

/**
 * Build a fallback summary from raw content when LLM fails.
 */
function buildFallbackSummary(task: string, content: Map<string, AcquiredContent>): string {
	const parts: string[] = [];
	parts.push(`Task: ${task}\n`);
	parts.push(`Found information from ${content.size} page(s):\n`);
	
	for (const [url, c] of content) {
		parts.push(`\n--- ${url} ---`);
		if (c.success && c.text) {
			// Extract key parts of text
			const text = c.text.slice(0, 2000);
			parts.push(text);
		} else {
			parts.push(`(Could not load: ${c.error || 'Unknown error'})`);
		}
	}
	
	return parts.join('\n');
}

/**
 * Execute the agentic loop.
 * 
 * Uses ReAct pattern: Think → Act → Observe → Think → ...
 * Continues until the agent calls complete() or max iterations reached.
 * 
 * @param {string} task - Task to complete
 * @param {AcquiredContent} initialContent - Content from Stage 1
 * @param {ExtractionAttempt} nonLlmAttempt - Result from Stage 2
 * @param {OpenAIConfig} llmConfig - LLM API configuration
 * @param {string} model - Model name
 * @param {AgentOptions} options - Agent options
 * @returns {Promise<AgentResult>} Result of agent execution
 */
export async function executeAgent(
	task: string,
	initialContent: AcquiredContent,
	nonLlmAttempt: ExtractionAttempt,
	llmConfig: OpenAIConfig,
	model: string,
	options: AgentOptions = {},
): Promise<AgentResult> {
	const maxIterations = options.maxIterations || 5;
	const scratchpad: ScratchpadEntry[] = [];
	const accumulatedContent = new Map<string, AcquiredContent>();
	let llmCalls = 0;
	let totalCost = 0;

	// Add initial content
	accumulatedContent.set(initialContent.url, initialContent);

	// Tool execution context
	const toolContext: ToolContext = {
		flareSolverrUrl: options.flareSolverrUrl,
		crawl4aiBaseUrl: options.crawl4aiBaseUrl,
		acquiredContent: accumulatedContent,
	};

	const systemPrompt = buildSystemPrompt();

	try {
		for (let iteration = 1; iteration <= maxIterations; iteration++) {
			// Build prompt with full context
			const promptContext: PromptContext = {
				task,
				iteration,
				maxIterations,
				initialContent,
				nonLlmAttempt,
				scratchpad,
				accumulatedContent,
			};

			const userPrompt = buildUserPrompt(promptContext);

			// Call LLM
			llmCalls++;
			totalCost += estimateCostPerCall(model);
			const llmResponse = await callLLM(systemPrompt, userPrompt, llmConfig, model);

			// Parse response
			const parsed = parseLLMResponse(llmResponse);
			if (!parsed) {
				// LLM gave invalid response, add to scratchpad and continue
				scratchpad.push({
					iteration,
					thinking: 'Failed to parse response',
					action: { tool: 'error', params: { raw: llmResponse.slice(0, 200) } },
					result: 'Invalid response format',
				});
				continue;
			}

			// Check if complete
			if (parsed.action.tool === 'complete') {
				const result = (parsed.action.params.result as string) || '';
				
				// If result is empty, force a proper synthesis
				if (!result.trim()) {
					// Agent called complete without a result - force synthesis
					llmCalls++;
					totalCost += estimateCostPerCall(model);
					const synthesizedResult = await forcedCompletion(task, accumulatedContent, llmConfig, model);
					return {
						success: true,
						text: synthesizedResult,
						iterations: iteration,
						llmCalls,
						sources: Array.from(accumulatedContent.keys()),
						estimatedCost: formatCost(totalCost),
					};
				}
				
				return {
					success: true,
					text: result,
					iterations: iteration,
					llmCalls,
					sources: Array.from(accumulatedContent.keys()),
					estimatedCost: formatCost(totalCost),
				};
			}

			// Execute tool
			const toolCall: ToolCall = {
				tool: parsed.action.tool,
				params: parsed.action.params,
			};

			const toolResult = await executeTool(toolCall, toolContext);

			// Update scratchpad
			scratchpad.push({
				iteration,
				thinking: parsed.thinking,
				action: parsed.action,
				result: toolResult.success
					? JSON.stringify(toolResult.data).slice(0, 500)
					: `Error: ${toolResult.error}`,
			});

			// If tool returned content, it's already added to accumulatedContent by executeTool
		}

		// Max iterations reached - force completion
		llmCalls++;
		totalCost += estimateCostPerCall(model);
		const finalResult = await forcedCompletion(task, accumulatedContent, llmConfig, model);

		return {
			success: true,
			text: finalResult,
			iterations: maxIterations,
			llmCalls,
			sources: Array.from(accumulatedContent.keys()),
			estimatedCost: formatCost(totalCost),
		};
	} catch (error) {
		return {
			success: false,
			text: '',
			iterations: scratchpad.length,
			llmCalls,
			sources: Array.from(accumulatedContent.keys()),
			estimatedCost: formatCost(totalCost),
			error: error instanceof Error ? error.message : 'Unknown error',
		};
	}
}

