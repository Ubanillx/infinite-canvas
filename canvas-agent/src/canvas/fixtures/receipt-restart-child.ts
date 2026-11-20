import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";

import { CanvasSession } from "../session.js";

const workspace = process.env.RECEIPT_TEST_WORKSPACE!;
const session = new CanvasSession("", "codex", workspace);
class Response extends EventEmitter {
    chunks: string[] = [];
    writeHead() { return this; }
    write(chunk: string) { this.chunks.push(chunk); return true; }
    end() { this.emit("close"); }
    events(type: string) {
        return this.chunks.filter((chunk) => chunk.startsWith(`event: ${type}\n`)).map((chunk) => JSON.parse(chunk.split("data: ")[1]) as Record<string, unknown>);
    }
}
const response = new Response();
session.openEvents(new URL("http://127.0.0.1/events?clientId=tab"), response as unknown as ServerResponse);
if (process.env.RECEIPT_TEST_PHASE === "dispatch") {
    void session.callTool("canvas_create_text_node", { text: "only once" });
    const call = response.events("tool_call")[0];
    process.stdout.write(`RECEIPT:${JSON.stringify({ requestId: call.requestId, connectionId: call.connectionId })}\n`);
} else {
    const requestId = process.env.RECEIPT_TEST_REQUEST_ID!;
    const connectionId = process.env.RECEIPT_TEST_CONNECTION_ID!;
    const statusBefore = session.toolResult("tab", connectionId, requestId).status;
    const lateAccepted = session.resolveResult("tab", { requestId, connectionId, result: { saved: true } });
    process.stdout.write(`RECEIPT:${JSON.stringify({ statusBefore, toolCalls: response.events("tool_call").length, lateAccepted, statusAfter: session.toolResult("tab", connectionId, requestId).status })}\n`);
}
process.exit(0);
