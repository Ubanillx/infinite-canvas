import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { toolNames } from "../canvas/schemas.js";
import { createMcpServer } from "./mcp.js";

test("MCP 真实列出管理工具、校验目标，并返回结构化提交结果与错误", async (t) => {
    const received: Array<{ token: string | string[] | undefined; body: Record<string, unknown> }> = [];
    const upstream = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { name: string; input: Record<string, unknown> };
        received.push({ token: req.headers["x-canvas-agent-token"], body });
        res.setHeader("content-type", "application/json");
        if (body.name === "prompts_delete") {
            res.statusCode = 409;
            res.end(JSON.stringify({ ok: false, error: "提示词版本冲突" }));
        } else res.end(JSON.stringify({ ok: true, result: { status: "committed", workspaceId: body.input.workspaceId, revision: 9, id: "new-project" } }));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    t.after(() => { upstream.closeAllConnections(); upstream.close(); });
    const url = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const token = "mcp-integration-fixture";
    const server = createMcpServer({ url, token });
    const client = new Client({ name: "platform-test", version: "1" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(async () => { await client.close(); await server.close(); });

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((item) => item.name).sort(), [...toolNames].sort());
    assert.equal(tools.find((item) => item.name === "prompts_get")?.annotations?.readOnlyHint, true);
    assert.equal(tools.find((item) => item.name === "canvas_delete_folder")?.annotations?.destructiveHint, true);
    assert.ok(tools.find((item) => item.name === "assets_add")?.inputSchema.required?.includes("workspaceId"));
    for (const name of ["templates_list", "templates_get", "templates_create", "templates_update", "templates_delete", "templates_instantiate", "templates_insert", "templates_export", "templates_import", "media_get", "media_import", "generation_list_results", "generation_get_result", "generation_resume_task", "generation_get_status", "workbench_image_generate", "workbench_video_generate"]) {
        assert.ok(tools.find((item) => item.name === name)?.inputSchema.required?.includes("workspaceId"), `${name} must require workspaceId`);
    }

    const invalid = await client.callTool({ name: "canvas_create_project", arguments: { title: "Missing target" } });
    assert.equal(invalid.isError, true);
    assert.equal(received.length, 0);
    const result = await client.callTool({ name: "canvas_create_project", arguments: { workspaceId: "workspace-a", title: "New" } });
    assert.deepEqual(result.structuredContent, { status: "committed", workspaceId: "workspace-a", revision: 9, id: "new-project" });
    assert.equal(received[0].token, token);
    assert.deepEqual(received[0].body, { name: "canvas_create_project", input: { workspaceId: "workspace-a", title: "New" } });
    const invalidTemplate = await client.callTool({ name: "templates_insert", arguments: { templateId: "template", projectId: "project" } });
    assert.equal(invalidTemplate.isError, true);
    assert.equal(received.length, 1);
    const template = await client.callTool({ name: "templates_insert", arguments: { workspaceId: "workspace-a", templateId: "template", projectId: "project" } });
    assert.deepEqual(template.structuredContent, { status: "committed", workspaceId: "workspace-a", revision: 9, id: "new-project" });
    assert.deepEqual(received[1].body, { name: "templates_insert", input: { workspaceId: "workspace-a", templateId: "template", projectId: "project" } });
    const imageInput = { storageKey: "image:one", naturalWidth: 1, naturalHeight: 1, bytes: 68, mimeType: "image/png" };
    const filled = await client.callTool({ name: "templates_instantiate", arguments: { workspaceId: "workspace-a", templateId: "template", inputs: { "image-node": imageInput } } });
    assert.notEqual(filled.isError, true);
    assert.deepEqual(received[2].body, { name: "templates_instantiate", input: { workspaceId: "workspace-a", templateId: "template", inputs: { "image-node": imageInput } } });
    const missingRequest = await client.callTool({ name: "workbench_image_generate", arguments: { prompt: "A test", run: true } });
    assert.equal(missingRequest.isError, true);
    const conflict = await client.callTool({ name: "prompts_delete", arguments: { workspaceId: "workspace-a", id: "prompt" } });
    assert.equal(conflict.isError, true);
    assert.match(JSON.stringify(conflict.content), /提示词版本冲突/);
});
