import { assertAgentWorkspace, requireAgentWorkspace } from "@/lib/agent/agent-tool-context";
import { deleteWorkspacePrompt, listWorkspacePrompts, saveWorkspacePrompt, type WorkspacePrompt, type WorkspacePromptInput } from "@/services/api/workspace-prompts";

export const PROMPT_TOOL_NAMES = ["prompts_list", "prompts_get", "prompts_create", "prompts_update", "prompts_delete"] as const;
export type PromptToolName = (typeof PROMPT_TOOL_NAMES)[number];

export function isPromptTool(name: string): name is PromptToolName {
    return (PROMPT_TOOL_NAMES as readonly string[]).includes(name);
}

type ToolInput = Record<string, unknown>;

export async function runPromptTool(name: PromptToolName, input: ToolInput): Promise<unknown> {
    const workspace = requireAgentWorkspace(input, name === "prompts_create" || name === "prompts_update" || name === "prompts_delete");

    if (name === "prompts_list") {
        const keyword = optionalString(input.keyword, "keyword").trim().toLowerCase();
        const tags = optionalTags(input.tags);
        const page = positiveInteger(input.page, "page", 1);
        const pageSize = Math.min(100, positiveInteger(input.pageSize, "pageSize", 20));
        const items = await listWorkspacePrompts();
        assertAgentWorkspace(workspace.id);
        const owned = items.filter((item) => item.workspaceId === workspace.id);
        const filtered = owned.filter((item) =>
            (!tags.length || tags.some((tag) => item.tags.includes(tag))) &&
            (!keyword || [item.title, item.prompt, item.description, ...item.tags].join(" ").toLowerCase().includes(keyword)),
        );
        return { workspaceId: workspace.id, total: filtered.length, page, pageSize, items: filtered.slice((page - 1) * pageSize, page * pageSize) };
    }

    if (name === "prompts_get") {
        const item = await readOwnedPrompt(workspace.id, requiredString(input.id, "id"));
        return { workspaceId: workspace.id, item };
    }

    if (name === "prompts_create") {
        const fields = promptFields(input, undefined);
        assertAgentWorkspace(workspace.id);
        const item = await saveWorkspacePrompt(fields);
        return { status: "committed", workspaceId: workspace.id, item };
    }

    if (name === "prompts_update") {
        const id = requiredString(input.id, "id");
        const existing = await readOwnedPrompt(workspace.id, id);
        const revision = promptRevision(existing);
        const fields = promptFields(input, existing);
        assertAgentWorkspace(workspace.id);
        const item = await saveWorkspacePrompt(fields, id, revision);
        return { status: "committed", workspaceId: workspace.id, item };
    }

    if (name === "prompts_delete") {
        const id = requiredString(input.id, "id");
        const existing = await readOwnedPrompt(workspace.id, id);
        const revision = promptRevision(existing);
        assertAgentWorkspace(workspace.id);
        await deleteWorkspacePrompt(id, revision);
        return { status: "committed", workspaceId: workspace.id, id };
    }

    throw new Error(`未知提示词工具：${name}`);
}

async function readOwnedPrompt(workspaceId: string, id: string): Promise<WorkspacePrompt> {
    const items = await listWorkspacePrompts();
    assertAgentWorkspace(workspaceId);
    const item = items.find((prompt) => prompt.id === id && prompt.workspaceId === workspaceId);
    if (!item) throw new Error("当前工作区提示词不存在或无权访问");
    return item;
}

function promptRevision(item: WorkspacePrompt): string {
    if (typeof item.revision !== "string" || !item.revision) throw new Error("提示词版本不可用，请刷新后重试");
    return item.revision;
}

function promptFields(input: ToolInput, existing?: WorkspacePrompt): WorkspacePromptInput {
    const title = fieldString(input, "title", existing?.title).trim();
    const prompt = fieldString(input, "prompt", existing?.prompt).trim();
    if (!title || !prompt) throw new Error("请填写标题和提示词");
    const description = fieldString(input, "description", existing?.description || "").trim();
    const tags = input.tags === undefined ? existing?.tags || [] : optionalTags(input.tags);
    const shared = input.shared === undefined ? existing?.shared || false : input.shared;
    if (typeof shared !== "boolean") throw new Error("shared 必须为布尔值");
    const coverDataUrl = input.coverDataUrl;
    if (coverDataUrl !== undefined && coverDataUrl !== null && typeof coverDataUrl !== "string") throw new Error("coverDataUrl 必须为图片 data URL 或 null");
    return { title, prompt, description, tags, shared, ...(coverDataUrl === undefined ? {} : { coverDataUrl }) };
}

function requiredString(value: unknown, name: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 必须为非空字符串`);
    return value.trim();
}

function optionalString(value: unknown, name: string): string {
    if (value === undefined) return "";
    if (typeof value !== "string") throw new Error(`${name} 必须为字符串`);
    return value;
}

function fieldString(input: ToolInput, name: string, fallback?: string): string {
    const value = input[name];
    if (value === undefined) return fallback || "";
    if (typeof value !== "string") throw new Error(`${name} 必须为字符串`);
    return value;
}

function optionalTags(value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((tag) => typeof tag === "string")) throw new Error("tags 必须为字符串数组");
    return value.map((tag: string) => tag.trim()).filter(Boolean);
}

function positiveInteger(value: unknown, name: string, fallback: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${name} 必须为正整数`);
    return value;
}
