# Interface Approach: Agent Sandboxes for PDF Workflows

## Product Idea

The product is an agent-native PDF workspace. A user uploads a PDF, the platform creates an isolated Cloudflare-backed sandbox for that document, and one or more AI agents work inside that sandbox to inspect, search, annotate, transform, and reason over the document.

The interface should make the sandbox visible as a secure working room rather than a generic chat. The user needs to see the document, the extracted structure, the active agents, the shared state, and the evidence behind every result.

## Core Interface Principle

The main screen should be a three-pane workspace:

1. **Document pane**
   Shows the PDF pages, selected text, annotations, tables, extracted images, and page-level navigation.

2. **Agent workspace pane**
   Shows active agents, tasks, reasoning checkpoints, tool actions, and collaboration status.

3. **Evidence and structure pane**
   Shows parsed document structure, semantic search results, citations, metadata, extracted tables, and generated artifacts.

This layout keeps the PDF as the primary object. Chat is still present, but it should not dominate the product. The user is not just asking a bot questions; they are supervising a secure document workspace.

## Primary User Flow

### 1. Create Sandbox

The first screen is a compact upload and sandbox creation view:

- upload PDF;
- select task type, for example review, extract, compare, redact, summarize, annotate, or transform;
- choose agent mode: single agent, specialist team, or manual agent assignment;
- create isolated sandbox.

After upload, the UI should immediately show sandbox provisioning status:

- PDF stored in R2;
- parsing job queued;
- Durable Object workspace created;
- metadata indexed;
- semantic chunks available;
- agents ready.

The key feeling should be: "this document now has its own secure operating environment."

### 2. Parse and Map Document

Once parsing starts, the user sees a live document map:

- page thumbnails;
- sections and headings;
- tables;
- figures and images;
- metadata;
- detected entities;
- semantic chunks;
- extraction confidence.

This is useful even before agents answer questions because it proves that the system understands the PDF structure, not only raw text.

### 3. Work with Agents

The agent area should support task cards rather than only free-form chat.

Examples:

- "Find all termination clauses."
- "Extract every table into CSV."
- "Annotate pages that mention financial risk."
- "Compare this contract against our checklist."
- "Generate a redlined version with suggested edits."

Each task card should show:

- assigned agent;
- status;
- files or pages touched;
- citations;
- generated artifacts;
- user approval controls for edits.

For multi-agent workflows, agents should appear as specialized workers:

- **Parser Agent**: validates extracted text, tables, and images.
- **Search Agent**: retrieves relevant passages.
- **Analysis Agent**: performs reasoning over cited evidence.
- **Edit Agent**: proposes annotations, redactions, or revisions.
- **Verifier Agent**: checks outputs against source pages.

The UI should show agent coordination as a shared timeline. Users should be able to inspect what each agent produced and which document state it used.

### 4. Inspect Evidence

Every answer or edit proposal must be linked back to source evidence.

The evidence pane should support:

- cited page ranges;
- highlighted source snippets;
- table cell references;
- image references;
- extraction confidence;
- "open in PDF" actions;
- version comparison between original and generated artifacts.

This matters because PDF workflows are high-trust. The interface should make hallucination harder by forcing results to stay anchored to the parsed document.

### 5. Generate Artifacts

The platform should treat outputs as versioned artifacts inside the sandbox:

- annotated PDF;
- extracted JSON;
- CSV tables;
- summaries;
- redaction reports;
- compliance checklists;
- agent audit logs.

The artifact view should show provenance:

- source PDF version;
- agent or agents involved;
- task prompt;
- citations used;
- creation time;
- approval status.

## Suggested Screens

### Dashboard

Shows sandboxes, not just files.

Each sandbox card should include:

- document name;
- processing status;
- active agents;
- last task;
- artifact count;
- security/isolation indicator;
- last updated time.

### Sandbox Workspace

The main application screen:

- left: PDF viewer and page navigator;
- center: selected task, chat, and agent timeline;
- right: document map, evidence, search, and artifacts.

The center pane should switch between tabs:

- **Tasks**
- **Agents**
- **Chat**
- **Activity**

The right pane should switch between tabs:

- **Structure**
- **Search**
- **Evidence**
- **Artifacts**

### Agent Team View

Shows which agents are inside the sandbox:

