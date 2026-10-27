import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import express, { type NextFunction, type Request, type Response } from "express";

import { runClaudeTurn } from "../agent/claude.js";
import { fileCenterFor, FILE_LIMITS, FileCenterError } from "../agent/file-center.js";
import { interruptPiTurn, releasePiRuntime, runPiTurn } from "../agent/pi/engine.js";
import { piModelOptions, readPiChannels } from "../agent/pi/model.js";
import { loadPiSkills, PiSkillError, piSkillSummaries, setPiSkillEnabled } from "../agent/pi/skills.js";
import { PiThreadStore, readPiThread } from "../agent/pi/store.js";
import { archiveCodexThread, CodexSkillLookupError, configureCodexSkill, generateCodexSkillDraft, interruptCodexTurn, isRecoverableThreadError, listCodexModels, listCodexSkills, listCodexThreads, readCodexThread, resolveCodexApproval, resolveCodexSkill, resumeCodexThread, runCodexTurn, startCodexThread, summarizeCodexThread } from "../agent/codex.js";
import type { CodexReasoningEffort, CodexSkillSelector } from "../agent/codex-protocol.js";
import { messageMetadataStoreForWorkspace } from "../agent/message-metadata.js";
import type { AgentAttachment, AgentPermissionMode } from "../agent/types.js";
import { AGENT_PROTOCOL_VERSION, CanvasSession } from "../canvas/session.js";
import { DEFAULT_PORT, ensureRequestWorkspace, ensureSiteWorkspace, loadConfig, saveConfig, updateRequestWorkspace, updateSiteWorkspace, type CanvasAgentConfig, type SiteWorkspaceConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { checkVersions } from "../version-check.js";
import { SkillStore, SkillStoreError } from "../skills/store.js";

/** 启动仅监听本机的 Canvas Agent HTTP 服务。 */
export function startHttpServer() {
    const config = loadConfig(true);
    const port = Number(process.env.PORT) || Number(new URL(config.url).port) || DEFAULT_PORT;
    config.url = `http://127.0.0.1:${port}`;
    saveConfig(config);

    const initialWorkspace = ensureSiteWorkspace(config);
    type WorkspaceRuntime = {
        id: string;
        workspace: SiteWorkspaceConfig;
        session: CanvasSession;
        skillStore: SkillStore;
        draftThreadStart: ReturnType<typeof startCodexThread> | null;
        skillDraftRunning: boolean;
        emit: (type: string, payload: unknown) => void;
    };
    const runtimeContext = new AsyncLocalStorage<WorkspaceRuntime>();
    const runtimes = new Map<string, WorkspaceRuntime>();
    let lastActiveWorkspaceId = "";
    const initialRuntime: WorkspaceRuntime = {
        id: "site",
        workspace: initialWorkspace,
        session: new CanvasSession(initialWorkspace.activeThreadId || "", initialWorkspace.engine, initialWorkspace.workspacePath),
        skillStore: new SkillStore(initialWorkspace.workspacePath),
        draftThreadStart: null,
        skillDraftRunning: false,
        emit: () => undefined,
    };
    runtimes.set(initialRuntime.id, initialRuntime);
    const currentRuntime = () => runtimeContext.getStore() || initialRuntime;
    const runtimeForWorkspace = (workspaceId: string, workspace: SiteWorkspaceConfig) => {
        const id = workspaceId || "site";
        const existing = runtimes.get(id);
        if (existing) return existing;
        const runtime: WorkspaceRuntime = {
            id,
            workspace,
            session: new CanvasSession(workspace.engine === "pi" ? workspace.activeThreadId || "" : "", workspace.engine, workspace.workspacePath),
            skillStore: new SkillStore(workspace.workspacePath),
            draftThreadStart: null,
            skillDraftRunning: false,
            emit: () => undefined,
        };
        runtime.emit = createEmitter(runtime);
        runtimes.set(id, runtime);
        return runtime;
    };
    const runtimeForRequest = (req: Request) => {
        const workspaceId = String(req.headers["x-infinite-canvas-workspace"] || req.query.workspaceId || "").trim();
        const explicitId = /^[0-9a-f-]{36}$/i.test(workspaceId) ? workspaceId : "";
        if (explicitId) lastActiveWorkspaceId = explicitId;
        const id = explicitId || lastActiveWorkspaceId || "site";
        const workspace = id === "site" ? ensureSiteWorkspace(config) : ensureRequestWorkspace(config, id);
        logger.debug("Workspace runtime selected", { requestWorkspaceId: explicitId || "", runtimeId: id, workspacePath: workspace.workspacePath });
        return runtimeForWorkspace(id, workspace);
    };
    /** 将 Agent 事件广播到所属线程或全部网页。 */
    const emit = (type: string, payload: unknown) => {
        const runtime = currentRuntime();
        runtime.emit(type, payload);
    };
    /** 创建绑定指定工作区的事件出口，供异步 Codex 回调使用。 */
    const createEmitter = (runtime: WorkspaceRuntime) => (type: string, payload: unknown) => {
        const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : { value: payload };
        if (type === "skills_changed") {
            runtime.session.emitAll(type, value);
            return;
        }
        if (type === "agent_bootstrap" && value.phase === "preheat") {
            if (value.type === "mcp.startup") runtime.session.updateConversationMcp(String(value.name || ""), startupStatus(value.status), String(value.error || "") || null, String(value.failureReason || "") || null);
            if (value.type === "mcp.complete") runtime.session.completeConversationMcpInventory(mcpInventory(value.services));
        }
        const scope = runtime.session.codexBusy ? runtime.session.codexEventScope : { threadId: "", turnId: "", sourceClientId: "" };
        const threadId = String(value.threadId || value.thread_id || scope.threadId || runtime.workspace.activeThreadId || "");
        const turnId = String(value.turnId || value.turn_id || scope.turnId || "");
        const sourceClientId = String(value.sourceClientId || scope.sourceClientId || "");
        const data = {
            ...value,
            ...(threadId ? { threadId, thread_id: threadId } : {}),
            ...(turnId ? { turnId, turn_id: turnId } : {}),
            ...(sourceClientId ? { sourceClientId } : {}),
        };
        runtime.session.trackCodexEvent(type, data);
        threadId ? runtime.session.emitThread(type, threadId, data) : runtime.session.emitAll(type, data);
    };
    runtimes.forEach((runtime) => { runtime.emit = createEmitter(runtime); });
    const session = new Proxy({} as CanvasSession, {
        get(_target, property) {
            const value = Reflect.get(currentRuntime().session, property);
            return typeof value === "function" ? value.bind(currentRuntime().session) : value;
        },
    }) as CanvasSession;
    const skillStore = new Proxy({} as SkillStore, {
        get(_target, property) {
            const value = Reflect.get(currentRuntime().skillStore, property);
            return typeof value === "function" ? value.bind(currentRuntime().skillStore) : value;
        },
    }) as SkillStore;
    /** 保存并广播当前站点工作空间的活跃线程。 */
    const setActiveThread = (activeThreadId: string, payload: Record<string, unknown> = {}, preserveConversation = false) => {
        const runtime = currentRuntime();
        const engine = session.conversationStateSnapshot.engine;
        const patch = { activeThreadId: activeThreadId || undefined, engine, activeThreads: { ...runtime.workspace.activeThreads, [engine]: activeThreadId } };
        const workspace = runtime.id === "site"
            ? updateSiteWorkspace(config, patch)
            : updateRequestWorkspace(config, runtime.id, patch);
        runtime.workspace = workspace;
        if (!preserveConversation) session.activateConversation(activeThreadId, String(payload.sourceClientId || "") || undefined);
        if (!session.codexBusy && session.codexThreadId !== activeThreadId) session.setCodexState({ threadId: activeThreadId, turnId: "" });
        session.emitThread("workspace_changed", activeThreadId, { ...payload, activeThreadId, conversation: session.conversationStateSnapshot });
        return workspace;
    };
    const prepareDraftThread = (clientId: string, permission: AgentPermissionMode, requestWorkspace = ensureSiteWorkspace(config)) => {
        const runtime = currentRuntime();
        if (runtime.draftThreadStart) return runtime.draftThreadStart;
        const workspace = requestWorkspace;
        const workspaceEmit = runtime.emit;
        let prepared!: ReturnType<typeof startCodexThread>;
        prepared = (async () => {
            workspaceEmit("agent_bootstrap", { type: "codex.preparing", sourceClientId: clientId });
            try {
                const thread = await startCodexThread(workspaceEmit, workspace.workspacePath, permission, true);
                if (runtime.draftThreadStart !== prepared) return thread;
                const threadId = String((thread as Record<string, unknown>).id || "");
                if (threadId && !runtime.workspace.activeThreadId) {
                    session.completeConversationPreparation(threadId);
                    setActiveThread(threadId, { emptyThread: true, draftThread: true, sourceClientId: clientId }, true);
                }
                return thread;
            } catch (error) {
                if (runtime.draftThreadStart === prepared) {
                    const text = error instanceof Error ? error.message : String(error);
                    session.failConversationPreparation(text);
                    workspaceEmit("agent_bootstrap", { type: "codex.prepare_failed", sourceClientId: clientId, error: text });
                }
                throw error;
            } finally {
                if (runtime.draftThreadStart === prepared) runtime.draftThreadStart = null;
            }
        })();
        runtime.draftThreadStart = prepared;
        return prepared;
    };
    /** 恢复已有线程并等待完整 MCP 清单，供启动恢复和手动切换共用。 */
    const prepareExistingThread = async (threadId: string, clientId = "", permission: AgentPermissionMode = "request", requestWorkspace = ensureSiteWorkspace(config)) => {
        const runtime = currentRuntime();
        const workspace = requestWorkspace;
        session.beginConversation({ conversationId: threadId, threadId, sourceClientId: clientId || undefined });
        runtime.emit("agent_bootstrap", { type: "codex.preparing", threadId, sourceClientId: clientId || undefined });
        const result = await resumeCodexThread(runtime.emit, threadId, workspace.workspacePath, permission, true);
        session.completeConversationPreparation(threadId);
        return result;
    };
    const failPreparedConversation = (error: unknown, threadId: string, clientId = "") => {
        const runtime = currentRuntime();
        const text = error instanceof Error ? error.message : String(error);
        session.failConversationPreparation(text);
        runtime.emit("agent_bootstrap", { type: "codex.prepare_failed", threadId, sourceClientId: clientId || undefined, error: text });
    };
    const app = express();
    app.disable("x-powered-by");
    const jsonParser = express.json({ limit: "30mb" });
    // 文件上传的请求体是原始字节，不能被 JSON 解析器消费。
    app.use((req, res, next) => (req.method === "POST" && req.path === "/agent/files" ? next() : jsonParser(req, res, next)));
    app.use((req, res, next) => {
        if (!logger.enabled) return next();
        const startedAt = Date.now();
        const url = requestUrl(req, config);
        res.on("finish", () => {
            if (req.method === "OPTIONS" || (res.statusCode < 400 && ["/health", "/canvas/state", "/canvas/activate"].includes(url.pathname))) return;
            logger.debug(`HTTP ${req.method} ${url.pathname}`, { status: res.statusCode, durationMs: Date.now() - startedAt });
        });
        next();
    });
    app.use((req, res, next) => {
        const url = requestUrl(req, config);
        if (!setCors(req, res, url, config)) return void res.status(403).json({ ok: false, error: "origin not allowed" });
        if (req.method === "OPTIONS") return void res.json({});
        next();
    });
    app.get("/health", (_req, res) => res.json(session.health()));
    // This endpoint only exposes non-secret bootstrap metadata. Allow a short
    // browser cache so older clients cannot turn a reconnect loop into a
    // sustained request storm; current clients additionally deduplicate in
    // discoverAgentConfig().
    app.get("/config", (_req, res) => {
        res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
        res.json({ ok: true, protocolVersion: AGENT_PROTOCOL_VERSION, url: config.url, hasToken: true });
    });
    app.use((req, res, next) => {
        if (validToken(req, requestUrl(req, config), config.token)) return next();
        res.status(401).json({ ok: false, error: "invalid token" });
    });
    app.use((req, _res, next) => runtimeContext.run(runtimeForRequest(req), next));
    app.get("/events", (req, res) => {
        const workspace = requestWorkspace(config, req);
        session.openEvents(requestUrl(req, config), res, workspace.activeThreadId || "");
    });
    app.post("/canvas/state", (req, res) => {
        session.updateState(req.body, String(req.query.clientId || "") || undefined);
        res.json({ ok: true });
    });
    app.post("/canvas/activate", (req, res) => {
        session.activateClient(String(req.query.clientId || ""));
        res.json({ ok: true });
    });
    app.post("/canvas/result", (req, res) => {
        const ok = session.resolveResult(String(req.query.clientId || ""), req.body);
        res.status(ok ? 200 : 409).json({ ok });
    });
    app.post("/agent/files", route(async (req, res) => {
        const center = fileCenterFor(currentRuntime().workspace.workspacePath);
        const name = String(req.query.name || "");
        if (!name.trim()) return res.status(400).json({ ok: false, error: "缺少文件名" });
        const declared = Number(req.headers["content-length"] || 0);
        if (declared > FILE_LIMITS.fileBytes) return res.status(413).json({ ok: false, error: `单个文件不能超过 ${Math.round(FILE_LIMITS.fileBytes / 1024 / 1024)} MB` });
        const file = await center.save(req, { name, type: String(req.headers["content-type"] || ""), threadId: String(req.query.threadId || ""), size: declared || undefined });
        logger.info("File uploaded", { fileId: file.fileId, name: file.name, size: file.size });
        res.json({ ok: true, file });
    }));
    app.get("/agent/files/:fileId/content", route(async (req, res) => {
        const center = fileCenterFor(currentRuntime().workspace.workspacePath);
        const { file, data } = await center.read(routeParam(req.params.fileId));
        res.setHeader("Cache-Control", "no-store");
        // 附件类型来自客户端，禁止嗅探并把不确定的类型降级为二进制，避免本机服务被当成页面源。
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.type(safeContentType(file.type)).send(data);
    }));
    app.delete("/agent/files/:fileId", route(async (req, res) => {
        const center = fileCenterFor(currentRuntime().workspace.workspacePath);
        await center.removeFile(routeParam(req.params.fileId));
        res.json({ ok: true });
    }));
    app.get("/agent/attachments/:attachmentId", route(async (req, res) => {
        const attachment = session.getTurnAttachment(String(req.query.clientId || ""), routeParam(req.params.attachmentId));
        const data = attachment.dataUrl.split(",", 2)[1];
        if (!data) throw new Error("图片附件内容无效");
        res.setHeader("Cache-Control", "no-store");
        res.type(attachment.type).send(Buffer.from(data, "base64"));
    }));
    app.get("/agent/message-assets/:messageKey/:assetFile", route(async (req, res) => {
        const asset = await messageMetadataStoreForWorkspace(currentRuntime().workspace.workspacePath).readAsset(routeParam(req.params.messageKey), routeParam(req.params.assetFile));
        if (!asset) return void res.status(404).json({ ok: false, error: "message asset not found" });
        res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
        res.type(asset.contentType).send(asset.data);
    }));
    app.post("/agent/local-file/reveal", route(async (req, res) => {
        const filePath = String(req.body?.path || "");
        if (!path.isAbsolute(filePath)) return res.status(400).json({ ok: false, error: "文件路径必须是绝对路径" });
        const file = await stat(filePath);
        await revealLocalFile(filePath, file.isDirectory());
        res.json({ ok: true });
    }));
    app.post("/agent/local-image", route(async (req, res) => {
        const filePath = String(req.body?.path || "");
        if (!path.isAbsolute(filePath) || !/\.(?:avif|gif|jpe?g|png|webp)$/i.test(filePath)) return res.status(400).json({ ok: false, error: "图片路径无效" });
        const file = await stat(filePath);
        if (!file.isFile()) return res.status(400).json({ ok: false, error: "图片文件无效" });
        res.setHeader("Cache-Control", "no-store");
        res.type(path.extname(filePath)).send(await readFile(filePath));
    }));
    app.post("/api/tools", route(async (req, res) => res.json({ ok: true, result: await session.callTool(req.body?.name, req.body?.input || {}) })));
    app.get("/agent/codex/workspace", (_req, res) => {
        const workspace = requestWorkspace(config, _req);
        res.json({ ok: true, workspace, conversation: session.conversationStateSnapshot });
    });
    app.get("/agent/codex/models", route(async (req, res) => {
        const workspace = requestWorkspace(config, req);
        res.json({ ok: true, ...(await listCodexModels(emit, workspace.workspacePath)) });
    }));
    app.get("/agent/codex/skills", route(async (req, res) => {
        const workspace = requestWorkspace(config, req);
        const result = await listCodexSkills(emit, workspace.workspacePath, String(req.query.forceReload || "") === "1");
        res.json({ ok: true, data: result.skills.map((skill) => ({ ...skill, managed: skillStore.isManagedPath(skill.path) })), errors: result.errors });
    }));
    app.post("/agent/codex/skills/draft", codexMutation(async (req, res) => {
        const workspace = requestWorkspace(config, req);
        const source = String(req.body?.source || "");
        if (source !== "conversation" && source !== "canvas") return res.status(400).json({ ok: false, error: "Skill 草稿来源无效" });
        const clientId = String(req.body?.clientId || "");
        if (!clientId || !session.hasClient(clientId)) return res.status(409).json({ ok: false, error: "发起提炼的网页已断开，请重新连接后再试" });
        const model = String(req.body?.model || "") || undefined;
        const effort = reasoningEffort(req.body?.effort);
        const previousCodexState = session.codexStateSnapshot;
        currentRuntime().skillDraftRunning = true;
        try {
            if (source === "conversation") {
                const threadId = String(req.body?.threadId || "");
                if (!threadId) return res.status(409).json({ ok: false, error: "当前没有可提炼的对话" });
                if (threadId !== (workspace.activeThreadId || "")) return res.status(409).json({ ok: false, error: "当前对话已在其他页面切换，请同步后重试" });
                const history = await readCodexThread(emit, threadId, workspace.workspacePath);
                if (!history.messages.some((message) => message.role === "user" && message.turnId)) return res.status(409).json({ ok: false, error: "当前对话还没有可提炼的已完成内容" });
                session.setCodexState({ busy: true, threadId, turnId: "" }, { preserveReplay: true });
                const data = await generateCodexSkillDraft(emit, workspace.workspacePath, { source, threadId, model, effort });
                if (!session.hasClient(clientId)) return res.status(409).json({ ok: false, error: "发起提炼的网页已断开，请重新连接后再试" });
                return res.json({ ok: true, data });
            }
            const snapshot = session.canvasStateForClient(clientId);
            if (!snapshot || (snapshot as Record<string, unknown>).hasCanvas === false) return res.status(409).json({ ok: false, error: "当前页面没有可提炼的画布" });
            session.setCodexState({ busy: true, threadId: workspace.activeThreadId || "", turnId: "" }, { preserveReplay: true });
            const data = await generateCodexSkillDraft(emit, workspace.workspacePath, { source, snapshot, model, effort });
            if (!session.hasClient(clientId)) return res.status(409).json({ ok: false, error: "发起提炼的网页已断开，请重新连接后再试" });
            return res.json({ ok: true, data });
        } finally {
            currentRuntime().skillDraftRunning = false;
            session.setCodexState(previousCodexState, { preserveReplay: true });
        }
    }));
    app.get("/agent/codex/skills/:name", route(async (req, res) => {
        res.json({ ok: true, data: await skillStore.get(routeParam(req.params.name)) });
    }));
    app.post("/agent/codex/skills", codexMutation(async (req, res) => {
        const data = await skillStore.create(req.body);
        session.emitAll("skills_changed", { forceReload: true });
        res.status(201).json({ ok: true, data });
    }));
    app.post("/agent/codex/skills/:name/enabled", codexMutation(async (req, res) => {
        if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ ok: false, error: "Skill 启用状态无效" });
        const workspace = requestWorkspace(config, req);
        const selector = skillSelector(req.body);
        if (selector.name !== routeParam(req.params.name)) return res.status(400).json({ ok: false, error: "Skill 选择无效" });
        const data = await configureCodexSkill(emit, workspace.workspacePath, selector, req.body.enabled);
        session.emitAll("skills_changed", { forceReload: true });
        res.json({ ok: true, data });
    }));
    app.post("/agent/codex/skills/:name/delete", codexMutation(async (req, res) => {
        await skillStore.delete(routeParam(req.params.name), String(req.body?.expectedRevision || ""));
        session.emitAll("skills_changed", { forceReload: true });
        res.json({ ok: true });
    }));
    app.post("/agent/codex/skills/:name", codexMutation(async (req, res) => {
        const data = await skillStore.update(routeParam(req.params.name), req.body);
        session.emitAll("skills_changed", { forceReload: true });
        res.json({ ok: true, data });
    }));
    app.get("/agent/codex/threads", route(async (req, res) => {
        const workspace = requestWorkspace(config, req);
        const result = await listCodexThreads(emit, { cwd: workspace.workspacePath, searchTerm: String(req.query.searchTerm || "") });
        res.json({ ok: true, workspace, conversation: session.conversationStateSnapshot, ...result });
    }));
    app.post("/agent/:engine/prepare", codexMutation(async (req, res) => {
        const engine = routeParam(req.params.engine);
        if (engine !== "codex" && engine !== "pi") return res.status(400).json({ ok: false, error: "不支持的引擎" });
        const workspace = requestWorkspace(config, req);
        const clientId = String(req.body?.clientId || "");
        const current = session.conversationStateSnapshot;
        if (current.engine === engine && current.threadId && ["ready", "warning", "running"].includes(current.status)) {
            return res.json({ ok: true, workspace, conversation: current });
        }
        const threadId = workspace.activeThreads?.[engine] || "";
        session.beginConversation({ engine, threadId, sourceClientId: clientId });
        try {
            if (engine === "pi") {
                const store = new PiThreadStore(workspace.workspacePath);
                const thread = threadId ? await store.read(threadId) : await store.create();
                if (!thread) throw new Error("找不到该 Pi 会话，请新建会话");
                session.completePiConversation(thread.id);
                setActiveThread(thread.id, { sourceClientId: clientId }, true);
            } else if (threadId) {
                try {
                    await prepareExistingThread(threadId, clientId, permissionMode(req.body?.permissionMode), workspace);
                    setActiveThread(threadId, { sourceClientId: clientId }, true);
                } catch (error) {
                    if (!isRecoverableThreadError(error)) throw error;
                    session.beginConversation({ sourceClientId: clientId });
                    setActiveThread("", { draftThread: true, sourceClientId: clientId }, true);
                    await prepareDraftThread(clientId, permissionMode(req.body?.permissionMode), workspace);
                }
            } else {
                setActiveThread("", { draftThread: true, sourceClientId: clientId }, true);
                await prepareDraftThread(clientId, permissionMode(req.body?.permissionMode), workspace);
            }
            res.json({ ok: true, workspace: requestWorkspace(config, req), conversation: session.conversationStateSnapshot });
        } catch (error) {
            failPreparedConversation(error, threadId, clientId);
            throw error;
        }
    }));
    app.post("/agent/codex/threads/new", codexMutation(async (req, res) => {
        const clientId = String(req.body?.clientId || "");
        session.beginConversation({ sourceClientId: clientId });
        setActiveThread("", { emptyThread: true, draftThread: true, sourceClientId: clientId }, true);
        const thread = await prepareDraftThread(clientId, permissionMode(req.body?.permissionMode), requestWorkspace(config, req));
        res.json({ ok: true, workspace: requestWorkspace(config, req), conversation: session.conversationStateSnapshot, thread: summarizeCodexThread(thread), messages: [] });
    }));
    app.post("/agent/codex/threads/reset", codexMutation(async (req, res) => {
        const clientId = String(req.body?.clientId || "");
        session.beginConversation({ sourceClientId: clientId });
        setActiveThread("", { emptyThread: true, draftThread: true, sourceClientId: clientId }, true);
        await prepareDraftThread(clientId, permissionMode(req.body?.permissionMode), requestWorkspace(config, req));
        res.json({ ok: true, workspace: requestWorkspace(config, req), conversation: session.conversationStateSnapshot });
    }));
    app.get("/agent/codex/threads/:threadId", route(async (req, res) => {
        const workspace = requestWorkspace(config, req);
        const threadId = routeParam(req.params.threadId);
        res.json({ ok: true, workspace, conversation: session.conversationStateSnapshot, ...(await readCodexThread(emit, threadId, workspace.workspacePath)) });
    }));
    app.post("/agent/codex/history/ack", (req, res) => {
        const threadId = String(req.body?.threadId || "");
        const turnIds = Array.isArray(req.body?.turnIds) ? req.body.turnIds.map(String) : [];
        session.acknowledgeCodexHistory(threadId, turnIds);
        res.json({ ok: true });
    });
    app.post("/agent/codex/threads/:threadId/resume", codexMutation(async (req, res) => {
        const threadId = routeParam(req.params.threadId);
        const clientId = String(req.body?.clientId || "");
        try {
            const result = await prepareExistingThread(threadId, clientId, permissionMode(req.body?.permissionMode), requestWorkspace(config, req));
            const nextWorkspace = setActiveThread(threadId, { sourceClientId: clientId }, true);
            res.json({ ok: true, workspace: nextWorkspace, conversation: session.conversationStateSnapshot, ...result });
        } catch (error) {
            failPreparedConversation(error, threadId, clientId);
            throw error;
        }
    }));
    app.post("/agent/codex/threads/:threadId/delete", codexMutation(async (req, res) => {
        const workspace = requestWorkspace(config, req);
        const threadId = routeParam(req.params.threadId);
        await archiveCodexThread(emit, threadId, workspace.workspacePath);
        await fileCenterFor(workspace.workspacePath).removeThread(threadId);
        const nextWorkspace = setActiveThread(workspace.activeThreadId === threadId ? "" : workspace.activeThreadId || "", { sourceClientId: String(req.body?.clientId || "") });
        res.json({ ok: true, workspace: nextWorkspace, conversation: session.conversationStateSnapshot });
    }));
    app.get("/agent/pi/models", route(async (_req, res) => {
        res.json({ ok: true, data: piModelOptions(await readPiChannels(true)) });
    }));
    app.get("/agent/pi/skills", route(async (req, res) => {
        const workspace = requestWorkspace(config, req);
        const result = await loadPiSkills(workspace.workspacePath);
        res.json({ ok: true, data: piSkillSummaries(result.skills), errors: result.errors });
    }));
    app.post("/agent/pi/skills/:name/enabled", piMutation(async (req, res) => {
        if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ ok: false, error: "Skill 启用状态无效" });
        const workspace = requestWorkspace(config, req);
        const data = await setPiSkillEnabled(workspace.workspacePath, routeParam(req.params.name), req.body.enabled);
        res.json({ ok: true, data });
    }));
    app.get("/agent/pi/threads", route(async (req, res) => {
        const workspace = requestWorkspace(config, req);
        res.json({ ok: true, workspace, conversation: session.conversationStateSnapshot, data: await new PiThreadStore(workspace.workspacePath).list() });
    }));
    app.get("/agent/pi/threads/:threadId", route(async (req, res) => {
        const workspace = requestWorkspace(config, req);
        const detail = await readPiThread(workspace.workspacePath, routeParam(req.params.threadId));
        if (!detail) return res.status(404).json({ ok: false, error: "找不到该 Pi 会话" });
        res.json({ ok: true, workspace, conversation: session.conversationStateSnapshot, ...detail });
    }));
    app.post("/agent/pi/threads/new", piMutation(async (req, res) => {
        const workspace = requestWorkspace(config, req);
        const clientId = String(req.body?.clientId || "");
        session.bindClient(clientId);
        const thread = await new PiThreadStore(workspace.workspacePath).create();
        session.completePiConversation(thread.id);
        setActiveThread(thread.id, { emptyThread: true, sourceClientId: clientId }, true);
        res.json({ ok: true, workspace: requestWorkspace(config, req), conversation: session.conversationStateSnapshot, thread: { id: thread.id, preview: "", name: null, cwd: workspace.workspacePath, status: "idle", createdAt: thread.createdAt, updatedAt: thread.updatedAt }, messages: [] });
    }));
    app.post("/agent/pi/threads/:threadId/resume", piMutation(async (req, res) => {
        const workspace = requestWorkspace(config, req);
        const threadId = routeParam(req.params.threadId);
        const clientId = String(req.body?.clientId || "");
        const detail = await readPiThread(workspace.workspacePath, threadId);
        if (!detail) return res.status(404).json({ ok: false, error: "找不到该 Pi 会话" });
        session.bindClient(clientId);
        session.completePiConversation(threadId);
        setActiveThread(threadId, { sourceClientId: clientId }, true);
        res.json({ ok: true, workspace: requestWorkspace(config, req), conversation: session.conversationStateSnapshot, ...detail });
    }));
    app.post("/agent/pi/threads/:threadId/delete", piMutation(async (req, res) => {
        const workspace = requestWorkspace(config, req);
        const threadId = routeParam(req.params.threadId);
        await new PiThreadStore(workspace.workspacePath).remove(threadId);
        releasePiRuntime(workspace.workspacePath, threadId);
        await fileCenterFor(workspace.workspacePath).removeThread(threadId);
        const nextWorkspace = setActiveThread(workspace.activeThreadId === threadId ? "" : workspace.activeThreadId || "", { sourceClientId: String(req.body?.clientId || "") });
        if (!nextWorkspace.activeThreadId) session.completePiConversation("");
        res.json({ ok: true, workspace: nextWorkspace, conversation: session.conversationStateSnapshot });
    }));
    app.post("/agent/pi/turn", piMutation(async (req, res) => {
        const attachments = Array.isArray(req.body?.attachments) ? (req.body.attachments as AgentAttachment[]) : [];
        const workspace = requestWorkspace(config, req);
        const prompt = String(req.body?.prompt || "");
        if (!prompt.trim()) return res.status(400).json({ ok: false, error: "请输入任务内容" });
        const clientId = String(req.body?.clientId || "");
        if (!clientId || !session.hasClient(clientId)) return res.status(409).json({ ok: false, error: "发起任务的网页已断开，请重新连接后再试" });
        const requestedThreadId = String(req.body?.threadId || "");
        const activeThreadId = workspace.activeThreadId || "";
        const conversation = session.conversationStateSnapshot;
        if (conversation.engine !== "pi" || requestedThreadId !== activeThreadId || conversation.threadId !== activeThreadId) {
            return res.status(409).json({ ok: false, code: "CONVERSATION_STALE", error: "当前会话已切换，已同步最新状态，请确认后重试", state: conversation });
        }
        if (!activeThreadId || !["ready", "warning"].includes(conversation.status)) {
            return res.status(409).json({ ok: false, code: "CONVERSATION_NOT_READY", error: "Pi 对话仍在初始化，请稍后再试", state: conversation });
        }
        if (attachments.some((item) => item.fileId)) return res.status(400).json({ ok: false, error: "Pi 引擎不支持文件附件，请切换到 Codex 后发送" });
        const messageId = String(req.body?.messageId || Date.now());
        const messageText = String(req.body?.messageText || prompt || `发送了 ${attachments.length} 张图片`);
        const messageMetadata = await messageMetadataStoreForWorkspace(workspace.workspacePath).recordPending(messageId, req.body?.messageMetadata);
        logger.info("Pi turn accepted", { threadId: activeThreadId, model: req.body?.model || "default", promptLength: prompt.length, attachmentCount: attachments.length });
        // Pi 工具仍然回浏览器执行，因此和 Codex 一样把整轮绑定到发起页面。
        session.bindClient(clientId);
        session.markConversationRunning(activeThreadId);
        session.setCodexState({ busy: true, threadId: activeThreadId, turnId: "" });
        try {
            const attachmentRefs = session.setTurnAttachments(clientId, attachments);
            session.emitThread("chat_message", activeThreadId, {
                sourceClientId: clientId,
                message: { id: `${activeThreadId}:pending:synthetic:user`, itemId: "synthetic:user", clientMessageId: messageId, threadId: activeThreadId, turnId: "", role: "user", text: messageText, ...messageMetadata },
            });
            let turnId = "";
            const lifecycleEmit = (type: string, payload: unknown) => {
                const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : { value: payload };
                const eventThreadId = String(value.threadId || value.thread_id || activeThreadId);
                const eventTurnId = String(value.turnId || value.turn_id || turnId);
                session.emitThread(type, eventThreadId, {
                    ...value,
                    threadId: eventThreadId,
                    thread_id: eventThreadId,
                    ...(eventTurnId ? { turnId: eventTurnId, turn_id: eventTurnId } : {}),
                    sourceClientId: clientId,
                });
            };
            void runPiTurn(withAttachmentContext(prompt, attachmentRefs), lifecycleEmit, attachments, {
                threadId: activeThreadId,
                cwd: workspace.workspacePath,
                session,
                model: String(req.body?.model || "") || undefined,
                effort: reasoningEffort(req.body?.effort),
                ...(req.body?.skill ? { skill: req.body.skill as { name?: unknown; path?: unknown } } : {}),
                messageText,
                onStart: () => session.bindClient(clientId),
                onThread: (actualThreadId) => {
                    session.markConversationRunning(actualThreadId);
                    session.setCodexState({ busy: true, threadId: actualThreadId, turnId: "" });
                },
                onTurn: (actualTurnId) => {
                    turnId = actualTurnId;
                    session.emitThread("chat_message", activeThreadId, {
                        turnId,
                        sourceClientId: clientId,
                        message: { id: `${activeThreadId}:${turnId}:synthetic:user`, itemId: "synthetic:user", clientMessageId: messageId, threadId: activeThreadId, turnId, role: "user", text: messageText, ...messageMetadata },
                    });
                    void messageMetadataStoreForWorkspace(workspace.workspacePath).bindTurn(messageId, activeThreadId, turnId).catch((error) => logger.warn("Failed to bind pi message metadata to turn", { clientMessageId: messageId, threadId: activeThreadId, turnId, error }));
                    session.setCodexState({ busy: true, threadId: activeThreadId, turnId });
                },
                onFinish: () => {
                    session.clearTurnAttachments(clientId);
                    if (clientId) session.releaseClient(clientId);
                    session.setCodexState({ busy: false, threadId: activeThreadId, turnId });
                    session.finishConversationRun(activeThreadId);
                },
            });
            res.json({ ok: true, threadId: activeThreadId });
        } catch (error) {
            await messageMetadataStoreForWorkspace(workspace.workspacePath).remove(messageId, activeThreadId).catch(() => undefined);
            session.releaseClient(clientId);
            session.setCodexState({ busy: false, threadId: activeThreadId, turnId: "" });
            session.finishConversationRun(activeThreadId);
            throw error;
        }
    }));
    app.post("/agent/pi/interrupt", route(async (req, res) => {
        const ok = interruptPiTurn(requestWorkspace(config, req).workspacePath);
        res.status(ok ? 200 : 409).json({ ok, ...(ok ? {} : { error: "当前没有可停止的任务" }) });
    }));
    app.post("/agent/codex/turn", codexMutation(async (req, res) => {
        const attachments = Array.isArray(req.body?.attachments) ? (req.body.attachments as AgentAttachment[]) : [];
        const workspace = requestWorkspace(config, req);
        const prompt = String(req.body?.prompt || "");
        if (!prompt.trim()) return res.status(400).json({ ok: false, error: "请输入任务内容" });
        const clientId = String(req.body?.clientId || "");
        if (!clientId || !session.hasClient(clientId)) return res.status(409).json({ ok: false, error: "发起任务的网页已断开，请重新连接后再试" });
        const requestedThreadId = String(req.body?.threadId || "");
        const activeThreadId = workspace.activeThreadId || "";
        const conversation = session.conversationStateSnapshot;
        const requestedConversationId = String(req.body?.conversationId || "");
        const expectedRevision = Number(req.body?.expectedRevision || 0);
        if (conversation.engine !== "codex" || requestedThreadId !== activeThreadId || conversation.threadId !== activeThreadId || (requestedConversationId && requestedConversationId !== conversation.conversationId) || (expectedRevision && expectedRevision !== conversation.revision)) {
            return res.status(409).json({ ok: false, code: "CONVERSATION_STALE", error: "当前会话已切换，已同步最新状态，请确认后重试", state: conversation });
        }
        if (!activeThreadId || !["ready", "warning"].includes(conversation.status)) {
            return res.status(409).json({ ok: false, code: "CONVERSATION_NOT_READY", error: "Codex 对话仍在初始化，请等待 MCP 加载完成", state: conversation });
        }
        const model = String(req.body?.model || "") || undefined;
        const effort = reasoningEffort(req.body?.effort);
        const skill = req.body?.skill === undefined ? undefined : await resolveCodexSkill(emit, workspace.workspacePath, skillSelector(req.body.skill), true);
        const messageId = String(req.body?.messageId || Date.now());
        const messageText = String(req.body?.messageText || prompt || `发送了 ${attachments.length} 张图片`);
        // 先绑定本轮文件再记录元数据：绑定失败时直接拒绝，不留下指向失效文件的记录。
        const fileRefs = await fileCenterFor(workspace.workspacePath).bind(attachments.flatMap((item) => (item.fileId ? [item.fileId] : [])), activeThreadId);
        const messageMetadata = await messageMetadataStoreForWorkspace(workspace.workspacePath).recordPending(messageId, req.body?.messageMetadata);
        let threadId = activeThreadId;
        logger.info("Codex turn accepted", { threadId: req.body?.threadId, model: model || "default", reasoningEffort: effort || "default", promptLength: prompt.length, attachmentCount: attachments.length, fileCount: fileRefs.length });
        session.bindClient(clientId);
        session.markConversationRunning(threadId);
        session.setCodexState({ busy: true, threadId, turnId: "" });
        try {
            let turnId = "";
            const attachmentRefs = session.setTurnAttachments(clientId, attachments);
            session.emitThread("chat_message", threadId, {
                sourceClientId: clientId,
                message: { id: `${threadId}:pending:synthetic:user`, itemId: "synthetic:user", clientMessageId: messageId, threadId, turnId: "", role: "user", text: messageText, ...messageMetadata },
            });
            let chatTurnId = "";
            /** 将包装层日志和兜底错误固定广播到当前 turn。 */
            const lifecycleEmit = (type: string, payload: unknown) => {
                const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : { value: payload };
                const eventThreadId = String(value.threadId || value.thread_id || threadId);
                const eventTurnId = String(value.turnId || value.turn_id || turnId);
                const sourceClientId = String(value.sourceClientId || clientId);
                session.emitThread(type, eventThreadId, {
                    ...value,
                    threadId: eventThreadId,
                    thread_id: eventThreadId,
                    ...(eventTurnId ? { turnId: eventTurnId, turn_id: eventTurnId } : {}),
                    ...(sourceClientId ? { sourceClientId } : {}),
                });
            };
            void runCodexTurn(withAttachmentContext(prompt, attachmentRefs, fileRefs), lifecycleEmit, attachments, {
                threadId,
                cwd: workspace.workspacePath,
                permissionMode: permissionMode(req.body?.permissionMode),
                model,
                effort,
                ...(skill ? { skill: { name: skill.name, path: skill.path } } : {}),
                messageText,
                appEmit: emit,
                onStart: () => session.bindClient(clientId),
                onThread: (actualThreadId) => {
                    const threadChanged = actualThreadId !== threadId;
                    void messageMetadataStoreForWorkspace(workspace.workspacePath).bindThread(messageId, actualThreadId).catch((error) => logger.warn("Failed to bind message metadata to thread", { clientMessageId: messageId, threadId: actualThreadId, error }));
                    if (actualThreadId !== threadId) {
                        threadId = actualThreadId;
                        setActiveThread(threadId, { emptyThread: true, sourceClientId: clientId });
                    }
                    session.markConversationRunning(threadId);
                    session.setCodexState({ busy: true, threadId, turnId: "" });
                    if (threadChanged) {
                        session.emitThread("chat_message", threadId, {
                            sourceClientId: clientId,
                            message: { id: `${threadId}:pending:synthetic:user`, itemId: "synthetic:user", clientMessageId: messageId, threadId, turnId: "", role: "user", text: messageText, ...messageMetadata },
                        });
                    }
                },
                onTurn: (actualTurnId) => {
                    turnId = actualTurnId;
                    void messageMetadataStoreForWorkspace(workspace.workspacePath).bindTurn(messageId, threadId, turnId).catch((error) => logger.warn("Failed to bind message metadata to turn", { clientMessageId: messageId, threadId, turnId, error }));
                    if (chatTurnId !== turnId) {
                        chatTurnId = turnId;
                        session.emitThread("chat_message", threadId, {
                            turnId,
                            sourceClientId: clientId,
                            message: { id: `${threadId}:${turnId}:synthetic:user`, itemId: "synthetic:user", clientMessageId: messageId, threadId, turnId, role: "user", text: messageText, ...messageMetadata },
                        });
                    }
                    logger.info("Codex turn started", { threadId, turnId, model: model || "default", reasoningEffort: effort || "default" });
                    session.setCodexState({ busy: true, threadId, turnId });
                },
                onFinish: () => {
                    logger.info("Codex turn finished", { threadId, turnId });
                    if (!turnId) void messageMetadataStoreForWorkspace(workspace.workspacePath).remove(messageId, threadId).catch((error) => logger.warn("Failed to remove unbound message metadata", { clientMessageId: messageId, error }));
                    session.clearTurnAttachments(clientId);
                    if (clientId) session.releaseClient(clientId);
                    session.setCodexState({ busy: false, threadId, turnId });
                    session.finishConversationRun(threadId);
                },
            });
            res.json({ ok: true, threadId });
        } catch (error) {
            await messageMetadataStoreForWorkspace(workspace.workspacePath).remove(messageId, threadId).catch((metadataError) => logger.warn("Failed to remove rejected message metadata", { clientMessageId: messageId, error: metadataError }));
            session.releaseClient(clientId);
            session.setCodexState({ busy: false, threadId, turnId: "" });
            session.finishConversationRun(threadId);
            throw error;
        }
    }));

    /** 将 Codex 写操作串行化，避免多窗口在异步请求期间交叉修改会话。 */
    function codexMutation(handler: (req: Request, res: Response) => unknown | Promise<unknown>) {
        return route(async (req, res) => {
            if (!session.beginCodexMutation()) return res.status(409).json({ ok: false, code: "CONVERSATION_BUSY", error: "Codex 正在运行或正在切换会话，请稍后重试", state: session.conversationStateSnapshot });
            try {
                return await handler(req, res);
            } finally {
                session.endCodexMutation();
            }
        });
    }
    /** Pi 引擎与 Codex 共用同一把会话互斥锁，避免两个引擎同时切换线程。 */
    function piMutation(handler: (req: Request, res: Response) => unknown | Promise<unknown>) {
        return route(async (req, res) => {
            if (!session.beginCodexMutation()) return res.status(409).json({ ok: false, code: "CONVERSATION_BUSY", error: "Agent 正在运行或正在切换会话，请稍后重试", state: session.conversationStateSnapshot });
            try {
                return await handler(req, res);
            } finally {
                session.endCodexMutation();
            }
        });
    }
    app.post("/agent/codex/approval", route(async (req, res) => {
        const decision = String(req.body?.decision || "");
        if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision)) return res.status(400).json({ ok: false, error: "无效的审批决定" });
        const ok = await resolveCodexApproval(String(req.body?.requestId || ""), decision, currentRuntime().workspace.workspacePath);
        res.status(ok ? 200 : 409).json({ ok, ...(ok ? {} : { error: "审批请求已失效" }) });
    }));
    app.post("/agent/codex/interrupt", route(async (req, res) => {
        const ok = await interruptCodexTurn(currentRuntime().skillDraftRunning ? undefined : String(req.body?.threadId || ""));
        res.status(ok ? 200 : 409).json({ ok, ...(ok ? {} : { error: "当前没有可停止的任务" }) });
    }));
    app.post("/agent/claude/turn", (req, res) => {
        runClaudeTurn(String(req.body?.prompt || ""), emit);
        res.json({ ok: true });
    });
    app.use((_req, res) => res.status(404).json({ ok: false, error: "not found" }));
    app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
        logger.error("HTTP request failed", { method: req.method, path: req.path, error });
        if (error instanceof FileCenterError) return void res.status(error.statusCode).json({ ok: false, error: error.message });
        if (error instanceof SkillStoreError || error instanceof CodexSkillLookupError || error instanceof PiSkillError) return void res.status(error.statusCode).json({ ok: false, error: error.message });
        res.status(500).json({ ok: false, error: error.message });
    });

    app.listen(port, "127.0.0.1", () => {
        console.log("Infinite Canvas Agent");
        checkVersions();
        console.log(`Local URL: ${config.url}`);
        console.log(`Connect token: ${config.token}`);
        console.log("Codex MCP is not installed by this command.");
        console.log("Optional MCP add: codex mcp add infinite-canvas -- npx -y @basketikun/canvas-agent@latest mcp");
        console.log("Remove manually added MCP: codex mcp remove infinite-canvas");
        if (logger.enabled) console.log(`Debug log: ${logger.filePath}`);
        logger.info("Canvas Agent started", { url: config.url, workspace: ensureSiteWorkspace(config).workspacePath, debugLog: logger.filePath });
        const activeThreadId = initialWorkspace.activeThreadId || "";
        if (activeThreadId && initialWorkspace.engine !== "pi" && session.beginCodexMutation()) {
            void prepareExistingThread(activeThreadId).catch(async (error) => {
                if (!isRecoverableThreadError(error)) return failPreparedConversation(error, activeThreadId);
                session.beginConversation();
                setActiveThread("", { emptyThread: true, draftThread: true }, true);
                await prepareDraftThread("", "request");
            }).finally(() => session.endCodexMutation()).catch(() => undefined);
        }
    });
}

