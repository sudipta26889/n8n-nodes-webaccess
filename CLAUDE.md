# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an n8n community node package built using the n8n-nodes-starter template. It provides custom nodes for n8n workflow automation. The package uses `@n8n/node-cli` for development tooling.

## Common Commands

```bash
npm run dev          # Start n8n with nodes loaded + hot reload (http://localhost:5678)
npm run build        # Compile TypeScript for production
npm run lint         # Check for errors (uses n8n-node lint)
npm run lint:fix     # Auto-fix linting issues
```

## Architecture

### Node Types

**Programmatic Style** (`nodes/Example/`):
- Implements `INodeType` interface with custom `execute()` method
- Full control over execution logic
- Use when you need complex processing beyond HTTP requests

**Declarative Style** (`nodes/GithubIssues/`):
- Define operations declaratively with `routing` objects in property definitions
- No custom execute method needed - n8n handles HTTP requests automatically
- Preferred for REST API integrations

### Project Structure

```
nodes/
  NodeName/
    NodeName.node.ts    # Main node class with INodeTypeDescription
    resources/          # Resource-specific operations (declarative style)
      resourceName/
        index.ts        # Exports operation descriptions array
        get.ts, create.ts, etc.  # Individual operation definitions
    shared/             # Shared utilities (descriptions, transport, utils)
    listSearch/         # Dynamic dropdown search methods

credentials/
  ServiceApi.credentials.ts  # Credential definitions implementing ICredentialType
```

### Key Patterns

**Registering nodes**: Add to `n8n.nodes` and `n8n.credentials` arrays in `package.json`

**Declarative routing**: Operations define `routing.request` with method, url, and parameters using expressions like `={{$parameter.fieldName}}`

**List search methods**: Define in node's `methods.listSearch` object for dynamic dropdowns

**Credential authentication**: Use `authenticate` property with `IAuthenticateGeneric` for header/query auth injection

## Requirements

- Node.js v22 or higher
- TypeScript strict mode enabled
