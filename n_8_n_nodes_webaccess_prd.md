# n8n Web Access Node (`n8n-nodes-webaccess`) – Product & Technical Specification

> **Target audience:** Claude Code (auto-coder), implementing a production-ready custom n8n node package.
>
> **Goal:** Implement a single n8n node `Web Access` that, given one or more URLs and a natural-language task, automatically uses HTTP, Puppeteer, and Crawl4AI (running on the same VPS) to perform web actions (fetch content, crawl & extract info, screenshots, downloads, scripted interactions). The node is cost-aware, hides internal complexity, and exposes a very simple configuration surface to the user.

---

## 1. High-Level Overview

### 1.1 Problem

The user wants a **single master web-access node** in n8n that:

- Accepts:
  - One or more URLs.
  - A natural-language *task* describing what to do.
  - A simple `operation` selection.
- Internally decides how to perform the task:
  - Plain HTTP fetching.
  - Headless browser via Puppeteer.
  - Crawl4AI for crawling and semantic querying (running on the same VPS).
- Optionally uses LLM-based extraction (via Crawl4AI LLM mode) **only if explicitly allowed**.
- Returns a simple, **high-level JSON result**, without exposing strategy/fallback details.

The node must **minimize LLM usage** and prioritize cheap approaches (HTTP, DOM parsing, non-LLM crawling) before using any LLM-based extraction.


### 1.2 Scope

Single n8n custom node package:

- Package name: `n8n-nodes-webaccess`.
- Node name: `Web Access`.
- Node type: `webAccess`.
- File layout:
  - `src/WebAccess.node.ts` (main node implementation).
  - `src/strategies/http.ts` (HTTP-based logic).
  - `src/strategies/puppeteer.ts` (Puppeteer-based logic).
  - `src/strategies/crawl4ai.ts` (Crawl4AI integration).
  - `src/utils/extraction.ts` (common extraction helpers, regexes, heuristics).
  - `src/utils/types.ts` (shared TypeScript types).

The node must:

- Work inside n8n as a standard node.
- Not require any additional configuration from the end-user beyond what is in the node’s UI.
- Assume that n8n, Puppeteer, and Crawl4AI are already installed and running on the same VPS.


### 1.3 Non-goals

- No `urlsFrom`/dynamic input mode selection; the node always expects an explicit `urls` parameter.
- No user-specified selectors/xpaths/patterns; **the node must infer what to do** from `operation` + `task`.
- No user-selectable strategy/fallback configuration; internally the node always uses the same **auto strategy**.

---

## 2. Environment & Assumptions

1. **Runtime**
   - Node.js version compatible with current n8n (Node 18+).
   - TypeScript for node implementation.

2. **n8n**
   - Custom node packaged as per n8n guidelines.
   - Node installed into self-hosted n8n instance via standard `n8n-nodes-*` plugin mechanism.

3. **Crawl4AI Service**
   - Running on the same VPS at:
     - `http://157.173.126.92:11235`
   - Exposes endpoints:
     - `POST /crawl`
     - `POST /crawl/stream`
     - `POST /md`
   - These endpoints accept/return JSON as in the user-provided curl examples (see section 6).

4. **Puppeteer**
   - Puppeteer will be used **inside** the node (via `puppeteer` NPM package).
   - The Docker/container image used for n8n must have necessary dependencies for headless Chrome/Chromium.
   - The node should include reasonable defaults and error handling such that if Puppeteer fails (e.g., no Chrome), the node falls back to Crawl4AI and/or HTTP gracefully.

5. **LLM Use**
   - LLM access is **optional** and entirely controlled by the `useAI` boolean parameter.
   - When `useAI` is `false`, the node must not perform any LLM-based extraction via Crawl4AI’s LLM mode (`f="llm"`).
   - When `useAI` is `true`, the node is allowed to call Crawl4AI `/md` with `f="llm"` as a **last resort** step.
   - The node also exposes `aiProvider` and `aiModel` fields in the UI for future use; in the initial implementation they are **not used for external LLM calls** and are only exposed in the output metadata.

