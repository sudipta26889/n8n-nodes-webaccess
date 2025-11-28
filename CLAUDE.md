# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an n8n community node that provides cost-aware universal web access capabilities. The node implements a progressive pipeline strategy: HTTP → Puppeteer → Crawl4AI BM25 → LLM (Crawl4AI or OpenAI-compatible APIs). Each stage in the pipeline is used only if earlier, cheaper stages fail to extract the required data.

The package uses `@n8n/node-cli` for development tooling.

## Common Commands

```bash
npm run dev          # Start n8n with node loaded + hot reload (http://localhost:5678)
npm run build        # Compile TypeScript for production
npm run lint         # Check for errors (uses n8n-node lint)
npm run lint:fix     # Auto-fix linting issues
```

## Architecture

### Web Access Node Operations

The node supports five operations:
- **fetchContent**: Extract data from a single page using the progressive pipeline
- **crawl**: Multi-page discovery for emails, phones, products across a website
- **screenshot**: Capture visual screenshots using Puppeteer
- **downloadAssets**: Download PDFs, images, CSVs from pages
- **runScript**: Execute custom JavaScript in browser context

### Cost-Aware Pipeline Strategy

Each operation follows a progressive pipeline that attempts cheaper methods first:

1. **HTTP Stage** (`strategies/http.ts`): Simple HTTP fetch with fetch API
2. **FlareSolverr Stage** (`strategies/flaresolverr.ts`): Cloudflare bypass when needed
3. **Puppeteer Stage** (`strategies/puppeteer.ts`): Browser automation for JS-heavy pages
4. **Crawl4AI BM25** (`strategies/crawl4ai.ts`): Semantic search without LLM
5. **LLM Stage** (`strategies/openai.ts` or Crawl4AI internal): AI-powered extraction as last resort

The pipeline exits early when data is successfully extracted, minimizing cost and latency.

**Product Crawl**: Uses full pipeline for each candidate page (not just HTTP→Puppeteer), enabling AI-powered product discovery.

**Asset Download**: Supports multi-page crawling, checking up to 10 crawled pages when initial page lacks assets.

**Candidate Ranking**: Uses `scorePageForIntent()` combining URL (10pts), title (7pts), and snippet (3pts) signals for better page selection.

### Project Structure

```
nodes/WebAccess/
  WebAccess.node.ts           # Main node class with INodeType interface
  strategies/
    http.ts                    # HTTP fetch strategy
    puppeteer.ts              # Browser automation with Puppeteer
    crawl4ai.ts               # Crawl4AI integration
    openai.ts                 # OpenAI-compatible API integration
  utils/
    types.ts                  # Shared TypeScript type definitions
    extraction.ts             # Data extraction utilities (emails, phones, products)
    taskIntent.ts             # Task intent inference for smart routing

credentials/
  WebAccessApi.credentials.ts        # Crawl4AI service credentials
  OpenAICompatibleApi.credentials.ts # OpenAI-compatible API credentials
```

### Key Implementation Patterns

**Task Intent Inference**: The node analyzes user tasks to determine what data to extract (emails, phones, products, etc.) and routes through appropriate strategies.

**Singleton Browser**: Puppeteer browser instance is reused across operations via `getBrowser()` and cleaned up with `closeBrowser()` in execute's finally block.

**List Search Methods**: Dynamic model dropdown for OpenAI-compatible providers via `methods.listSearch.listModels()`.

**Binary Data Handling**: Screenshots and assets return binary data via `IBinaryData` format. Multiple assets are automatically zipped using JSZip.

**Error Handling**: Each strategy returns `StrategyResult` with success flag. Pipeline continues to next stage on failure.

## Requirements

- Node.js v22 or higher
- TypeScript strict mode enabled
- External services: Crawl4AI HTTP API (default: http://157.173.126.92:11235)