/** 将异步 Express 路由异常交给统一错误处理中间件。 */
function route(handler: (req: Request, res: Response) => Promise<unknown>) {
    return (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next);
}

/** 从 Express 路由参数中读取单个字符串。 */
function routeParam(value: string | string[]) {
    return Array.isArray(value) ? value[0] || "" : value;
}

function permissionMode(value: unknown): AgentPermissionMode {
    return value === "automatic" || value === "full" ? value : "request";
}

function reasoningEffort(value: unknown): CodexReasoningEffort | undefined {
    return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "ultra" ? value : undefined;
}

function startupStatus(value: unknown): "starting" | "ready" | "failed" | "cancelled" {
    return value === "starting" || value === "ready" || value === "failed" ? value : "cancelled";
}

function mcpInventory(value: unknown) {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const server = item as Record<string, unknown>;
        const name = String(server.name || "");
        return name ? [{ name, authStatus: String(server.authStatus || "") || undefined }] : [];
    });
}

/** 读取浏览器提交的 Skill 选择器；真实路径随后必须通过原生列表校验。 */
function skillSelector(value: unknown): CodexSkillSelector {
    const selector = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const name = typeof selector.name === "string" ? selector.name : "";
    const skillPath = typeof selector.path === "string" ? selector.path : "";
    if (!name || !skillPath) throw new CodexSkillLookupError("Skill 选择无效", 400);
    return { name, path: skillPath };
}

