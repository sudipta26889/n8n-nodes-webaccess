import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
	Icon,
} from 'n8n-workflow';

/**
 * Credential type for OpenAI-compatible APIs.
 * 
 * Supports OpenAI, OpenRouter, Together AI, Groq, and other compatible providers.
 * Allows configuration of API key and base URL for flexible LLM provider selection.
 * 
 * @class OpenAICompatibleApi
 * @implements {ICredentialType}
 */
export class OpenAICompatibleApi implements ICredentialType {
	name = 'openAICompatibleApi';

	displayName = 'OpenAI-Compatible API';

	icon: Icon = 'file:../nodes/WebAccess/webaccess.svg';

	documentationUrl = 'https://platform.openai.com/docs/api-reference';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'API key for OpenAI or OpenAI-compatible service',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.openai.com/v1',
			required: true,
			description:
				'Base URL for the API. Examples: https://api.openai.com/v1, https://openrouter.ai/api/v1, https://api.together.xyz/v1, https://api.groq.com/openai/v1',
			placeholder: 'https://api.openai.com/v1',
		},
	];

	// Test credential validity by fetching models list
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{ $credentials.baseUrl }}',
			url: '/models',
			method: 'GET',
		},
	};

	// Define how to inject credentials into requests
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};
}
