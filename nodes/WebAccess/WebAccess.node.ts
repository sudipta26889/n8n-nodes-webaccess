/**
 * Web Access Node v2.0
 * 
 * A smart web access node that can perform any task on given URLs.
 * Uses a 3-stage architecture:
 * 1. Content Acquisition (HTTP → FlareSolverr → Puppeteer)
 * 2. Non-LLM Extraction (pattern matching, regex)
 * 3. Agentic LLM (when needed, uses ReAct pattern)
 */

import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchResult,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

// Import new stages
import { acquireContent, cleanupAcquisition, type AcquiredContent } from './stages/acquire';
import { tryNonLlmExtraction, formatExtractionAsText, type ExtractionAttempt } from './stages/extract';

// Import agent
import { executeAgent, type AgentResult } from './agent/executor';

// Import utilities
import type { OpenAIConfig } from './utils/types';

/**
 * Output structure for the node.
 */
interface WebAccessOutput {
	url: string;
	task: string;
	success: boolean;
	data: {
		text: string;
		sources?: string[];
	};
	meta: {
		usedLlm: boolean;
		scrapeMethod?: string;
		iterations?: number;
		llmCalls?: number;
		estimatedCost?: string;
		nonLlmAttempt?: {
			tried: string[];
			reason: string;
		};
		methodsTried?: Array<{ method: string; success: boolean; error?: string }>;
	};
	error?: string;
}

