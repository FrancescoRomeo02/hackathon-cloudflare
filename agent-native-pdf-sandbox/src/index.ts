import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

type JsonObject = Record<string, unknown>;

type WorkspaceCreateRequest = {
  workspaceId?: string;
  name?: string;
  agents?: Array<{ name?: string; role?: string }>;
};

type UploadDocumentRequest = {
  documentId: string;
  filename: string;
  objectKey: string;
  bytes: number;
};

type ParseJob = {
  workspaceId: string;
  documentId: string;
  objectKey: string;
  filename: string;
};

type SearchRequest = {
  query?: string;
  topK?: number;
};

type MaterializeRequest = {
  agentName?: string;
  documentId?: string;
};

type AnnotateRequest = {
  agentName?: string;
  documentId?: string;
  instruction?: string;
};

type EmbeddingResponse = {
  data: number[][];
};

type MarkdownDocument = {
  name: string;
  data: string;
  mimeType: string;
  format: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {})
    }
  });
}

function badRequest(message: string, status = 400): Response {
  return json({ error: message }, { status });
}

function parseJson<T>(value: string | null): T {
  return JSON.parse(value ?? "{}") as T;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function chunkMarkdown(markdown: string, maxChars = 1800): string[] {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
    }

    if (paragraph.length <= maxChars) {
      current = paragraph;
      continue;
    }

    let start = 0;
    while (start < paragraph.length) {
      chunks.push(paragraph.slice(start, start + maxChars));
      start += maxChars;
    }
    current = "";
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function extractAssistantText(response: unknown): string {
  if (typeof response === "string") {
    return response;
  }

  if (response && typeof response === "object") {
    const record = response as Record<string, unknown>;
    if (typeof record.response === "string") {
      return record.response;
    }
    if (typeof record.result === "object" && record.result !== null) {
      const nested = record.result as Record<string, unknown>;
      if (typeof nested.response === "string") {
        return nested.response;
      }
    }
  }

  return JSON.stringify(response, null, 2);
}

function buildAnnotationPrompt(
  instruction: string,
  contextChunks: Array<{ score: number; content: string }>,
  documentId: string
): Array<{ role: string; content: string }> {
  const context = contextChunks
    .map(
      (chunk, index) =>
        `Context ${index + 1} (score ${chunk.score.toFixed(4)}):\n${chunk.content}`
    )
    .join("\n\n");

  return [
    {
      role: "system",
      content:
        "You are a document analysis agent. Produce concise, reviewable annotations grounded only in the supplied document context."
    },
    {
      role: "user",
      content: [
        `Document ID: ${documentId}`,
        `Task: ${instruction}`,
        "Return markdown with these sections:",
        "1. Summary",
        "2. Findings",
        "3. Suggested annotations",
        "4. Open questions",
        "",
        "Context:",
        context
      ].join("\n")
    }
  ];
}

async function readJsonBody<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

async function getWorkspaceStub(env: Env, workspaceId: string) {
  return env.WORKSPACE_MANAGER.getByName(workspaceId);
}

async function readWorkspaceState(env: Env, workspaceId: string) {
  const snapshot = await env.WORKSPACE_CACHE.get(`workspace:${workspaceId}`, "json");
  const workspace = await env.DB.prepare(
    "SELECT id, name, created_at FROM workspaces WHERE id = ?"
  )
    .bind(workspaceId)
    .first<JsonObject>();
  const agents = await env.DB.prepare(
    "SELECT name, role, created_at FROM agents WHERE workspace_id = ? ORDER BY name"
  )
    .bind(workspaceId)
    .all<JsonObject>();
  const documents = await env.DB.prepare(
    "SELECT id, filename, status, summary, created_at, updated_at FROM documents WHERE workspace_id = ? ORDER BY created_at DESC"
  )
    .bind(workspaceId)
    .all<JsonObject>();

  return {
    workspaceId,
    workspace,
    cache: snapshot,
    agents: agents.results,
    documents: documents.results
  };
}

export class WorkspaceManager extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS workspace_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
    });
  }

  async initializeWorkspace(input: WorkspaceCreateRequest) {
    const workspaceId = input.workspaceId ?? crypto.randomUUID();
    const createdAt = nowIso();
    const name = input.name?.trim() || `workspace-${workspaceId.slice(0, 8)}`;
    const agents =
      input.agents && input.agents.length > 0
        ? input.agents.map((agent, index) => ({
            name: agent.name?.trim() || `agent-${index + 1}`,
            role: agent.role?.trim() || "document-specialist"
          }))
        : [
            { name: "navigator", role: "document-navigation" },
            { name: "reviewer", role: "semantic-review" }
          ];

    await this.env.DB.batch([
      this.env.DB.prepare(
        "INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)"
      ).bind(workspaceId, name, createdAt),
      ...agents.map((agent) =>
        this.env.DB.prepare(
          "INSERT INTO agents (id, workspace_id, name, role, created_at) VALUES (?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), workspaceId, agent.name, agent.role, createdAt)
      )
    ]);

    await this.ctx.storage.put("workspaceId", workspaceId);

    await this.env.WORKSPACE_CACHE.put(
      `workspace:${workspaceId}`,
      JSON.stringify({
        id: workspaceId,
        name,
        agents,
        status: "ready",
        createdAt
      })
    );

    this.logEvent("workspace.created", { workspaceId, name, agents });

    return { workspaceId, name, agents, createdAt };
  }

  async getWorkspaceState() {
    const workspaceId = await this.getWorkspaceId();
    const snapshot = await this.env.WORKSPACE_CACHE.get(`workspace:${workspaceId}`, "json");
    const workspace = await this.env.DB.prepare(
      "SELECT id, name, created_at FROM workspaces WHERE id = ?"
    )
      .bind(workspaceId)
      .first<JsonObject>();
    const agents = await this.env.DB.prepare(
      "SELECT name, role, created_at FROM agents WHERE workspace_id = ? ORDER BY name"
    )
      .bind(workspaceId)
      .all<JsonObject>();
    const documents = await this.env.DB.prepare(
      "SELECT id, filename, status, summary, created_at, updated_at FROM documents WHERE workspace_id = ? ORDER BY created_at DESC"
    )
      .bind(workspaceId)
      .all<JsonObject>();

    return {
      workspaceId,
      workspace,
      cache: snapshot,
      agents: agents.results,
      documents: documents.results
    };
  }

  async registerDocument(input: UploadDocumentRequest) {
    const workspaceId = await this.getWorkspaceId();
    const timestamp = nowIso();

    await this.env.DB.prepare(
      `INSERT INTO documents (
        id, workspace_id, filename, object_key, bytes, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`
    )
      .bind(
        input.documentId,
        workspaceId,
        input.filename,
        input.objectKey,
        input.bytes,
        timestamp,
        timestamp
      )
      .run();

    await this.env.WORKSPACE_CACHE.put(
      `workspace:${workspaceId}:document:${input.documentId}`,
      JSON.stringify({
        id: input.documentId,
        filename: input.filename,
        status: "queued",
        uploadedAt: timestamp
      })
    );

    this.logEvent("document.queued", input);

    return {
      workspaceId,
      documentId: input.documentId,
      status: "queued"
    };
  }

  async completeDocumentIngestion(result: {
    documentId: string;
    markdownKey: string;
    summary: string;
    chunkCount: number;
  }) {
    const workspaceId = await this.getWorkspaceId();
    const timestamp = nowIso();

    await this.env.DB.prepare(
      `UPDATE documents
       SET status = 'indexed', markdown_key = ?, summary = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`
    )
      .bind(result.markdownKey, result.summary, timestamp, result.documentId, workspaceId)
      .run();

    await this.env.WORKSPACE_CACHE.put(
      `workspace:${workspaceId}:document:${result.documentId}`,
      JSON.stringify({
        id: result.documentId,
        status: "indexed",
        markdownKey: result.markdownKey,
        summary: result.summary,
        chunkCount: result.chunkCount,
        updatedAt: timestamp
      })
    );

    this.logEvent("document.indexed", result);
  }

  async failDocumentIngestion(result: { documentId: string; error: string }) {
    const workspaceId = await this.getWorkspaceId();
    const timestamp = nowIso();

    await this.env.DB.prepare(
      "UPDATE documents SET status = 'failed', updated_at = ? WHERE id = ? AND workspace_id = ?"
    )
      .bind(timestamp, result.documentId, workspaceId)
      .run();

    await this.env.WORKSPACE_CACHE.put(
      `workspace:${workspaceId}:document:${result.documentId}`,
      JSON.stringify({
        id: result.documentId,
        status: "failed",
        error: result.error,
        updatedAt: timestamp
      })
    );

    this.logEvent("document.failed", result);
  }

  async search(input: SearchRequest) {
    const workspaceId = await this.getWorkspaceId();
    if (!input.query?.trim()) {
      throw new Error("Query is required");
    }

    const embedding = await createEmbedding(this.env, input.query.trim());
    const topK = Math.min(Math.max(input.topK ?? 5, 1), 10);
    const results = await this.env.DOCUMENTS_INDEX.query(embedding, {
      topK,
      returnMetadata: "all",
      filter: { workspaceId }
    });

    return {
      workspaceId,
      query: input.query,
      matches: results.matches ?? []
    };
  }

  async materializeSandbox(input: MaterializeRequest) {
    const workspaceId = await this.getWorkspaceId();
    const agentName = input.agentName?.trim() || "navigator";
    const sandbox = getSandbox(this.env.Sandbox, workspaceId);

    await sandbox.mkdir(`/workspace/agents/${agentName}`, { recursive: true });
    await sandbox.mkdir("/workspace/docs", { recursive: true });

    const documentRows = await this.env.DB.prepare(
      `SELECT id, filename, markdown_key, summary
       FROM documents
       WHERE workspace_id = ? AND status = 'indexed'
       ORDER BY created_at DESC`
    )
      .bind(workspaceId)
      .all<{
        id: string;
        filename: string;
        markdown_key: string | null;
        summary: string | null;
      }>();

    for (const row of documentRows.results) {
      if (!row.markdown_key) {
        continue;
      }
      const object = await this.env.DOCUMENTS_BUCKET.get(row.markdown_key);
      if (!object) {
        continue;
      }

      const safeName = sanitizeFilename(`${row.id}-${row.filename}.md`);
      await sandbox.writeFile(`/workspace/docs/${safeName}`, await object.text());
    }

    const manifest = {
      workspaceId,
      agentName,
      materializedAt: nowIso(),
      documentCount: documentRows.results.length,
      activeDocumentId: input.documentId ?? null
    };

    await sandbox.writeFile(
      `/workspace/agents/${agentName}/manifest.json`,
      JSON.stringify(manifest, null, 2)
    );

    this.logEvent("sandbox.materialized", manifest);

    return manifest;
  }

  async annotateDocument(input: AnnotateRequest) {
    const workspaceId = await this.getWorkspaceId();
    const agentName = input.agentName?.trim() || "reviewer";
    const documentId = input.documentId?.trim();
    const instruction = input.instruction?.trim();

    if (!documentId) {
      throw new Error("documentId is required");
    }
    if (!instruction) {
      throw new Error("instruction is required");
    }

    const searchResult = await this.search({
      query: instruction,
      topK: 6
    });

    const contextualMatches = (searchResult.matches as Array<Record<string, unknown>>)
      .filter((match) => {
        const metadata = match.metadata as Record<string, unknown> | undefined;
        return !documentId || metadata?.documentId === documentId;
      })
      .map((match) => ({
        score: Number(match.score ?? 0),
        content: String((match.metadata as Record<string, unknown> | undefined)?.content ?? "")
      }))
      .filter((match) => match.content.length > 0)
      .slice(0, 4);

    const llmResponse = await this.env.AI.run(
      this.env.CHAT_MODEL,
      {
        messages: buildAnnotationPrompt(instruction, contextualMatches, documentId)
      },
      {
        gateway: {
          id: this.env.AI_GATEWAY_ID,
          skipCache: true
        }
      }
    );

    const content = extractAssistantText(llmResponse);
    const annotationId = crypto.randomUUID();
    const artifactKey = `workspaces/${workspaceId}/annotations/${annotationId}.md`;
    const createdAt = nowIso();
    const sandbox = getSandbox(this.env.Sandbox, workspaceId);

    await this.env.DOCUMENTS_BUCKET.put(artifactKey, content, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" }
    });
    await sandbox.mkdir(`/workspace/agents/${agentName}/annotations`, { recursive: true });
    await sandbox.writeFile(
      `/workspace/agents/${agentName}/annotations/${annotationId}.md`,
      content
    );

    await this.env.DB.prepare(
      `INSERT INTO annotations (
        id, workspace_id, document_id, agent_name, instruction, content, artifact_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        annotationId,
        workspaceId,
        documentId,
        agentName,
        instruction,
        content,
        artifactKey,
        createdAt
      )
      .run();

    this.logEvent("annotation.created", {
      annotationId,
      agentName,
      documentId
    });

    return {
      annotationId,
      agentName,
      documentId,
      artifactKey,
      content
    };
  }

  private logEvent(eventType: string, payload: JsonObject) {
    this.ctx.storage.sql.exec(
      "INSERT INTO workspace_events (event_type, payload_json, created_at) VALUES (?, ?, ?)",
      eventType,
      JSON.stringify(payload),
      nowIso()
    );
  }

  private async getWorkspaceId(): Promise<string> {
    const workspaceId = await this.ctx.storage.get<string>("workspaceId");
    if (!workspaceId) {
      throw new Error("Workspace is not initialized");
    }
    return workspaceId;
  }
}

async function createEmbedding(env: Env, text: string): Promise<number[]> {
  const response = (await env.AI.run(env.EMBEDDING_MODEL, {
    text: [text]
  })) as EmbeddingResponse;

  const vector = response.data?.[0];
  if (!vector) {
    throw new Error("Embedding generation returned no vectors");
  }

  return vector;
}

async function parsePdfToMarkdown(
  env: Env,
  objectKey: string,
  filename: string
): Promise<MarkdownDocument> {
  const object = await env.DOCUMENTS_BUCKET.get(objectKey);
  if (!object) {
    throw new Error(`Document not found in R2: ${objectKey}`);
  }

  const markdown = (await env.AI.toMarkdown(
    {
      name: filename,
      blob: new Blob([await object.arrayBuffer()], {
        type: "application/pdf"
      })
    }
  )) as MarkdownDocument;
  if (!markdown?.data) {
    throw new Error("Markdown extraction returned no content");
  }

  return markdown;
}

async function indexParsedDocument(env: Env, job: ParseJob) {
  const markdownDoc = await parsePdfToMarkdown(env, job.objectKey, job.filename);
  const chunks = chunkMarkdown(markdownDoc.data);
  const timestamp = nowIso();

  await env.DB.prepare("DELETE FROM document_chunks WHERE document_id = ?")
    .bind(job.documentId)
    .run();

  if (chunks.length > 0) {
    const embeddingsResponse = (await env.AI.run(env.EMBEDDING_MODEL, {
      text: chunks
    })) as EmbeddingResponse;

    const vectors = chunks.map((content, chunkIndex) => {
      const id = crypto.randomUUID();
      return {
        id,
        values: embeddingsResponse.data[chunkIndex],
        metadata: {
          workspaceId: job.workspaceId,
          documentId: job.documentId,
          chunkIndex,
          content
        }
      };
    });

    await env.DOCUMENTS_INDEX.upsert(vectors);

    await env.DB.batch(
      chunks.map((content, chunkIndex) =>
        env.DB.prepare(
          `INSERT INTO document_chunks (
            id, document_id, workspace_id, chunk_index, content, token_estimate, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          crypto.randomUUID(),
          job.documentId,
          job.workspaceId,
          chunkIndex,
          content,
          estimateTokens(content),
          JSON.stringify({
            workspaceId: job.workspaceId,
            documentId: job.documentId,
            chunkIndex
          }),
          timestamp
        )
      )
    );
  }

  const summary = chunks[0]?.slice(0, 400) ?? markdownDoc.data.slice(0, 400);
  const markdownKey = `workspaces/${job.workspaceId}/parsed/${job.documentId}.md`;
  await env.DOCUMENTS_BUCKET.put(markdownKey, markdownDoc.data, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" }
  });

  const stub = await getWorkspaceStub(env, job.workspaceId);
  await stub.completeDocumentIngestion({
    documentId: job.documentId,
    markdownKey,
    summary,
    chunkCount: chunks.length
  });
}

