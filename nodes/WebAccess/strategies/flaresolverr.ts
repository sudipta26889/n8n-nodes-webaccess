/**
 * FlareSolverr strategy for bypassing Cloudflare protection
 * Uses FlareSolverr proxy to solve Cloudflare challenges
 */

import type { StrategyResult } from '../utils/types';
import { extractTextContent } from '../utils/extraction';

// Default timeout for FlareSolverr (challenges can take time)
const DEFAULT_TIMEOUT = 60000;

/**
 * FlareSolverr response structure
 */
interface FlareSolverrResponse {
	status: string;
	message: string;
	startTimestamp: number;
	endTimestamp: number;
	version: string;
	solution?: {
		url: string;
		status: number;
		headers: Record<string, string>;
		response: string;
		cookies: Array<{
			name: string;
			value: string;
			domain: string;
			path: string;
			expires: number;
			httpOnly: boolean;
			secure: boolean;
		}>;
		userAgent: string;
	};
}

/**
 * Fetch a URL using FlareSolverr to bypass Cloudflare
 */
export async function flareSolverrFetch(
	url: string,
	flareSolverrUrl: string,
	maxTimeout: number = DEFAULT_TIMEOUT,
): Promise<StrategyResult> {
	try {
		const response = await fetch(flareSolverrUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				cmd: 'request.get',
				url,
				maxTimeout,
			}),
			signal: AbortSignal.timeout(maxTimeout + 10000), // Extra buffer for FlareSolverr processing
		});

		if (!response.ok) {
			return {
				success: false,
				data: null,
				error: `FlareSolverr HTTP error: ${response.status}`,
			};
		}

		const data = (await response.json()) as FlareSolverrResponse;

		if (data.status !== 'ok') {
			return {
				success: false,
				data: null,
				error: `FlareSolverr error: ${data.message || 'Unknown error'}`,
			};
		}

		if (!data.solution || !data.solution.response) {
			return {
				success: false,
				data: null,
				error: 'FlareSolverr returned empty response',
			};
		}

		const html = data.solution.response;
		const text = extractTextContent(html);

		return {
			success: true,
			data: null,
			html,
			text,
		};
	} catch (error) {
		if (error instanceof Error) {
			if (error.name === 'TimeoutError' || error.name === 'AbortError') {
				return {
					success: false,
					data: null,
					error: `FlareSolverr request timed out after ${maxTimeout}ms`,
				};
			}
			return {
				success: false,
				data: null,
				error: `FlareSolverr error: ${error.message}`,
			};
		}
		return {
			success: false,
			data: null,
			error: 'Unknown FlareSolverr error',
		};
	}
}

/**
 * Check if FlareSolverr is available at the given URL
 */
export async function isFlareSolverrAvailable(flareSolverrUrl: string): Promise<boolean> {
	try {
		// FlareSolverr health check - just try to reach it
		const response = await fetch(flareSolverrUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				cmd: 'sessions.list',
			}),
			signal: AbortSignal.timeout(5000),
		});

		if (response.ok) {
			const data = (await response.json()) as { status: string };
			return data.status === 'ok';
		}
		return false;
	} catch {
		return false;
	}
}