- role;
- current task;
- permissions;
- memory scope;
- tool access;
- last action;
- confidence or blocked state.

This is where the user can add or remove agents, assign specialist roles, or freeze an agent if it is producing bad work.

### Artifact Review View

Shows generated files and proposed document changes:

- side-by-side original and generated document;
- accepted and rejected annotations;
- export controls;
- provenance metadata;
- audit trail.

## Cloudflare Architecture Mapping

### Cloudflare Workers

Use Workers for API endpoints, upload coordination, task dispatching, authenticated user actions, and lightweight agent orchestration.

### Cloudflare R2

Use R2 for:

- original PDFs;
- parsed page images;
- extracted tables;
- generated artifacts;
- versioned outputs;
- audit log snapshots.

### Cloudflare Durable Objects

Use one Durable Object per sandbox. It owns the live workspace state:

- active agents;
- task queue state;
- document cursor positions;
- shared annotations;
- artifact registry;
- collaboration events;
- permissions inside the sandbox.

This is the isolation boundary that makes the product understandable: every document workspace has one authoritative state object.

### Cloudflare D1

Use D1 for relational metadata:

- users;
- sandbox records;
- documents;
- artifact records;
- task history;
- billing or quota metadata;
- permission grants.

### Cloudflare KV

Use KV for low-latency cached data:

- document outline;
- chunk lookup metadata;
- UI session preferences;
- recent search cache;
- sandbox status snapshots.

### Cloudflare Queues

Use Queues for asynchronous document work:

- PDF parsing;
- OCR;
- table extraction;
- embedding generation;
- artifact generation;
- verifier passes;
- long-running agent jobs.

### Workers AI and AI Gateway

Use Workers AI or AI Gateway for model calls, with AI Gateway providing:

- observability;
- rate control;
- request logging;
- model routing;
- cost monitoring;
- retries and fallbacks.

### Vectorize or Search Layer

If available in scope, use Cloudflare Vectorize for semantic search over document chunks. If the MVP does not include Vectorize, store embeddings and chunk metadata in D1/R2 and keep search simpler for the first demo.

## State Model

Each sandbox should have a stable state model:

- `sandbox`: durable workspace identity and isolation boundary;
- `document`: original PDF and parsed versions;
- `chunk`: searchable semantic unit with citation pointers;
- `agent`: role, permissions, current task, and memory scope;
- `task`: user intent, status, assigned agents, and outputs;
- `annotation`: page-level or text-level document mark;
- `artifact`: generated output with provenance;
- `event`: append-only audit log entry.

The interface should expose these concepts directly enough that users understand what is happening without needing to know the infrastructure.

## MVP Interface for a Hackathon

Build the first version around one strong demo flow:

1. User uploads a PDF.
2. Platform creates a sandbox.
3. Parser extracts text and structure.
4. User asks a document question.
5. Agent answers with citations.
6. User asks for annotations.
7. Agent generates an annotated artifact.
8. User downloads or reviews the artifact.

Minimum screens:

- sandbox dashboard;
- upload/create sandbox screen;
- PDF workspace with document viewer, agent task panel, and evidence panel;
- artifacts panel.

Minimum agent roles:

- Search Agent;
- Analysis Agent;
- Verifier Agent.

Minimum visible Cloudflare story:

- R2 stores files and artifacts;
- Durable Object owns the sandbox;
- Queue processes parsing jobs;
- Worker exposes the app/API;
- D1 stores metadata;
- Workers AI or AI Gateway powers model calls.

## Design Direction

The visual style should feel like an operations workspace, not a marketing page.

Use:

- dense but readable panels;
- clear task status;
- document-first layout;
- compact agent cards;
- strong citation affordances;
- restrained color;
- explicit sandbox/security indicators;
- clear approval controls for edits.

Avoid:

- oversized hero sections;
- decorative illustrations;
- chat-only interaction;
- hidden document provenance;
- results without citations;
- unclear agent permissions.

## Key Differentiator

The strongest positioning is not "chat with a PDF." The stronger claim is:

> Every document gets its own secure Cloudflare-native agent workspace.

That means persistent state, isolated execution, multi-agent collaboration, versioned artifacts, and evidence-backed document manipulation. The interface should continuously reinforce that difference.