/** 使用当前操作系统的文件管理器定位本地文件。 */
function revealLocalFile(filePath: string, isDirectory: boolean) {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
    const args = process.platform === "darwin"
        ? ["-R", filePath]
        : process.platform === "win32"
            ? [isDirectory ? filePath : `/select,${filePath}`]
            : [isDirectory ? filePath : path.dirname(filePath)];
    return new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { detached: true, stdio: "ignore" });
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
        child.once("error", reject);
    });
}

/** 结合服务配置解析当前请求 URL。 */
function requestUrl(req: Request, config: CanvasAgentConfig) {
    return new URL(req.originalUrl || req.url || "/", config.url);
}

function requestWorkspace(config: CanvasAgentConfig, req: Request) {
    const workspaceId = String(req.headers["x-infinite-canvas-workspace"] || req.query.workspaceId || "");
    return ensureRequestWorkspace(config, workspaceId);
}

/** 设置跨域响应头并记录通过 token 授权的来源。 */
function setCors(req: Request, res: Response, url: URL, config: CanvasAgentConfig) {
    const origin = req.headers.origin;
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type,x-canvas-agent-token");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    if (!origin || req.method === "OPTIONS" || url.pathname === "/health" || url.pathname === "/config") return true;
    config.origins ||= [];
    if (validToken(req, url, config.token) && !config.origins.includes(origin)) {
        config.origins.push(origin);
        saveConfig(config);
    }
    res.setHeader("Vary", "Origin");
    return config.origins.includes(origin);
}

