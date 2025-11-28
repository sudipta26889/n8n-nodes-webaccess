import type {
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class WebAccessApi implements ICredentialType {
	name = 'webAccessApi';

	displayName = 'Web Access API';

	documentationUrl = 'https://github.com/sudipta26889/n8n-nodes-webaccess';

	icon = { light: 'file:../nodes/WebAccess/webaccess.svg', dark: 'file:../nodes/WebAccess/webaccess.dark.svg' } as const;

	properties: INodeProperties[] = [
		{
			displayName: 'Crawl4AI Base URL',
			name: 'crawl4aiBaseUrl',
			type: 'string',
			default: 'http://localhost:11235',
			required: true,
			description: 'Base URL for the Crawl4AI HTTP API service',
			placeholder: 'http://localhost:11235',
		},
		{
			displayName: 'FlareSolverr URL',
			name: 'flareSolverrUrl',
			type: 'string',
			default: '',
			description: 'Optional: FlareSolverr proxy URL to bypass Cloudflare protection. Leave empty to disable.',
			placeholder: 'http://localhost:8191/v1',
		},
	];

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.crawl4aiBaseUrl}}',
			url: '/health',
			method: 'GET',
		},
	};
}