---

## 3. Node Interface Specification

### 3.1 Node Identity

- `displayName`: **Web Access**
- `name`: **webAccess**
- `group`: `["transform"]`
- `version`: `1`
- `description`: "Cost-aware universal web access (HTTP, Puppeteer, Crawl4AI)"
- `defaults.name`: `Web Access`
- `inputs`: `['main']`
- `outputs`: `['main']`


### 3.2 Parameters (UI)

**1. urls**

- **Display Name:** `URLs`
- **Name:** `urls`
- **Type:** `string`
- **Type Options:** `{ multipleValues: true }`
- **Required:** true
- **Description:** One or more URLs to process. When multiple values are given, the node will process each URL separately.
- **Notes:**
  - Inside `execute`, read as:
    ```ts
    const urls = this.getNodeParameter('urls', i) as string | string[];
    ```
  - Normalize to `string[]` in code.


**2. operation**

- **Display Name:** `Operation`
- **Name:** `operation`
- **Type:** `options`
- **Required:** true
- **Options:**
  - `{ name: 'Fetch Content', value: 'fetchContent' }`
  - `{ name: 'Screenshot', value: 'screenshot' }`
  - `{ name: 'Download Assets', value: 'downloadAssets' }`
  - `{ name: 'Crawl', value: 'crawl' }`
  - `{ name: 'Run Script', value: 'runScript' }`
- **Default:** `fetchContent`


**3. task**

- **Display Name:** `Task`
- **Name:** `task`
- **Type:** `string`
- **Required:** true
- **Type Options:** `{ rows: 4 }`
- **Description:** Natural-language instruction describing what to do with the given URLs.
- **Examples:**
  - "Find contact email."
  - "Find all men wallet in this site."
  - "Download all PDFs."
  - "Take a full page screenshot."
  - For `runScript`, this **is** the script content/instruction (see section 4.5).


**4. useAI**

- **Display Name:** `Allow LLM (advanced extraction)`
- **Name:** `useAI`
- **Type:** `boolean`
- **Default:** `false`
- **Description:** If enabled, the node may use Crawl4AI’s LLM-based `/md` endpoint with `f="llm"` as a last resort for complex tasks.


**5. aiProvider** (shown only if `useAI` is `true`)

- **Display Name:** `AI Provider`
- **Name:** `aiProvider`
- **Type:** `options`
- **Required:** false
- **Options:**
  - `{ name: 'Crawl4AI internal', value: 'crawl4ai' }` (default)
  - `{ name: 'OpenAI-compatible (future)', value: 'openai-compatible' }`
- **Display Options:**
  - `show: { useAI: [true] }`
- **Note:** In the initial implementation this field is informational only and is returned in the `meta` section of the result, but does not alter actual behaviour (all LLM extraction is via Crawl4AI).


**6. aiModel** (shown only if `useAI` is `true`)

- **Display Name:** `AI Model`
- **Name:** `aiModel`
- **Type:** `string`
- **Required:** false
- **Placeholder:** e.g. `gpt-5-mini`
- **Display Options:**
  - `show: { useAI: [true] }`
- **Note:** Also informational only in v1; stored in metadata for future expansion.


**7. crawl4aiBaseUrl**

- **Display Name:** `Crawl4AI Base URL`
- **Name:** `crawl4aiBaseUrl`
- **Type:** `string`
- **Default:** `http://157.173.126.92:11235`
- **Required:** true
- **Description:** Base URL for the Crawl4AI HTTP API. In v1 this is normally left as default but is configurable for flexibility.


### 3.3 Output Schema

For **each input URL**, the node emits **one output item** with the following JSON structure:

