-- HuggingFace search-result cache: enriched metadata for HF models surfaced
-- in Discover search. Separate from CatalogModel so "Refresh catalog"
-- (which is ollama.com-only, deleteMany + createMany) never touches HF rows.
CREATE TABLE "HuggingFaceModel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "family" TEXT,
    "parentModel" TEXT,
    "parameterSize" TEXT,
    "quantizationLevel" TEXT,
    "contextLength" INTEGER,
    "sizeBytes" BIGINT,
    "sizeLabel" TEXT,
    "capabilities" TEXT NOT NULL DEFAULT '',
    "pulls" TEXT,
    "updated" TEXT,
    "cachedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);