async function routeApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "GET" && path === "/health") {
    return json({
      ok: true,
      service: "agent-native-pdf-sandbox",
      date: "2026-07-08"
    });
  }

  if (request.method === "POST" && path === "/api/workspaces") {
    const input = await readJsonBody<WorkspaceCreateRequest>(request);
    const workspaceId = crypto.randomUUID();
    const bootstrapStub = await getWorkspaceStub(env, workspaceId);
    return json(
      await bootstrapStub.initializeWorkspace({ ...input, workspaceId }),
      { status: 201 }
    );
  }

  const workspaceMatch = path.match(/^\/api\/workspaces\/([^/]+)$/);
  if (request.method === "GET" && workspaceMatch) {
    return json(await readWorkspaceState(env, workspaceMatch[1]));
  }

  const documentsMatch = path.match(/^\/api\/workspaces\/([^/]+)\/documents$/);
  if (request.method === "POST" && documentsMatch) {
    const workspaceId = documentsMatch[1];
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return badRequest("Expected a multipart form with a 'file' field");
    }
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      return badRequest("Only PDF uploads are supported");
    }

    const documentId = crypto.randomUUID();
    const objectKey = `workspaces/${workspaceId}/raw/${documentId}-${sanitizeFilename(file.name)}`;
    await env.DOCUMENTS_BUCKET.put(objectKey, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type || "application/pdf" }
    });

    const stub = await getWorkspaceStub(env, workspaceId);
    const registered = await stub.registerDocument({
      documentId,
      filename: file.name,
      objectKey,
      bytes: file.size
    });

    await env.PARSE_QUEUE.send({
      workspaceId,
      documentId,
      objectKey,
      filename: file.name
    } satisfies ParseJob);

    return json(
      {
        ...registered,
        objectKey
      },
      { status: 202 }
    );
  }

  const searchMatch = path.match(/^\/api\/workspaces\/([^/]+)\/search$/);
  if (request.method === "POST" && searchMatch) {
    const stub = await getWorkspaceStub(env, searchMatch[1]);
    return json(await stub.search(await readJsonBody<SearchRequest>(request)));
  }

  const materializeMatch = path.match(/^\/api\/workspaces\/([^/]+)\/agents\/([^/]+)\/materialize$/);
  if (request.method === "POST" && materializeMatch) {
    const stub = await getWorkspaceStub(env, materializeMatch[1]);
    const body = await readJsonBody<MaterializeRequest>(request);
    return json(
      await stub.materializeSandbox({
        ...body,
        agentName: materializeMatch[2]
      })
    );
  }

  const annotateMatch = path.match(/^\/api\/workspaces\/([^/]+)\/agents\/([^/]+)\/annotations$/);
  if (request.method === "POST" && annotateMatch) {
    const stub = await getWorkspaceStub(env, annotateMatch[1]);
    const body = await readJsonBody<AnnotateRequest>(request);
    return json(
      await stub.annotateDocument({
        ...body,
        agentName: annotateMatch[2]
      })
    );
  }

  return badRequest("Route not found", 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await routeApi(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return json({ error: message }, { status: 500 });
    }
  },

  async queue(batch: MessageBatch<ParseJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const job = message.body as ParseJob;
      try {
        await indexParsedDocument(env, job);
        message.ack();
      } catch (error) {
        const stub = await getWorkspaceStub(env, job.workspaceId);
        await stub.failDocumentIngestion({
          documentId: job.documentId,
          error: error instanceof Error ? error.message : "Unknown error"
        });
        message.retry();
      }
    }
  }
} satisfies ExportedHandler<Env, ParseJob>;