```ts
interface WebAccessResultDataGeneric {
  // Free-form data structure depending on operation and task.
  // Typings below define more specific variants.
  [key: string]: any;
}

interface WebAccessResultJson {
  url: string;           // The URL that was processed.
  operation: string;     // One of: 'fetchContent' | 'screenshot' | 'downloadAssets' | 'crawl' | 'runScript'.
  task: string;          // Original task/instruction.
  success: boolean;      // Indicates whether the node believes the task was successfully satisfied.
  data: WebAccessResultDataGeneric | null; // Operation-specific result data.
  error?: string;        // Short human-readable error message, if success === false.
  meta?: {
    usedHttp?: boolean;
    usedPuppeteer?: boolean;
    usedCrawl4ai?: boolean;
    usedCrawl4aiLlm?: boolean; // True only if useAI === true and LLM extraction was used.
    aiProvider?: string;       // Echo of node parameter.
    aiModel?: string;          // Echo of node parameter.
  };
}
```

> **Important:**
> - The `meta` flags are **not** to be exposed as separate properties in node output; they live inside `json.meta` only. The user has requested "simple output"; these meta flags are for debugging or advanced flows.
> - Do **not** expose a `strategyUsed` field or a detailed `steps` array in the JSON.

Binary data use:

- For `screenshot` operation:
  - `binary.screenshot`: image buffer (`image/png` by default).
- For `downloadAssets` operation:
  - If multiple assets are downloaded, bundle as a zip and place in `binary.assetsZip`.
  - If a single asset is downloaded, `binary.asset` is acceptable.

---

## 4. Behaviour by Operation

All operations share a **common pipeline**:

1. Try **HTTP** first when applicable.
2. If HTTP not sufficient or clearly blocked/empty → use **Puppeteer**.
3. For operations that involve semantic understanding / crawling:
   - Use **Crawl4AI non-LLM** first.
   - If `useAI === true`, use **Crawl4AI LLM mode** (`f="llm"`) as **last resort**.

The internal logic must never expose this order as configuration; it is fixed.


### 4.1 `fetchContent` Operation

**Intent:**

- Read the content of the given URL and satisfy the `task` using the page’s content.
- Typical tasks:
  - "Find contact email."
  - "Get all text from this page."
  - "Extract phone number." etc.

**Algorithm:**

Given `url` and `task`:

1. **HTTP Stage**
   - `GET` the URL with a standard user agent.
   - If non-2xx status, or obvious block (403, 429, CAPTCHA markers), mark HTTP as failed; continue to Puppeteer.
   - Parse HTML:
     - `textContent` as visible text (basic stripping).
     - Extract `<title>`, headings (h1–h3), links.
   - Apply **task heuristics** (see 5.1):
     - If `task` contains keywords like `email`, `mail`, `contact`, run email regex and `mailto:` extraction over HTML + text.
     - If `task` contains `phone`, run phone regex.
     - If `task` is generic like `"Get all text"`, return `textContent`.
   - If heuristics produce a clear result (non-empty list or non-empty string depending on task), set:
     ```ts
     success = true;
     data = { /* extracted structure */ };
     ```
     and skip further stages.

2. **Puppeteer Stage**
   - If HTTP stage did not yield a satisfactory result:
     - Launch Puppeteer (headless).
     - `page.goto(url, { waitUntil: 'networkidle2', timeout: e.g. 45s })`.
     - Extract `page.content()` and `page.evaluate(() => document.body.innerText)`.
   - Reapply the same task heuristics as above.
   - If result found → `success = true; data = ...`.

3. **Crawl4AI non-LLM Stage**
   - Only used when task is more question-like and Page-level HTTP/Puppeteer extraction is insufficient.
   - Call `/md` with `f="bm25"`:
     ```json
     {
       "url": "<url>",
       "f": "bm25",
       "q": "<task>",
       "c": "0"
     }
     ```
   - From the response, attempt to extract the requested information using the same heuristics (e.g., email regex, phone regex) on the returned content.
   - If successful → `success = true; data = ...`.