export class WebAccess implements INodeType {
	methods = {
		listSearch: {
			async listModels(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				try {
					const credentials = await this.getCredentials('openAICompatibleApi');
					const baseUrl = (credentials.baseUrl as string) || 'https://api.openai.com/v1';
					const apiKey = credentials.apiKey as string;

					const response = await this.helpers.httpRequest({
						method: 'GET',
						url: `${baseUrl}/models`,
						headers: {
							Authorization: `Bearer ${apiKey}`,
						},
					});

					const models = response.data || [];

					const sortedModels = models
						.map((model: { id: string; owned_by?: string }) => ({
							name: model.id,
							value: model.id,
							description: model.owned_by ? `Owned by: ${model.owned_by}` : undefined,
						}))
						.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));

					const filteredModels = filter
						? sortedModels.filter((model: { name: string }) =>
								model.name.toLowerCase().includes(filter.toLowerCase()),
							)
						: sortedModels;

					return {
						results: filteredModels,
					};
				} catch (error) {
					return {
						results: [
							{
								name: 'Error Loading Models - Check Credentials',
								value: 'openai/gpt-4o-mini',
								description: error instanceof Error ? error.message : 'Unknown error',
							},
						],
					};
				}
			},
		},
	};

	description: INodeTypeDescription = {
		displayName: 'Web Access',
		name: 'webAccess',
		icon: { light: 'file:webaccess.svg', dark: 'file:webaccess.dark.svg' },
		group: ['transform'],
		version: 5,
		subtitle: '={{$parameter["task"]}}',
		description: `Use the Web Access tool to perform any task on given URL(s). Just describe what you want in natural language and the tool will:
1. Scrape the webpage content automatically
2. Try pattern matching first (fast, free)
3. Use LLM agent if needed (for complex tasks)

EXAMPLES:
- "Find the contact email" → Extracts email addresses
- "Research this company" → Gathers and synthesizes company info
- "Get all product prices" → Extracts product listings
- "What services do they offer?" → Analyzes and summarizes content
- "Extract the main article text" → Gets readable text content

RETURNS: { text: "result", sources: ["urls"] } with the answer to your task.`,
		defaults: {
			name: 'Web Access',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'webAccessApi',
				required: true,
			},
			{
				name: 'openAICompatibleApi',
				required: false,
				displayOptions: {
					show: {
						aiProvider: ['openai-compatible'],
					},
				},
			},
		],
		properties: [
			{
				displayName: 'URLs',
				name: 'urls',
				type: 'string',
				typeOptions: {
					multipleValues: true,
				},
				default: [],
				required: true,
				description: 'The URL(s) to perform the task on. Include the full URL with https://. You can provide multiple URLs and the task will be performed on each.',
			},
			{
				displayName: 'Task',
				name: 'task',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				default: '',
				required: true,
				description: 'Describe the task in natural language. The tool understands intent and extracts relevant data. Examples: "Find contact email", "Research this company in detail", "List all products with prices", "What does this company do?", "Extract the article content".',
				placeholder: 'e.g., "Find the contact email address" or "Tell me about this company"',
			},
			{
				displayName: 'LLM Provider',
				name: 'aiProvider',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'None (Pattern Matching Only)',
						value: 'none',
						description: 'Use only pattern matching - fastest, no API costs',
					},
					{
						name: 'OpenAI-Compatible',
						value: 'openai-compatible',
						description: 'Use LLM for complex tasks (OpenAI, OpenRouter, etc.)',
					},
				],
				default: 'none',
				description: 'Enable LLM for tasks that need understanding/synthesis',
			},
			{
				displayName: 'Model',
				name: 'aiModel',
				type: 'resourceLocator',
				default: { mode: 'id', value: 'openai/gpt-4o-mini' },
				displayOptions: {
					show: {
						aiProvider: ['openai-compatible'],
					},
				},
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: {
							searchListMethod: 'listModels',
							searchable: true,
						},
					},
					{
						displayName: 'ID',
						name: 'id',
						type: 'string',
						placeholder: 'e.g., openai/gpt-4o-mini',
					},
				],
				description: 'The model to use for LLM tasks',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnItems: INodeExecutionData[] = [];

		// Read credentials
		const webAccessCredentials = await this.getCredentials('webAccessApi');
		const crawl4aiBaseUrl = (webAccessCredentials.crawl4aiBaseUrl as string) || '';
		const flareSolverrUrl = (webAccessCredentials.flareSolverrUrl as string) || undefined;

		// Read AI provider setting
		const aiProvider = this.getNodeParameter('aiProvider', 0) as string;
		const llmEnabled = aiProvider === 'openai-compatible';

		// Get AI model
		let aiModel: string | undefined;
		let openAiConfig: OpenAIConfig | undefined;

		if (llmEnabled) {
			const aiModelParam = this.getNodeParameter('aiModel', 0) as string | { value: string };
			aiModel = typeof aiModelParam === 'string' ? aiModelParam : aiModelParam?.value;

			try {
				const credentials = await this.getCredentials('openAICompatibleApi');
				openAiConfig = {
					apiKey: credentials.apiKey as string,
					baseUrl: (credentials.baseUrl as string) || 'https://api.openai.com/v1',
				};
			} catch (error) {
				throw new NodeOperationError(
					this.getNode(),
					`Failed to load OpenAI-Compatible API credentials: ${error instanceof Error ? error.message : 'Unknown error'}`,
				);
			}
		}

		try {
			for (let i = 0; i < items.length; i++) {
				const task = this.getNodeParameter('task', i) as string;
				const urlsParam = this.getNodeParameter('urls', i) as string | string[];
				const urls = Array.isArray(urlsParam) ? urlsParam : [urlsParam];

				for (const url of urls) {
					if (!url || !url.trim()) continue;

					try {
						const result = await processUrl(
							url.trim(),
							task,
							llmEnabled,
							openAiConfig,
							aiModel,
							flareSolverrUrl,
							crawl4aiBaseUrl,
						);

						returnItems.push({
							json: result as unknown as IDataObject,
						});
					} catch (error) {
						if (this.continueOnFail()) {
							returnItems.push({
								json: {
									url,
									task,
									success: false,
									data: { text: '' },
									meta: { usedLlm: false },
									error: error instanceof Error ? error.message : 'Unknown error',
								},
							});
						} else {
							throw new NodeOperationError(this.getNode(), error as Error, {
								itemIndex: i,
							});
						}
					}
				}
			}
		} finally {
			await cleanupAcquisition();
		}

		return [returnItems];
	}

}

