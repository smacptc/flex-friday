-- Flex Friday storage. One row per document, with a version for safe concurrent writes.
CREATE TABLE IF NOT EXISTS kv (
  key     TEXT PRIMARY KEY,
  value   TEXT    NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated INTEGER NOT NULL
);