4. **Crawl4AI LLM Stage (only if `useAI === true`)**
   - If `useAI === true` and still no satisfactory result:
     - Call `/md` with `f="llm"`:
       ```json
       {
         "url": "<url>",
         "f": "llm",
         "q": "<task>",
         "c": "0"
       }
       ```
     - Treat the response as the final answer.
     - Where possible, parse emails/phones from it; otherwise store as `data.rawAnswer`.

5. **Failure**
   - If all stages fail to produce a usable result:
     - `success = false`
     - `data = null`
     - `error = 'Could not satisfy task from page content.'`


**Example: Find contact email on a contact page**

- Input:
  - `operation = 'fetchContent'`
  - `url = 'https://www.aspinaloflondon.com/stores/aspinal-head-office-showroom'`
  - `task = 'Find contact email.'`
- Expected `data` shape:
  ```json
  {
    "emails": ["some-email@example.com"],
    "pageTitle": "Aspinal Head Office & Showroom",
    "page": "https://www.aspinaloflondon.com/stores/aspinal-head-office-showroom"
  }
  ```


### 4.2 `crawl` Operation

**Intent:**

- Starting from a base URL, explore relevant internal pages and satisfy a more global task.
- Typical tasks:
  - "Find contact email."
  - "Find all men wallet in this site." (extract product list from men’s wallets category)

**Algorithm (generic):**

Given `url` and `task`:

1. **Normalize base URL**
   - Ensure schema (`https://`) and trailing slash as needed.
   - Domain = host of the base URL; restrict crawling to same domain.

2. **Run Crawl4AI `/crawl`**
   - Send request:
     ```json
     {
       "urls": ["<baseUrl>"],
       "crawler_config": {
         "type": "CrawlerRunConfig",
         "params": {
           "scraping_strategy": { "type": "LXMLWebScrapingStrategy", "params": {} },
           "table_extraction": { "type": "DefaultTableExtraction", "params": {} },
           "exclude_social_media_domains": [
             "facebook.com","twitter.com","x.com","linkedin.com","instagram.com",
             "pinterest.com","tiktok.com","snapchat.com","reddit.com"
           ],
           "stream": true
         }
       }
     }
     ```
   - Incrementally process streamed results, building an in-memory list of crawled pages with:
     - `url`
     - `title` (if available)
     - `snippet` or partial text

3. **Candidate page selection**
   - Based on `task`, derive heuristics for candidate pages:
     - If task contains `email` or `contact`:
       - Prefer URLs containing: `contact`, `contacts`, `stores`, `store`, `head-office`, `head_office`, `about`, `support`, `help`, `customer-service`, etc.
     - If task contains `wallet`, `men wallet`, `men's wallet`, etc.:
       - Prefer URLs containing: `wallet`, `wallets`, `men`, `mens`, `mens-collection`, `mens-leather-wallets`, `leather-wallets`, etc.
   - Score pages based on URL slug + title + snippet keywords.
   - Keep top N candidates (e.g. N = 20) for deeper inspection.

4. **Per-candidate inspection**
   - For each candidate page (in priority order):
     - Run the **`fetchContent` pipeline** (HTTP → Puppeteer → Crawl4AI non-LLM → Crawl4AI LLM if allowed) **but with a more specific sub-task** inferred from the global task.
       - For email tasks: sub-task `"Find contact email."`.
       - For product list tasks: sub-task `"List all men wallets on this page with name, URL, and price if visible."`.
   - Accumulate results:
     - For email tasks: stop after first valid email and return single result.
     - For product list tasks: merge results across multiple category/listing pages into one list.

5. **Result shaping**

- **Email-style task:**
  ```ts
  data = {
    emails: string[];      // Unique list of emails discovered.
    pages: Array<{
      url: string;
      emails: string[];
    }>;
  };
  ```

- **Product-list-style task:** (e.g. "Find all men wallet in this site.")
  ```ts
  interface ProductSummary {
    name: string;
    url: string;
    price?: string; // best-effort; may be null/undefined
  }

  data = {
    products: ProductSummary[];
    sourcePages: string[]; // URLs of listing pages used
  };
  ```

