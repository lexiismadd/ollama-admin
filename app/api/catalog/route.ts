export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getCatalog } from "@/lib/catalog";

export async function GET(req: NextRequest) {
  const search = req.nextUrl.searchParams.get("q")?.toLowerCase() || "";
  const capabilities = req.nextUrl.searchParams.get("c")?.toLowerCase() || "";
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  const capList = capabilities
    ? capabilities.split(",").filter(Boolean)
    : [];

  try {
    const { entries, stale } = await getCatalog(refresh);
    let models = entries;

    if (search) {
      models = models.filter(
        (m) =>
          m.name.toLowerCase().includes(search) ||
          m.description.toLowerCase().includes(search)
      );
    }

    if (capList.length > 0) {
      models = models.filter((m) =>
        capList.every((c) => m.capabilities.includes(c))
      );
    }

    // Serve-stale signal: the fetch failed and the client is seeing an older
    // cached copy from the database.
    const headers: Record<string, string> = {};
    if (stale) headers["X-Catalog-Stale"] = "true";
    return NextResponse.json(models, { headers });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch models from ollama.com" },
      { status: 502 }
    );
  }
}
