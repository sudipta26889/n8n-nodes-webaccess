import type { ICredentialType, INodeProperties, Icon, ICredentialTestRequest } from 'n8n-workflow';

/**
 * Optional credential type for Web Access node
 * Provides API key storage for future external service integrations
 */
export class WebAccessApi implements ICredentialType {
	name = 'webAccessApi';

	displayName = 'Web Access API';

	icon: Icon = { light: 'file:../nodes/WebAccess/webaccess.svg', dark: 'file:../nodes/WebAccess/webaccess.dark.svg' };

	documentationUrl = 'https://github.com/n8n-io/n8n-nodes-starter';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'Optional API key for Crawl4AI or external services (leave empty if not required)',
		},
		{
			displayName: 'Custom Crawl4AI URL',
			name: 'crawl4aiUrl',
			type: 'string',
			default: '',
			placeholder: 'http://localhost:11235',
			description: 'Custom Crawl4AI service URL (overrides node setting when provided)',
		},
	];

	// Test the credential by checking the Crawl4AI health endpoint
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{ $credentials.crawl4aiUrl || "http://157.173.126.92:11235" }}',
			url: '/health',
			method: 'GET',
		},
	};
}
