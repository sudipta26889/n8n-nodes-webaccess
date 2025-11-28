/**
 * Cost estimation utilities for LLM API calls
 */

/**
 * Estimate cost per API call based on model name.
 * 
 * Uses approximate pricing for common models. For custom models,
 * falls back to a conservative estimate.
 * 
 * @param {string} model - Model name (e.g., "openai/gpt-5-mini", "gpt-5-mini")
 * @param {number} inputTokens - Estimated input tokens (~2000 for page content)
 * @param {number} outputTokens - Estimated output tokens (~100 for extraction)
 * @returns {number} Estimated cost in USD
 */
export function estimateCostPerCall(model: string, inputTokens: number = 2000, outputTokens: number = 100): number {
	const lowerModel = model.toLowerCase();
	
	// Pricing per 1M tokens (input/output)
	// These are approximate - actual pricing may vary by provider
	const pricing: Record<string, { input: number; output: number }> = {
		'openai/gpt-5-mini': { input: 0.15, output: 0.6 },
		'gpt-4o': { input: 2.5, output: 10 },
		'gpt-4-turbo': { input: 10, output: 30 },
		'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
		'gpt-5-mini': { input: 0.1, output: 0.4 }, // Estimated
		'gpt-5': { input: 2.0, output: 8.0 }, // Estimated
		'claude-3-haiku': { input: 0.25, output: 1.25 },
		'claude-3-sonnet': { input: 3.0, output: 15.0 },
		'claude-3-opus': { input: 15.0, output: 75.0 },
	};

	// Try to match model name
	for (const [key, prices] of Object.entries(pricing)) {
		if (lowerModel.includes(key)) {
			const inputCost = (inputTokens / 1_000_000) * prices.input;
			const outputCost = (outputTokens / 1_000_000) * prices.output;
			return inputCost + outputCost;
		}
	}

	// Default conservative estimate for unknown models
	// Assume $0.001 per call (similar to openai/gpt-5-mini)
	return 0.001;
}

/**
 * Estimate cost for operation detection call.
 * 
 * Operation detection uses a small prompt, so it's cheaper.
 * 
 * @param {string} model - Model name
 * @returns {number} Estimated cost in USD
 */
export function estimateOperationDetectionCost(model: string): number {
	// Operation detection uses ~100 tokens total
	return estimateCostPerCall(model, 100, 20);
}

/**
 * Format cost as currency string.
 * 
 * @param {number} cost - Cost in USD
 * @returns {string} Formatted cost (e.g., "$0.012")
 */
export function formatCost(cost: number): string {
	if (cost < 0.001) {
		return `$${cost.toFixed(6)}`;
	}
	if (cost < 0.01) {
		return `$${cost.toFixed(4)}`;
	}
	return `$${cost.toFixed(3)}`;
}