If nothing relevant is found:

```ts
success = false;
data = null;
error = 'No relevant pages found or task could not be satisfied via crawling.';
```


### 4.3 `screenshot` Operation

**Intent:**

- Capture a screenshot of the page.
- The user may specify in `task` if they want full page vs viewport.

**Algorithm:**

1. Use Puppeteer only.
2. `page.goto(url, { waitUntil: 'networkidle2', timeout: ~45000 })`.
3. Decide mode based on `task`:
   - If task contains `full`, `entire`, `whole page`:
     - Use `fullPage: true`.
   - Else:
     - Use default viewport capture.
4. Create screenshot `Buffer` via `page.screenshot()`.
5. Output:

```ts
json = {
  url,
  operation: 'screenshot',
  task,
  success: true,
  data: {
    fullPage: boolean;
  },
};

binary.screenshot = { /* image binary */ };
```

On failure (timeout, navigation error, Puppeteer not available):

```ts
success = false;
data = null;
error = 'Failed to capture screenshot.';
```


### 4.4 `downloadAssets` Operation

**Intent:**

- Download assets (PDFs, images, CSVs, etc.) linked from the page or, if necessary, from a small crawl.
- The `task` text indicates which asset type(s) to download.

**Algorithm:**

1. **HTTP Stage**
   - Fetch HTML via HTTP.
   - Parse `<a href>`, `<img src>` and possibly `<link>` tags.
   - Infer asset type from `task`:
     - If `task` contains `pdf` → look for `.pdf`.
     - If `task` contains `image` or `images` → `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.avif`.
     - If `task` contains `csv` → `.csv`.
   - Normalize asset URLs (absolute URLs based on page URL).
   - Apply a **hard limit** (e.g., max 50 assets per URL) to avoid huge downloads.
   - Download each asset via HTTP into memory.
   - If multiple assets:
     - Zip them in a single `assets.zip` buffer.
     - Place into `binary.assetsZip`.
   - If single asset:
     - Place into `binary.asset`.
   - On any success:
     - `success = true`
     - `data = { assetsCount: number; assetType: string; zipped: boolean }`.

2. **Puppeteer Stage**
   - If HTTP appears to return empty content or JS-heavy page:
     - Use Puppeteer to obtain `page.content()` and repeat asset discovery.

3. **Optional small crawl**
   - For tasks like "Download all PDFs from this site", optionally:
     - Use `/crawl` to discover more pages.
     - For each crawled page, repeat asset extraction (respect global max asset count).

4. **Failure**
   - If no matching assets found or all downloads fail:
     - `success = false; data = null; error = 'No matching assets found or download failed.'`.


### 4.5 `runScript` Operation

**Intent:**

- Allow advanced users to run custom logic on the page via Puppeteer, without exposing a separate "customScript" parameter.
- The `task` is treated as script code/instruction.

**Design:**

- The `task` will be assumed to be a JavaScript function body that operates on a lightweight `pageContext` object constructed in the browser context.

**Algorithm:**

1. Launch Puppeteer, load the URL.
2. In `page.evaluate`, build a `pageContext` object:

```ts
const pageContext = {
  location: window.location.href,
  html: document.documentElement.outerHTML,
  text: document.body.innerText,
};
```

3. Execute the `task` as a function body with `pageContext` in the browser context.

Recommended pattern (pseudo-code):

```ts
const userScript = this.getNodeParameter('task', i) as string;

const result = await page.evaluate((scriptBody) => {
  const pageContext = {
    location: window.location.href,
    html: document.documentElement.outerHTML,
    text: document.body.innerText,
  };

  const fn = new Function('pageContext', scriptBody);
  return fn(pageContext);
}, userScript);
```

4. Whatever this function returns becomes `data`:

```ts
json = {
  url,
  operation: 'runScript',
  task: userScript,
  success: true,
  data: result,
};
```

