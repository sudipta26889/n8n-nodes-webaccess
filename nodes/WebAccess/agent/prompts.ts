/**
 * Agent Prompts
 * 
 * Defines the prompts used for the agentic LLM.
 * Uses ReAct pattern with thinking and action.
 */

import type { AcquiredContent } from '../stages/acquire';
import type { ExtractionAttempt } from '../stages/extract';
import { formatToolsForLLM } from './tools';

/**
 * Entry in the agent's scratchpad (memory).
 */
export interface ScratchpadEntry {
	iteration: number;
	thinking: string;
	action: {
		tool: string;
		params: Record<string, unknown>;
	};
	result?: string;
}

/**
 * Context for building the agent prompt.
 */
export interface PromptContext {
	task: string;
	iteration: number;
	maxIterations: number;
	initialContent: AcquiredContent;
	nonLlmAttempt: ExtractionAttempt;
	scratchpad: ScratchpadEntry[];
	accumulatedContent: Map<string, AcquiredContent>;
}

/**
 * Build the system prompt for the agent.
 * 
 * @returns {string} System prompt
 */
export function buildSystemPrompt(): string {
	return `You are a web research agent. Your goal is to complete the user's task by gathering and synthesizing information from web pages.

## IMPORTANT RULES
1. Think step-by-step before taking action
2. Don't repeat actions that were already tried
3. Use the simplest approach that works
4. When you have enough information, call complete() immediately
5. Be concise but thorough in your final answer

## AVAILABLE TOOLS
${formatToolsForLLM()}

## RESPONSE FORMAT
You must respond with valid JSON only:
{
  "thinking": "Your step-by-step reasoning about what to do next...",
  "action": {
    "tool": "tool_name",
    "params": { ... }
  }
}`;
}

/**
 * Build the user prompt for the agent with full context.
 * 
 * @param {PromptContext} context - Context for the prompt
 * @returns {string} User prompt
 */
export function buildUserPrompt(context: PromptContext): string {
	const {
		task,
		iteration,
		maxIterations,
		initialContent,
		nonLlmAttempt,
		scratchpad,
		accumulatedContent,
	} = context;

	const parts: string[] = [];

	// Task
	parts.push(`## TASK\n${task}`);

	// Iteration context with planning guidance
	parts.push(`\n## ITERATION: ${iteration} of ${maxIterations}`);
	if (iteration <= 2) {
		parts.push('→ Early stage: Explore and gather information if needed');
	} else if (iteration <= 4) {
		parts.push('→ Middle stage: Focus on completing the task');
	} else {
		parts.push('→ FINAL ITERATION: You MUST call complete() now with your best answer based on available information');
	}

	// Initial content from Stage 1
	parts.push(`\n## INITIAL CONTENT (from Stage 1)`);
	parts.push(`URL: ${initialContent.url}`);
	parts.push(`Method used: ${initialContent.method}`);
	parts.push(`Scrape time: ${initialContent.scrapeTime}ms`);
	if (initialContent.success) {
		// Truncate text preview to avoid token overload
		const preview = initialContent.text.slice(0, 3000);
		parts.push(`\nContent preview:\n"""\n${preview}\n"""`);
		if (initialContent.text.length > 3000) {
			parts.push(`... (${initialContent.text.length - 3000} more characters)`);
		}
	} else {
		parts.push(`Error: ${initialContent.error}`);
	}

	// Non-LLM attempt from Stage 2
	parts.push(`\n## NON-LLM EXTRACTION ATTEMPT (Stage 2)`);
	parts.push(`What was tried: ${nonLlmAttempt.whatWasTried.join(', ')}`);
	parts.push(`Result: ${nonLlmAttempt.success ? 'Success' : 'Failed'}`);
	parts.push(`Reason: ${nonLlmAttempt.reason}`);
	if (nonLlmAttempt.data) {
		const dataStr = JSON.stringify(nonLlmAttempt.data, null, 2);
		if (dataStr.length < 1000) {
			parts.push(`Data found:\n${dataStr}`);
		} else {
			parts.push(`Data found: (large object, ${Object.keys(nonLlmAttempt.data).join(', ')})`);
		}
	}
	parts.push(`\nDetected intent: ${formatIntent(nonLlmAttempt.detectedIntent)}`);

	// Scratchpad (previous iterations)
	if (scratchpad.length > 0) {
		parts.push(`\n## PREVIOUS ITERATIONS`);
		for (const entry of scratchpad) {
			parts.push(`\n### Iteration ${entry.iteration}`);
			parts.push(`Thinking: ${entry.thinking}`);
			parts.push(`Action: ${entry.action.tool}(${JSON.stringify(entry.action.params)})`);
			if (entry.result) {
				// Truncate result
				const resultPreview = entry.result.slice(0, 500);
				parts.push(`Result: ${resultPreview}${entry.result.length > 500 ? '...' : ''}`);
			}
		}
	}

	// All accumulated content
	if (accumulatedContent.size > 1) {
		parts.push(`\n## ALL SCRAPED PAGES (${accumulatedContent.size} total)`);
		for (const [url, content] of accumulatedContent) {
			if (url === initialContent.url) continue; // Skip initial, already shown
			parts.push(`\n### ${url}`);
			if (content.success) {
				const preview = content.text.slice(0, 1000);
				parts.push(`Content: ${preview}${content.text.length > 1000 ? '...' : ''}`);
			} else {
				parts.push(`Error: ${content.error}`);
			}
		}
	}

	// Final instruction
	parts.push(`\n## YOUR TURN`);
	parts.push(`Think about what you need to do to complete the task, then take action.`);
	parts.push(`Remember: Respond with valid JSON only.`);

	return parts.join('\n');
}

