export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { listModels } from "@/lib/ollama";
import { enrichModels } from "@/lib/model-enrichment";

export async function GET(req: NextRequest) {
  const serverId = req.nextUrl.searchParams.get("serverId");

  if (!serverId) {
    return NextResponse.json(
      { error: "serverId is required" },
      { status: 400 }
    );
  }

  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }
  if (!server.active) {
    return NextResponse.json({ error: "Server is inactive" }, { status: 403 });
  }

  try {
    const data = await listModels(server.url);
    const extras = await enrichModels(server.url, data.models);
    const models = data.models.map((model) => {
      const extra = extras.get(model.name);
      return { ...model, capabilities: extra?.capabilities ?? [], context_length: extra?.contextLength ?? null };
    });
    return NextResponse.json({ models });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list models";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