5. On script errors, catch and return:

```ts
success = false;
data = null;
error = 'Error executing script: <short message>'; // keep message short
```

> **Security Note:** This is intended for **trusted self-hosted** environments only. The script runs inside the browser context, not in Node context, but it can still be dangerous if misused. No additional sandboxing is expected in v1.

---

## 5. Task Interpretation & Heuristics

Because the node does **not** expose explicit extraction modes or selectors, it must infer intent from `operation` + `task` using simple heuristics.

### 5.1 Task Keyword Heuristics

Implement a helper function:

```ts
interface TaskIntent {
  wantsEmail?: boolean;
  wantsPhone?: boolean;
  wantsTextDump?: boolean;
  wantsProductList?: boolean;
  wantsPdf?: boolean;
  wantsImages?: boolean;
  wantsCsv?: boolean;
}

function inferTaskIntent(task: string, operation: string): TaskIntent { /* ... */ }
```

Rules (case-insensitive, trimmed):

- **Emails**:
  - If `task` contains any of: `email`, `e-mail`, `contact email`, `mailto` → `wantsEmail = true`.
- **Phones**:
  - If `task` contains `phone`, `telephone`, `tel`, `contact number` → `wantsPhone = true`.
- **Text dump**:
  - If `operation === 'fetchContent'` and task contains words like: `all text`, `page text`, `content`, `full content` → `wantsTextDump = true`.
- **Product list (wallet example)**:
  - If `task` contains:
    - `wallet`, `wallets`, possibly preceded by `men`, `men's`, `mens` → `wantsProductList = true`.
- **PDFs**:
  - If `operation === 'downloadAssets'` and task contains `pdf` → `wantsPdf = true`.
- **Images**:
  - If `operation === 'downloadAssets'` and task contains `image`, `images`, `pictures`, `photos` → `wantsImages = true`.
- **CSVs**:
  - If `operation === 'downloadAssets'` and task contains `csv` → `wantsCsv = true`.

If no specific intent is found, treat as a generic task; for `fetchContent`, default to `wantsTextDump = true`.


### 5.2 Extraction Helpers

Implement in `src/utils/extraction.ts`:

- `extractEmails(textOrHtml: string): string[]`
  - Use robust regex for emails, deduplicate, filter out obvious junk.
- `extractPhones(text: string): string[]`
  - Use regex for phone-like patterns, optional country codes, filter by length.
- `extractProductsFromHtml(html: string): ProductSummary[]`
  - Best-effort DOM-based product extraction:
    - Look for repeated card-like structures.
    - Look for elements with `product`, `item`, `grid`, etc.
    - Extract:
      - Name: text of product title elements.
      - URL: `href` of product links.
      - Price: text of elements with `price` in class name or near product title.
  - This does not have to be perfect but should work on common e-commerce layouts.

---

## 6. Crawl4AI Integration

### 6.1 Base URL

- Configurable via parameter `crawl4aiBaseUrl`.
- Default: `http://157.173.126.92:11235`.

In code:

```ts
const baseUrl = this.getNodeParameter('crawl4aiBaseUrl', 0) as string;
```

Ensure no trailing slash duplication when constructing endpoint URLs.


### 6.2 `/crawl` Endpoint

**Request (example):**

```json
POST {baseUrl}/crawl
Content-Type: application/json

{
  "urls": ["https://www.aspinaloflondon.com"],
  "crawler_config": {
    "type": "CrawlerRunConfig",
    "params": {
      "scraping_strategy": {
        "type": "LXMLWebScrapingStrategy",
        "params": {}
      },
      "table_extraction": {
        "type": "DefaultTableExtraction",
        "params": {}
      },
      "exclude_social_media_domains": [
        "facebook.com","twitter.com","x.com","linkedin.com","instagram.com",
        "pinterest.com","tiktok.com","snapchat.com","reddit.com"
      ],
      "stream": true
    }
  }
}
```