/**
 * Format detected intent as a readable string.
 */
function formatIntent(intent: ExtractionAttempt['detectedIntent']): string {
	const flags: string[] = [];
	if (intent.wantsEmail) flags.push('email');
	if (intent.wantsPhone) flags.push('phone');
	if (intent.wantsProducts) flags.push('products');
	if (intent.wantsText) flags.push('text');
	if (intent.wantsScreenshot) flags.push('screenshot');
	if (intent.wantsDownload) flags.push('download');
	if (intent.isResearch) flags.push('research');
	if (intent.isGeneral) flags.push('general');
	return flags.join(', ') || 'none detected';
}

/**
 * Parse the LLM response into structured format.
 * 
 * @param {string} response - Raw LLM response
 * @returns {{ thinking: string; action: { tool: string; params: Record<string, unknown> } } | null}
 */
export function parseLLMResponse(response: string): {
	thinking: string;
	action: { tool: string; params: Record<string, unknown> };
} | null {
	try {
		// Try to extract JSON from response
		let jsonStr = response.trim();

		// Handle markdown code blocks
		const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (jsonMatch) {
			jsonStr = jsonMatch[1].trim();
		}

		// Parse JSON
		const parsed = JSON.parse(jsonStr) as {
			thinking?: string;
			action?: { tool?: string; params?: Record<string, unknown> };
		};

		if (!parsed.thinking || !parsed.action || !parsed.action.tool) {
			return null;
		}

		return {
			thinking: parsed.thinking,
			action: {
				tool: parsed.action.tool,
				params: parsed.action.params || {},
			},
		};
	} catch {
		// Try to extract thinking and action from plain text
		const thinkingMatch = response.match(/thinking["\s:]+([^"]+)/i);
		const toolMatch = response.match(/tool["\s:]+["']?(\w+)/i);

		if (thinkingMatch && toolMatch) {
			return {
				thinking: thinkingMatch[1].trim(),
				action: {
					tool: toolMatch[1],
					params: {},
				},
			};
		}

		return null;
	}
}

/**
 * Build a forced completion prompt for when max iterations reached.
 * 
 * @param {string} task - Original task
 * @param {Map<string, AcquiredContent>} content - All acquired content
 * @returns {string} Prompt for forced completion
 */
export function buildForcedCompletionPrompt(
	task: string,
	content: Map<string, AcquiredContent>,
): string {
	const parts: string[] = [];

	parts.push(`## TASK\n${task}`);
	parts.push(`\n## MAX ITERATIONS REACHED`);
	parts.push(`You must now provide your best answer based on the information gathered.`);

	parts.push(`\n## INFORMATION GATHERED`);
	for (const [url, c] of content) {
		parts.push(`\n### ${url}`);
		if (c.success) {
			parts.push(c.text.slice(0, 2000));
		} else {
			parts.push(`(Failed to load: ${c.error})`);
		}
	}

	parts.push(`\n## INSTRUCTIONS`);
	parts.push(`Synthesize all the information above and provide a comprehensive answer to the task.`);
	parts.push(`Be specific and include relevant details from the scraped content.`);

	return parts.join('\n');
}

