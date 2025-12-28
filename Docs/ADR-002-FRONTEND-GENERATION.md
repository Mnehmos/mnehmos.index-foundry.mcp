# ADR-002: Frontend UI & Conversation State Generation

## Status
IMPLEMENTED

## Date
2025-12-26

## Context

The planning documents at `C:\Users\mnehm\Desktop\vario-automation\planning\indexfoundry-refactor\` identified two critical gaps:

| Gap | Priority | Impact |
|-----|----------|--------|
| No Frontend UI Generation | P0 | Users must manually create UI |
| No Conversation State | P1 | Stateless `/chat` limits usability |

### Reference Architecture: Vario-Automation

The [`01-vario-automation-analysis.md`](file:///C:/Users/mnehm/Desktop/vario-automation/planning/indexfoundry-refactor/01-vario-automation-analysis.md) documents a production chatbot with:

**Frontend Features**:
- Astro static site with embedded chat page
- SSE streaming for real-time responses
- Citation system with modal popups (source text, relevance score, metadata)
- Example questions for quick start
- Typing indicators and status messages
- Security: OpenAI API key NEVER exposed to browser

**Backend Features**:
- Proxy architecture: Browser → Backend → OpenAI
- Dual server: MCP (stdio) + HTTP (Express)
- `/chat` endpoint with SSE streaming
- Citation markers `[Source N]` in responses

---

## Decision

### P0: Frontend UI Generation

Add a `frontend/` directory to project exports containing a minimal, production-ready chat interface.

**Technology Choice**: Single HTML file with embedded CSS/JS

**Rationale**:
- Zero build step required
- Works with any hosting (GitHub Pages, Netlify, S3)
- Users can easily customize or integrate into existing sites
- No framework lock-in

**Generated Files**:
```
project/
├── frontend/
│   ├── index.html      # Chat UI (self-contained)
│   └── local.config.js # Dev secrets template (gitignored)
├── src/
│   └── index.ts        # Backend (already exists)
└── ...
```

**Chat UI Features**:
1. SSE streaming with live token display
2. Citation badges with click-to-expand modal
3. 4 example questions (auto-generated from content)
4. Status indicator (Ready/Thinking/Error)
5. Mobile responsive
6. Dark/light theme toggle
7. Copy response button

**Security Pattern**:
```javascript
// frontend/index.html
const CONFIG = {
  ragServer: window.LOCAL_CONFIG?.RAG_SERVER || 
    'https://PROJECT_ID-production.up.railway.app'
};
// API key lives in backend, never exposed
```

### P1: Conversation State

Extend `/chat` endpoint to support multi-turn conversations.

**Implementation**:
1. Add optional `conversation_id` and `messages` array to `/chat` request
2. Backend maintains context window from previous turns
3. New endpoint `POST /conversations` to create session
4. Store last N messages (configurable, default 10)

**Request Schema**:
```typescript
interface ChatRequest {
  question: string;
  conversation_id?: string;  // NEW: optional session ID
  messages?: Message[];      // NEW: previous turns for context
  system_prompt?: string;
  model?: string;
  top_k?: number;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}
```

**Response Changes**:
- Add `conversation_id` to SSE `done` event
- Frontend stores and sends on subsequent messages

---

## Task Map

### Phase 1: Frontend Generation (P0)

| Task ID | Description | Mode | Est. |
|---------|-------------|------|------|
| FE-001 | Create chat UI template (`templates/chat.html`) | code | 2h |
| FE-002 | Create citation modal component | code | 1h |
| FE-003 | Add SSE streaming handler | code | 1h |
| FE-004 | Add example question generator | code | 30m |
| FE-005 | Integrate into `project_export` | code | 30m |
| FE-006 | Add `local.config.js` template | code | 15m |
| FE-007 | Update DEPLOYMENT.md with frontend section | code | 30m |
| FE-008 | Integration test | debug | 30m |

**Total Phase 1**: ~6.5 hours

### Phase 2: Conversation State (P1)

| Task ID | Description | Mode | Est. |
|---------|-------------|------|------|
| CS-001 | Update ChatRequest schema | code | 30m |
| CS-002 | Add conversation context building | code | 1h |
| CS-003 | Update frontend to track conversation | code | 30m |
| CS-004 | Add "New Chat" button | code | 15m |
| CS-005 | Integration test | debug | 30m |

**Total Phase 2**: ~2.75 hours

---

## Detailed Specifications

### FE-001: Chat UI Template

**File**: `src/templates/chat.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{PROJECT_NAME}} - Chat</title>
  <style>
    /* Embedded Tailwind-like utility classes */
    /* Responsive design */
    /* Dark mode support */
  </style>
