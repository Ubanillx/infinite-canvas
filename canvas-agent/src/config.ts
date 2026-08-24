import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 17371;
export const CONFIG_DIR = path.join(os.homedir(), ".infinite-canvas");
export const CONFIG_FILE = path.join(CONFIG_DIR, "canvas-agent.json");
export const VERSION = readPackageVersion();
export const AGENT_PROMPT = fs.readFileSync(new URL("../agent-instructions.md", import.meta.url), "utf8");
const initializedWorkspaces = new Set<string>();
const requestWorkspaceStates = new Map<string, SiteWorkspaceConfig>();

export type SiteWorkspaceConfig = { workspacePath: string; activeThreadId?: string; pinnedThreadIds?: string[] };
export type CanvasAgentConfig = { url: string; token: string; origins?: string[]; workspace?: SiteWorkspaceConfig };

/** 读取本地 Canvas Agent 配置，不存在时生成默认配置。 */
export function loadConfig(create = false): CanvasAgentConfig {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as CanvasAgentConfig;
    } catch {
        const config = { url: `http://127.0.0.1:${Number(process.env.PORT) || DEFAULT_PORT}`, token: crypto.randomBytes(18).toString("hex") };
        if (create) saveConfig(config);
        return config;
    }
}

/** 将 Canvas Agent 配置写入用户配置目录。 */
export function saveConfig(config: CanvasAgentConfig) {
    writeConfigFile(CONFIG_DIR, CONFIG_FILE, config);
}

/** 写入配置并强制目录 0700、文件 0600，包括纠正已有宽松权限。 */
export function writeConfigFile(dir: string, file: string, config: CanvasAgentConfig) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(file, 0o600);
}

/** 确保站点级 Codex 工作空间存在并已初始化。 */
export function ensureSiteWorkspace(config: CanvasAgentConfig): SiteWorkspaceConfig {
    const current = config.workspace;
    if (current?.workspacePath) {
        const workspacePath = resolveWorkspacePath(current.workspacePath);
        initializeWorkspace(workspacePath);
        return { ...current, workspacePath };
    }
    const workspacePath = path.join(CONFIG_DIR, "codex-workspaces", "site");
    config.workspace = { workspacePath };
    initializeWorkspace(workspacePath);
    saveConfig(config);
    return { workspacePath };
}

/** 为已通过站点网关认证的工作区请求返回独立的 Codex 工作目录。 */
export function ensureRequestWorkspace(config: CanvasAgentConfig, workspaceId?: string): SiteWorkspaceConfig {
    const normalized = String(workspaceId || "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(normalized)) return ensureSiteWorkspace(config);
    const current = requestWorkspaceStates.get(normalized);
    if (current) {
        initializeWorkspace(current.workspacePath);
        return current;
    }
    const workspacePath = path.join(CONFIG_DIR, "codex-workspaces", normalized);
    const workspace: SiteWorkspaceConfig = { workspacePath };
    requestWorkspaceStates.set(normalized, workspace);
    initializeWorkspace(workspacePath);
    return workspace;
}

/** 更新指定请求工作区的活跃线程，不污染全局站点配置。 */
export function updateRequestWorkspace(config: CanvasAgentConfig, workspaceId: string, patch: Partial<SiteWorkspaceConfig>) {
    const normalized = String(workspaceId || "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(normalized)) return updateSiteWorkspace(config, patch);
    const current = ensureRequestWorkspace(config, normalized);
    const next = { ...current, ...patch, workspacePath: current.workspacePath };
    requestWorkspaceStates.set(normalized, next);
    initializeWorkspace(next.workspacePath);
    return next;
}

/** 更新站点级 Codex 工作空间配置。 */
export function updateSiteWorkspace(config: CanvasAgentConfig, patch: Partial<SiteWorkspaceConfig>) {
    const current = ensureSiteWorkspace(config);
    const workspacePath = patch.workspacePath ? resolveWorkspacePath(patch.workspacePath) : current.workspacePath;
    const next = { ...current, ...patch, workspacePath };
    config.workspace = { workspacePath: next.workspacePath, activeThreadId: next.activeThreadId, pinnedThreadIds: next.pinnedThreadIds };
    initializeWorkspace(workspacePath);
    saveConfig(config);
    return config.workspace;
}

/** 创建工作空间目录并写入默认 AGENTS.md。 */
function initializeWorkspace(workspacePath: string) {
    if (initializedWorkspaces.has(workspacePath)) return;
    fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
    const instructionsFile = path.join(workspacePath, "AGENTS.md");
    const current = fs.existsSync(instructionsFile) ? fs.readFileSync(instructionsFile, "utf8") : "";
    if (!current || current.startsWith("# Infinite Canvas Agent")) fs.writeFileSync(instructionsFile, AGENT_PROMPT);
    initializedWorkspaces.add(workspacePath);
}

/** 将用户输入的工作空间路径解析为绝对路径。 */
function resolveWorkspacePath(value: string) {
    if (value === "~") return os.homedir();
    if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
    return path.resolve(value);
}

/** 从当前包信息中读取 Canvas Agent 版本号。 */
function readPackageVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
        return pkg.version || "0.0.0";
    } catch {
        return "0.0.0";
    }
}