**Response:**

- The exact schema may vary; implementation should:
  - Handle streamed responses or batched results.
  - For each crawled page, attempt to read fields like `url`, `title`, `content`, etc.
  - Store results in an internal structure for candidate selection (see 4.2).


### 6.3 `/md` Endpoint

Used for **per-URL semantic search / QA**.

**Non-LLM BM25 mode:**

```json
POST {baseUrl}/md
Content-Type: application/json

{
  "url": "https://www.aspinaloflondon.com",
  "f": "bm25",
  "q": "Find email id",
  "c": "0"
}
```

**LLM mode (only when `useAI === true`):**

```json
POST {baseUrl}/md
Content-Type: application/json

{
  "url": "https://www.aspinaloflondon.com",
  "f": "llm",
  "q": "Find email id",
  "c": "0"
}
```

Implementation details:

- Wrap calls in try/catch.
- On non-2xx responses, treat as failure for that stage and continue fallback chain.
- Response body should be treated as opaque text or structured JSON depending on what Crawl4AI returns; for v1, the node can:
  - Check if it’s valid JSON; if so, parse; else treat as string.
  - Run extraction helpers over the textual content.

---

## 7. Puppeteer Integration

### 7.1 Dependencies

- Add `puppeteer` as a dependency in `package.json`.
- Implement `src/strategies/puppeteer.ts` with a small wrapper API:

```ts
export interface PuppeteerPageContent {
  html: string;
  text: string;
}

export async function getPageContent(url: string): Promise<PuppeteerPageContent> { /* ... */ }

export async function captureScreenshot(url: string, fullPage: boolean): Promise<Buffer> { /* ... */ }

export async function runPageScript<T = any>(url: string, scriptBody: string): Promise<T> { /* ... */ }
```

### 7.2 Behaviour

- Use headless mode.
- Apply timeouts (e.g. 45 seconds per navigation).
- Close browser/page in `finally` blocks to avoid leaks.
- On errors, propagate a clear error object up to the node-level logic.

---

## 8. Node Execution Flow

### 8.1 `execute` Skeleton

In `WebAccess.node.ts`:

```ts
async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
  const items = this.getInputData();
  const returnItems: INodeExecutionData[] = [];

  const crawl4aiBaseUrl = this.getNodeParameter('crawl4aiBaseUrl', 0) as string;
  const useAI = this.getNodeParameter('useAI', 0) as boolean;
  const aiProvider = useAI ? (this.getNodeParameter('aiProvider', 0) as string | undefined) : undefined;
  const aiModel = useAI ? (this.getNodeParameter('aiModel', 0) as string | undefined) : undefined;

  for (let i = 0; i < items.length; i++) {
    const operation = this.getNodeParameter('operation', i) as string;
    const task = this.getNodeParameter('task', i) as string;
    const urlsParam = this.getNodeParameter('urls', i) as string | string[];
    const urls = Array.isArray(urlsParam) ? urlsParam : [urlsParam];

    for (const url of urls) {
      const result = await processUrl({
        url,
        operation,
        task,
        useAI,
        aiProvider,
        aiModel,
        crawl4aiBaseUrl,
      });

      const out: INodeExecutionData = {
        json: result.json,
      };

      if (result.binary) {
        out.binary = result.binary;
      }

      returnItems.push(out);
    }
  }

  return [returnItems];
}
```

`processUrl` (implemented in a helper module) encapsulates the strategy pipeline described in this PRD.

---

## 9. Testing & Example Scenarios

### 9.1 Scenario: Find Contact Email (Single Page)

- Input:
  - `urls = ['https://www.aspinaloflondon.com/stores/aspinal-head-office-showroom']`
  - `operation = 'fetchContent'`
  - `task = 'Find contact email.'`
  - `useAI = false`
- Expected:
  - `success = true`
  - `data.emails` contains a valid email address.


### 9.2 Scenario: Find Contact Email (Crawl)

