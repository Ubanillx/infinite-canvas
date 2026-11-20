import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { toolNames } from "./schemas.js";

const receiptSchema = z.object({
    version: z.literal(1),
    requestId: z.string().uuid(),
    clientId: z.string().min(1),
    connectionId: z.string().uuid(),
    name: z.enum(toolNames),
    status: z.enum(["pending", "completed", "failed", "unknown"]),
    result: z.unknown().optional(),
    error: z.string().optional(),
}).refine((receipt) => receipt.status === "failed"
    ? Boolean(receipt.error) && receipt.result === undefined
    : receipt.error === undefined && (receipt.status === "completed" || receipt.result === undefined), "工具回执状态与结果不一致");
export type ToolReceipt = Omit<z.infer<typeof receiptSchema>, "version">;

/** Persist request identity before dispatch and results before acknowledgement. */
export class ToolReceiptStore {
    private receipts = new Map<string, ToolReceipt>();
    private root: string;

    constructor(workspacePath: string) {
        this.root = workspacePath ? path.join(workspacePath, ".infinite-canvas", "tool-receipts") : "";
        if (!this.root) return;
        let entries: string[];
        try {
            entries = fs.readdirSync(this.root);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
        for (const entry of entries.filter((entry) => entry.endsWith(".json"))) {
            const receipt = this.read(path.join(this.root, entry));
            if (entry !== `${receipt.requestId}.json`) throw new Error("工具回执文件名与请求不匹配，未覆盖原文件");
            // A prior process cannot still be waiting; recovery must never dispatch it again.
            this.receipts.set(receipt.requestId, { ...receipt, status: receipt.status === "pending" ? "unknown" : receipt.status });
        }
    }

    get(requestId: string) {
        return this.receipts.get(requestId);
    }

    values() {
        return this.receipts.values();
    }

    set(receipt: ToolReceipt) {
        const stored = receiptSchema.parse({ ...receipt, version: 1 });
        if (this.root) {
            fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
            const target = path.join(this.root, `${stored.requestId}.json`);
            // Reject unreadable or unknown existing data rather than erase recovery evidence.
            try {
                const previous = this.read(target);
                if (previous.clientId !== stored.clientId || previous.connectionId !== stored.connectionId || previous.name !== stored.name) throw new Error("工具回执归属冲突，未覆盖原文件");
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                if (this.receipts.has(stored.requestId)) throw new Error("工具回执文件已丢失，未覆盖原记录");
            }
            const temporary = `${target}.${crypto.randomUUID()}.tmp`;
            try {
                const fd = fs.openSync(temporary, "wx", 0o600);
                try {
                    fs.writeFileSync(fd, JSON.stringify(stored));
                    fs.fsyncSync(fd);
                } finally {
                    fs.closeSync(fd);
                }
                fs.renameSync(temporary, target);
            } finally {
                try { fs.rmSync(temporary, { force: true }); } catch { /* An orphan temporary file is never authoritative. */ }
            }
        }
        this.receipts.set(stored.requestId, stored);
    }

    private read(file: string) {
        try {
            return receiptSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
            throw new Error(`工具回执损坏、版本未知或无法读取，未覆盖原文件：${file}`, { cause: error });
        }
    }
}