</head>
<body>
  <div id="app">
    <header>
      <h1>{{PROJECT_NAME}}</h1>
      <button id="theme-toggle">🌙</button>
    </header>
    
    <main id="chat-container">
      <div id="messages"></div>
      
      <div id="example-questions">
        {{#each EXAMPLES}}
        <button class="example-btn">{{this}}</button>
        {{/each}}
      </div>
    </main>
    
    <footer>
      <form id="chat-form">
        <input type="text" id="question" placeholder="Ask a question..." />
        <button type="submit">Send</button>
      </form>
      <div id="status">Ready</div>
    </footer>
  </div>
  
  <!-- Citation Modal -->
  <div id="citation-modal" class="hidden">
    <div class="modal-content">
      <button class="close">&times;</button>
      <h3 id="modal-title"></h3>
      <p id="modal-text"></p>
      <div id="modal-meta"></div>
      <a id="modal-link" target="_blank">View Source</a>
    </div>
  </div>
  
  <script>
    // Configuration (overridable via local.config.js)
    const CONFIG = {
      ragServer: window.LOCAL_CONFIG?.RAG_SERVER || '{{RAG_SERVER_URL}}'
    };
    
    // SSE streaming handler
    async function sendMessage(question) { /* ... */ }
    
    // Citation system
    function showCitation(sourceIndex) { /* ... */ }
    
    // Example questions
    document.querySelectorAll('.example-btn').forEach(btn => {
      btn.addEventListener('click', () => sendMessage(btn.textContent));
    });
  </script>
</body>
</html>
```

### FE-004: Example Question Generator

Auto-generate 4 example questions from indexed content:

```typescript
function generateExampleQuestions(chunks: Chunk[]): string[] {
  // Strategy 1: Extract from headings
  const headings = chunks
    .filter(c => c.metadata?.heading)
    .map(c => `What is ${c.metadata.heading}?`);
  
  // Strategy 2: Extract key topics from content
  const topics = extractKeyTopics(chunks);
  
  // Strategy 3: Use source names
  const sources = [...new Set(chunks.map(c => c.source.name))]
    .map(s => `Tell me about ${s}`);
  
  return [...headings, ...topics, ...sources].slice(0, 4);
}
```

### CS-002: Conversation Context Building

```typescript
// In /chat handler
async function buildContext(
  question: string,
  previousMessages: Message[],
  ragContext: Chunk[]
): string {
  const contextWindow = previousMessages.slice(-10); // Last 10 turns
  
  const systemPrompt = `You are a helpful assistant...

CONTEXT FROM KNOWLEDGE BASE:
${ragContext.map((c, i) => `[Source ${i+1}] ${c.text}`).join('\n\n')}

CONVERSATION HISTORY:
${contextWindow.map(m => `${m.role}: ${m.content}`).join('\n')}
`;
  
  return systemPrompt;
}
```

---

## Acceptance Criteria

### P0 Complete When:
- [ ] `project_export` generates `frontend/index.html`
- [ ] Chat UI connects to backend and streams responses
- [ ] Citations display with modal popup
- [ ] Example questions work
- [ ] Responsive on mobile
- [ ] Dark mode toggle works
- [ ] Deployment guide updated

### P1 Complete When:
- [ ] `/chat` accepts `conversation_id` parameter
- [ ] Multi-turn conversations maintain context
- [ ] Frontend tracks conversation and sends history
- [ ] "New Chat" button clears conversation
- [ ] Integration test passes

---

## Alternatives Considered

### Frontend: React/Vue Component
**Rejected**: Adds build step, framework lock-in, larger bundle

### Frontend: Astro Integration
**Rejected**: Requires Astro knowledge, heavier dependency

### Conversation: Server-Side Storage
**Rejected**: Adds database dependency, complicates deployment
**Current Choice**: Client-side storage with server stateless

---

## References

- [`01-vario-automation-analysis.md`](file:///C:/Users/mnehm/Desktop/vario-automation/planning/indexfoundry-refactor/01-vario-automation-analysis.md)
- [`02-indexfoundry-capabilities.md`](file:///C:/Users/mnehm/Desktop/vario-automation/planning/indexfoundry-refactor/02-indexfoundry-capabilities.md)
- Vario-automation demo.astro (665 lines, production reference)

---

## Implementation Notes

### Completed: December 2024

**P0 - Frontend Generation:**
- ✅ Created [`src/templates/chat.html`](../src/templates/chat.html) - 1458-line production-ready chat UI
- ✅ SSE streaming handler for `/chat` endpoint
- ✅ Citation modal with source metadata
- ✅ Dark/light theme toggle (persisted via localStorage)
- ✅ Mobile responsive design
- ✅ Copy response button
- ✅ Example question generation via `generateExampleQuestions()`
- ✅ Integrated into `project_export` tool

**P1 - Conversation State:**
- ✅ `Message` and `ChatRequest` interfaces in server template
- ✅ `conversation_id` generation and tracking
- ✅ Multi-turn context (last 10 messages)
- ✅ "New Chat" button in UI
- ✅ Conversation indicator in status bar

**Generated Files:**
| File | Purpose |
|------|---------|
| `frontend/index.html` | Complete chat UI with all features |
| `frontend/local.config.js.example` | Local development configuration |

**Template Variables:**
- `{{PROJECT_NAME}}` → Project name from manifest
- `{{RAG_SERVER_URL}}` → Railway production URL
- `{{EXAMPLE_1}}` through `{{EXAMPLE_4}}` → Generated from content

**Bug Fix:**
- ESM `__dirname` compatibility resolved using `fileURLToPath(import.meta.url)`