- Input:
  - `urls = ['https://www.aspinaloflondon.com/']`
  - `operation = 'crawl'`
  - `task = 'Find contact email.'`
  - `useAI = false`
- Expected behaviour:
  - `/crawl` discovers internal pages.
  - Candidate selection prioritizes URLs with `stores` / `contact` / `head-office`.
  - `fetchContent` pipeline on those pages finds email.
  - `success = true`, `data.emails` non-empty, `data.pages` includes the page where it was found.


### 9.3 Scenario: Find All Men Wallets

- Input:
  - `urls = ['https://www.aspinaloflondon.com/']`
  - `operation = 'crawl'`
  - `task = 'Find all men wallet in this site.'`
  - `useAI = false`
- Expected behaviour:
  - `/crawl` discovers men’s wallets category pages.
  - Candidate selection prioritizes wallet-related URLs.
  - For each candidate, `fetchContent` pipeline extracts products via DOM heuristics.
  - Result:
    ```json
    {
      "success": true,
      "data": {
        "products": [
          { "name": "...", "url": "...", "price": "..." },
          ...
        ],
        "sourcePages": ["https://..."]
      }
    }
    ```


### 9.4 Scenario: Screenshot

- Input:
  - `urls = ['https://www.aspinaloflondon.com/']`
  - `operation = 'screenshot'`
  - `task = 'Full page screenshot.'`
- Expected:
  - `binary.screenshot` present, PNG buffer.
  - `json.data.fullPage === true`.


### 9.5 Scenario: Download PDFs

- Input:
  - `urls = ['https://example.com/resources']`
  - `operation = 'downloadAssets'`
  - `task = 'Download all PDFs.'`
- Expected:
  - Node finds `.pdf` links and downloads them (up to max count).
  - If > 1: `binary.assetsZip` present; `data.assetsCount` equals number of PDFs.


### 9.6 Scenario: Run Script

- Input:
  - `urls = ['https://example.com']`
  - `operation = 'runScript'`
  - `task` (script body):
    ```js
    const emailMatches = pageContext.text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    return { emails: Array.from(new Set(emailMatches)) };
    ```
- Expected:
  - `json.data.emails` contains extracted emails.
  - `success = true` if any found, else true with empty array (no error).

---

## 10. Non-Functional Requirements

- **Cost Awareness:**
  - Default behaviour must avoid LLM use.
  - LLM-based extraction is **only** used when `useAI` is enabled and only in the last stage of the pipeline.

- **Resilience:**
  - Errors in a given stage (HTTP, Puppeteer, Crawl4AI) should not abort the whole node; fallback to next stage.
  - Network timeouts and non-2xx responses handled gracefully.

- **Simplicity for User:**
  - Only visible configuration: `urls`, `operation`, `task`, `useAI`, optional AI provider/model, Crawl4AI base URL.
  - Output JSON is simple and operation-focused.

- **Extensibility:**
  - Code structure must allow:
    - Adding more heuristics to `inferTaskIntent`.
    - Extending product extraction logic.
    - Plugging in external LLMs in future versions without changing node interface.

---

## 11. Implementation Instructions to Claude Code

1. Create a new n8n custom node package named `n8n-nodes-webaccess` following official n8n node development conventions.
2. Implement the `Web Access` node exactly as specified:
   - Parameters: **only** those described in section 3.2.
   - Output JSON shape: **exactly** as section 3.3 (no extra top-level fields like `strategyUsed` or `steps`).
3. Implement internal modules (`http`, `puppeteer`, `crawl4ai`, `extraction`, `types`) as described, with clean TypeScript types.
4. Implement the strategy pipeline for each operation strictly as described in section 4.
5. Ensure that the node compiles and can be loaded by n8n without type errors.
6. Write minimal inline comments explaining each major step so it’s maintainable.

This PRD is intended to be self-sufficient: Claude Code should not change the interface or invent extra inputs/outputs; all behaviour should conform to this document.