/**
 * Process a single URL with the 3-stage architecture.
 * 
 * @param {string} url - URL to process
 * @param {string} task - Task to perform
 * @param {boolean} llmEnabled - Whether LLM is enabled
 * @param {OpenAIConfig} [openAiConfig] - OpenAI config
 * @param {string} [aiModel] - AI model name
 * @param {string} [flareSolverrUrl] - FlareSolverr URL
 * @param {string} [crawl4aiBaseUrl] - Crawl4AI URL
 * @returns {Promise<WebAccessOutput>} Result
 */
async function processUrl(
	url: string,
	task: string,
	llmEnabled: boolean,
	openAiConfig?: OpenAIConfig,
	aiModel?: string,
	flareSolverrUrl?: string,
	crawl4aiBaseUrl?: string,
): Promise<WebAccessOutput> {
		// ========================================
		// STAGE 1: Content Acquisition
		// ========================================
		const content: AcquiredContent = await acquireContent(url, {
			flareSolverrUrl,
		});

	if (!content.success) {
		return {
			url,
			task,
			success: false,
			data: { text: '' },
			meta: {
				usedLlm: false,
				scrapeMethod: content.method,
				methodsTried: content.methodsTried,
			},
			error: content.error || 'Failed to acquire content',
		};
	}

		// ========================================
		// STAGE 2: Non-LLM Extraction
		// ========================================
		const extraction: ExtractionAttempt = tryNonLlmExtraction(content, task);

		// If non-LLM succeeded, return result
		if (extraction.success && extraction.data) {
			const text = formatExtractionAsText(extraction.data);
			return {
				url,
				task,
				success: true,
				data: {
					text,
					sources: [url],
				},
				meta: {
					usedLlm: false,
					scrapeMethod: content.method,
					nonLlmAttempt: {
						tried: extraction.whatWasTried,
						reason: extraction.reason,
					},
				},
			};
		}

		// ========================================
		// STAGE 3: Agentic LLM (if enabled)
		// ========================================
		if (llmEnabled && openAiConfig && aiModel) {
			const agentResult: AgentResult = await executeAgent(
				task,
				content,
				extraction,
				openAiConfig,
				aiModel,
				{
					maxIterations: 5,
					flareSolverrUrl,
					crawl4aiBaseUrl,
				},
			);

			if (agentResult.success) {
				return {
					url,
					task,
					success: true,
					data: {
						text: agentResult.text,
						sources: agentResult.sources,
					},
					meta: {
						usedLlm: true,
						scrapeMethod: content.method,
						iterations: agentResult.iterations,
						llmCalls: agentResult.llmCalls,
						estimatedCost: agentResult.estimatedCost,
						nonLlmAttempt: {
							tried: extraction.whatWasTried,
							reason: extraction.reason,
						},
					},
				};
			} else {
				return {
					url,
					task,
					success: false,
					data: { text: '' },
					meta: {
						usedLlm: true,
						scrapeMethod: content.method,
						iterations: agentResult.iterations,
						llmCalls: agentResult.llmCalls,
						estimatedCost: agentResult.estimatedCost,
					},
					error: agentResult.error || 'Agent failed to complete task',
				};
			}
		}

		// ========================================
		// FALLBACK: Return partial result
		// ========================================
		// LLM not enabled but non-LLM didn't succeed fully
	const partialText = extraction.data 
		? formatExtractionAsText(extraction.data)
		: content.text.slice(0, 5000);

		return {
			url,
			task,
			success: extraction.data !== null,
			data: {
				text: partialText,
				sources: [url],
			},
			meta: {
				usedLlm: false,
				scrapeMethod: content.method,
				nonLlmAttempt: {
					tried: extraction.whatWasTried,
					reason: extraction.reason,
				},
			},
			error: extraction.data ? undefined : `${extraction.reason}. Enable LLM for better results.`,
		};
}
