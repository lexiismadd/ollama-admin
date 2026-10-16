-- The CatalogModel cache table is reshaped: legacy "tags" / "pullCount" columns
-- become the richer catalog entry columns used by both the scraped and the
-- Ollama.com cloud catalog. The table only ever holds a disposable cache, so a
-- drop + recreate is safe.
DROP TABLE IF EXISTS "CatalogModel";

CREATE TABLE "CatalogModel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "family" TEXT,
    "parentModel" TEXT,
    "parameterSize" TEXT,
    "quantizationLevel" TEXT,
    "contextLength" INTEGER,
    "sizeBytes" BIGINT,
    "url" TEXT,
    "capabilities" TEXT NOT NULL DEFAULT '',
    "sizes" TEXT NOT NULL DEFAULT '',
    "pullCount" TEXT,
    "lastUpdated" TEXT,
    "cachedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