/** 校验请求查询参数或请求头中的连接 token。 */
function validToken(req: Request, url: URL, token: string) {
    const header = req.headers["x-canvas-agent-token"];
    return url.searchParams.get("token") === token || header === token || (Array.isArray(header) && header.includes(token));
}

/** 向 Agent 提示词追加本轮图片附件与工作区文件清单。 */
function withAttachmentContext(prompt: string, attachments: Array<{ id: string; name: string }>, files: Array<{ fileId: string; name: string; type: string; size: number; path: string }> = []) {
    if (!attachments.length && !files.length) return prompt;
    const sections = [prompt];
    if (attachments.length) {
        const list = attachments.map((item, index) => `${index + 1}. attachmentId=${item.id}, name=${JSON.stringify(item.name)}`).join("\n");
        sections.push(`本轮可用图片附件（顺序与图片输入一致）：\n${list}\n需要把附件放入画布或作为生成参考图时，先调用 canvas_create_attachment_nodes，再使用返回的画布节点 ID 创建生成流程。`);
    }
    if (files.length) {
        const list = files.map((item, index) => `${index + 1}. fileId=${item.fileId}, name=${JSON.stringify(item.name)}, type=${item.type}, size=${formatFileSize(item.size)}\n   path=${item.path}`).join("\n");
        sections.push(`本轮文件附件（已保存在当前工作区，可直接用读取工具或 shell 打开上面的绝对路径）：\n${list}\n需要把结果交回画布时调用 canvas_import_artifact，path 使用工作区内的绝对路径；不要凭文件名猜测内容。`);
    }
    return sections.join("\n\n");
}

/** 将字节数格式化为模型可读的大小。 */
function formatFileSize(bytes: number) {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.ceil(bytes / 1024))}KB`;
}

/** 只接受 MIME 形式的类型，其余按二进制返回，避免把客户端输入当成页面类型。 */
function safeContentType(value: string) {
    return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value) ? value : "application/octet-stream";
}
