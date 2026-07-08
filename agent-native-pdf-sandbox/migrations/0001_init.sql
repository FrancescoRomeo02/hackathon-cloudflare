CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, name)
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  object_key TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  status TEXT NOT NULL,
  markdown_key TEXT,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_document_chunks_document_chunk
  ON document_chunks(document_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_documents_workspace_status
  ON documents(workspace_id, status);

CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  instruction TEXT NOT NULL,
  content TEXT NOT NULL,
  artifact_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
