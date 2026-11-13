import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import i18n from "@/i18n";
import { getActiveWorkspace } from "@/lib/workspace";
import { useAgentStore, type AgentCanvasTurnScope } from "@/stores/use-agent-store";
import { autoLayoutCanvasChanges } from "@/lib/canvas/canvas-auto-layout";
import { applyCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { focusViewportForNode, nodeBounds } from "@/lib/canvas/canvas-node-geometry";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import type { CanvasConnection, CanvasNodeData, ContextMenuState, ViewportTransform } from "@/types/canvas";
import type { TemplateCanvasContext } from "@/lib/agent/agent-template-tools";

type GenerateNodeRef = MutableRefObject<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, requestId?: string, onCreatedNodes?: (ids: string[]) => void) => Promise<void>) | null>;

type AgentBridgeParams = {
    templateCanvasRef: MutableRefObject<TemplateCanvasContext | null>;
    projectId: string;
    title: string | undefined;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selectedNodeIds: Set<string>;
    viewport: ViewportTransform;
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    connectionsRef: MutableRefObject<CanvasConnection[]>;
    selectedNodeIdsRef: MutableRefObject<Set<string>>;
    viewportRef: MutableRefObject<ViewportTransform>;
    sizeRef: MutableRefObject<{ width: number; height: number }>;
    generateNodeRef: GenerateNodeRef;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    setSelectedConnectionId: Dispatch<SetStateAction<string | null>>;
    setViewport: Dispatch<SetStateAction<ViewportTransform>>;
    setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
};

/**
 * Bridge between the canvas and local Agent: publish the current snapshot and apply/undo capabilities
 * to the Agent store for the local Codex panel. All members except applyAgentOps are internal.
 */
export function useAgentBridge(params: AgentBridgeParams) {
    const { projectId, title, nodes, connections, selectedNodeIds, viewport, nodesRef, connectionsRef, selectedNodeIdsRef, viewportRef, sizeRef, generateNodeRef, setNodes, setConnections, setSelectedNodeIds, setSelectedConnectionId, setViewport, setContextMenu } =
        params;
    const setAgentCanvasContext = useAgentStore((state) => state.setCanvasContext);
    const instanceId = useRef(crypto.randomUUID()).current;
    const [agentUndoSnapshot, setAgentUndoSnapshot] = useState<CanvasAgentSnapshot | null>(null);
    const pendingTurnRef = useRef<{ key: string; scope: AgentCanvasTurnScope; before: CanvasAgentSnapshot; changedIds: Set<string>; pinnedIds: Set<string>; allocating: number; waitingIds: Set<string>; finished: boolean; resolve?: (result: CanvasAgentSnapshot | null) => void } | null>(null);
    const settleGenerationRef = useRef<(scope: AgentCanvasTurnScope | undefined, ids: string[]) => void>(() => undefined);
    const projectTitle = title || i18n.t("canvas.project.untitled");
    const turnKey = useCallback((scope: AgentCanvasTurnScope) => `${scope.workspaceId}\0${scope.engine}\0${scope.threadId}\0${scope.turnId}`, []);
    const isActiveTurn = useCallback((scope?: AgentCanvasTurnScope) => {
        if (!scope?.threadId || !scope.turnId || !scope.workspaceId || getActiveWorkspace()?.id !== scope.workspaceId) return false;
        const state = useAgentStore.getState();
        return state.engine === scope.engine && state.activeThreadId === scope.threadId && state.activeTurnId === scope.turnId;
    }, []);
    const recordTurnNodes = useCallback((scope: AgentCanvasTurnScope | undefined, before: CanvasAgentSnapshot, ids: string[], prepare = false, pinnedIds: string[] = []) => {
        if ((!ids.length && !prepare) || !isActiveTurn(scope)) return false;
        const key = turnKey(scope!);
        const firstWrite = pendingTurnRef.current?.key !== key;
        if (firstWrite) {
            pendingTurnRef.current?.resolve?.(null);
            pendingTurnRef.current = { key, scope: scope!, before, changedIds: new Set(), pinnedIds: new Set(), allocating: 0, waitingIds: new Set(), finished: false };
        }
        ids.forEach((id) => pendingTurnRef.current!.changedIds.add(id));
        pinnedIds.forEach((id) => pendingTurnRef.current!.pinnedIds.add(id));
        return firstWrite;
    }, [isActiveTurn, turnKey]);

    const agentSnapshot = useMemo<CanvasAgentSnapshot>(() => ({ projectId, title: projectTitle, nodes, connections, selectedNodeIds: Array.from(selectedNodeIds), viewport }), [connections, projectTitle, nodes, projectId, selectedNodeIds, viewport]);
    const applyAgentOps = useCallback(
        (ops?: CanvasAgentOp[], scope?: AgentCanvasTurnScope) => {
            const safeOps = Array.isArray(ops) ? ops.filter((op) => op?.type) : [];
            const before = { projectId, title: projectTitle, nodes: nodesRef.current, connections: connectionsRef.current, selectedNodeIds: Array.from(selectedNodeIdsRef.current), viewport: viewportRef.current };
            const generationOps = safeOps.filter((op): op is Extract<CanvasAgentOp, { type: "run_generation" }> => op.type === "run_generation" && Boolean(op.nodeId));
            const next = applyCanvasAgentOps(
                before,
                safeOps.filter((op) => op.type !== "run_generation"),
            );
            const oldNodes = new Map(before.nodes.map((node) => [node.id, node]));
            const changedIds = next.nodes.filter((node) => !oldNodes.has(node.id) || safeOps.some((op) => op.type === "update_node" && op.id === node.id && oldNodes.get(node.id) !== node)).map((node) => node.id);
            // Agent 显式写入的坐标优先于轮次结束后的自动排版。
            const pinnedIds = safeOps.flatMap((op) => op.type === "update_node" && op.patch?.position ? [op.id] : []);
            const mutates = next.nodes !== before.nodes || next.connections !== before.connections || generationOps.length > 0;
            const firstTurnWrite = recordTurnNodes(scope, before, changedIds, mutates, pinnedIds);
            if (scope && pendingTurnRef.current?.key === turnKey(scope)) {
                const pending = pendingTurnRef.current;
                pending.allocating += generationOps.length;
                for (const op of safeOps) if (op.type === "delete_node") {
                    const deleted = op.ids || (op.id ? [op.id] : op.nodeType ? before.nodes.filter((node) => node.type === op.nodeType).map((node) => node.id) : []);
                    deleted.forEach((id) => pending.waitingIds.delete(id));
                }
            }
            nodesRef.current = next.nodes;
            connectionsRef.current = next.connections;
            selectedNodeIdsRef.current = new Set(next.selectedNodeIds);
            viewportRef.current = next.viewport;
            if (!scope || firstTurnWrite) setAgentUndoSnapshot(before);
            setNodes(next.nodes);
            setConnections(next.connections);
            setSelectedNodeIds(new Set(next.selectedNodeIds));
            setSelectedConnectionId(null);
            setViewport(next.viewport);
            setContextMenu(null);
            if (generationOps.length) {
                const workspaceId = getActiveWorkspace()?.id;
                queueMicrotask(() =>
                    generationOps.forEach((op) => {
                        const state = useAgentStore.getState();
                        if (getActiveWorkspace()?.id !== workspaceId || state.canvasContext?.instanceId !== instanceId || state.canvasContext.snapshot.projectId !== projectId || scope && (state.engine !== scope.engine || state.activeThreadId !== scope.threadId || state.activeTurnId !== scope.turnId)) {
                            settleGenerationRef.current(scope, []);
                            return;
                        }
                        const target = nodesRef.current.find((node) => node.id === op.nodeId);
                        const prompt = op.prompt?.trim() ? op.prompt : (target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                        setNodes((items) => items.map((node) => node.id === op.nodeId ? { ...node, metadata: { ...node.metadata, generationDispatchError: undefined } } : node));
                        let allocated = false;
                        const created = (ids: string[]) => {
                            if (allocated) return;
                            allocated = true;
                            settleGenerationRef.current(scope, ids);
                        };
                        void Promise.resolve(generateNodeRef.current?.(op.nodeId, op.mode || target?.metadata?.generationMode || "image", prompt, op.requestId, created)).catch((error) => {
                            if (getActiveWorkspace()?.id !== workspaceId || useAgentStore.getState().canvasContext?.snapshot.projectId !== projectId) return;
                            const message = error instanceof Error ? error.message : String(error);
                            const createdAt = new Date().toISOString();
                            setNodes((items) => items.map((node) => node.id === op.nodeId ? { ...node, metadata: { ...node.metadata, generationDispatchError: { requestId: op.requestId, kind: op.mode || target?.metadata?.generationMode || "image", message, createdAt } } } : node));
                            useAgentStore.getState().addEventLog({ id: crypto.randomUUID(), time: createdAt, title: "画布生成派发失败", text: message, raw: { projectId, nodeId: op.nodeId, requestId: op.requestId } });
                        }).finally(() => { if (!allocated) created([]); });
                    }),
                );
            }
            return { ...next, projectId, title: projectTitle };
        },
        [projectTitle, projectId, instanceId, recordTurnNodes],
    );
    const completePendingTurn = useCallback((scope: AgentCanvasTurnScope) => {
        const pending = pendingTurnRef.current;
        if (!pending || pending.key !== turnKey(scope) || !pending.finished || pending.allocating || pending.waitingIds.size) return;
        pendingTurnRef.current = null;
        const state = useAgentStore.getState();
        if (getActiveWorkspace()?.id !== scope.workspaceId || pending.before.projectId !== projectId || state.engine !== scope.engine || state.activeThreadId !== scope.threadId || state.activeTurnId && state.activeTurnId !== scope.turnId || state.canvasContext?.instanceId !== instanceId || state.canvasContext.snapshot.projectId !== projectId) { pending.resolve?.(null); return; }
        const before = nodesRef.current;
        const next = autoLayoutCanvasChanges(before, connectionsRef.current, [...pending.changedIds], pending.pinnedIds);
        const moved = next !== before && next.some((node, index) => node !== before[index]);
        if (moved) { nodesRef.current = next; setNodes(next); }
        // 显式定位的节点不触发视口聚焦，其余本轮节点保持原有聚焦行为。
        const laidOut = new Set(next.filter((node, index) => node !== before[index] && (node.position.x !== before[index].position.x || node.position.y !== before[index].position.y)).map((node) => node.id));
        const focusIds = new Set([...pending.changedIds].filter((id) => !pending.pinnedIds.has(id)));
        laidOut.forEach((id) => focusIds.add(id));
        const changed = next.filter((node) => focusIds.has(node.id));
        const { width, height } = sizeRef.current;
        let focused = false;
        if (changed.length && width > 0 && height > 0) {
            const bounds = nodeBounds(changed);
            const view = viewportRef.current;
            const top = width < 768 ? 128 : 72;
            const bottom = width < 768 ? 180 : 88;
            if (bounds.left * view.k + view.x < 32 || bounds.right * view.k + view.x > width - 32 || bounds.top * view.k + view.y < top || bounds.bottom * view.k + view.y > height - bottom) {
                viewportRef.current = focusViewportForNode({ position: { x: bounds.left, y: bounds.top }, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top }, { width, height }, { bottomInset: bottom });
                setViewport(viewportRef.current);
                focused = true;
            }
        }
        pending.resolve?.(moved || focused ? { projectId, title: projectTitle, nodes: next, connections: connectionsRef.current, selectedNodeIds: [...selectedNodeIdsRef.current], viewport: viewportRef.current } : null);
    }, [connectionsRef, nodesRef, selectedNodeIdsRef, viewportRef, sizeRef, projectId, projectTitle, instanceId, setNodes, setViewport, turnKey]);
    const settleGeneration = useCallback((scope: AgentCanvasTurnScope | undefined, ids: string[]) => {
        if (!scope || pendingTurnRef.current?.key !== turnKey(scope)) return;
        const pending = pendingTurnRef.current;
        const state = useAgentStore.getState();
        if (getActiveWorkspace()?.id === scope.workspaceId && state.engine === scope.engine && state.activeThreadId === scope.threadId) {
            ids.forEach((id) => pending.changedIds.add(id));
            ids.forEach((id) => pending.waitingIds.add(id));
        }
        pending.allocating -= 1;
        completePendingTurn(scope);
    }, [completePendingTurn, turnKey]);
    settleGenerationRef.current = settleGeneration;
    useLayoutEffect(() => {
        const pending = pendingTurnRef.current;
        if (!pending?.waitingIds.size || [...pending.waitingIds].some((id) => !nodes.some((node) => node.id === id))) return;
        nodesRef.current = nodes;
        connectionsRef.current = connections;
        pending.waitingIds.clear();
        completePendingTurn(pending.scope);
    }, [nodes, connections, nodesRef, connectionsRef, completePendingTurn]);
    const finishTurn = useCallback((scope: AgentCanvasTurnScope) => {
        const pending = pendingTurnRef.current;
        if (!pending || pending.key !== turnKey(scope)) return Promise.resolve(null);
        if (pending.finished) return Promise.resolve(null);
        pending.finished = true;
        const result = new Promise<CanvasAgentSnapshot | null>((resolve) => { pending.resolve = resolve; });
        completePendingTurn(scope);
        return result;
    }, [completePendingTurn, turnKey]);
    const discardTurn = useCallback(() => { pendingTurnRef.current?.resolve?.(null); pendingTurnRef.current = null; }, []);
    const undoAgentOps = useCallback(() => {
        if (!agentUndoSnapshot) return null;
        discardTurn();
        nodesRef.current = agentUndoSnapshot.nodes;
        connectionsRef.current = agentUndoSnapshot.connections;
        selectedNodeIdsRef.current = new Set(agentUndoSnapshot.selectedNodeIds);
        viewportRef.current = agentUndoSnapshot.viewport;
        setNodes(agentUndoSnapshot.nodes);
        setConnections(agentUndoSnapshot.connections);
        setSelectedNodeIds(new Set(agentUndoSnapshot.selectedNodeIds));
        setSelectedConnectionId(null);
        setViewport(agentUndoSnapshot.viewport);
        setContextMenu(null);
        setAgentUndoSnapshot(null);
        return { ...agentUndoSnapshot, projectId, title: projectTitle };
    }, [agentUndoSnapshot, projectTitle, projectId, discardTurn]);

    useEffect(() => {
        setAgentCanvasContext({ instanceId, snapshot: agentSnapshot, applyOps: applyAgentOps, finishTurn, discardTurn, undoOps: undoAgentOps, canUndo: Boolean(agentUndoSnapshot), get templateCanvas() {
            const canvas = params.templateCanvasRef.current;
            return canvas && { ...canvas, insert: async (...args: Parameters<typeof canvas.insert>) => {
                const state = useAgentStore.getState();
                const scope = { engine: state.engine, threadId: state.activeThreadId, turnId: state.activeTurnId, workspaceId: getActiveWorkspace()?.id || "" };
                const before = { projectId, title: projectTitle, nodes: nodesRef.current, connections: connectionsRef.current, selectedNodeIds: [...selectedNodeIdsRef.current], viewport: viewportRef.current };
                const result = await canvas.insert(...args);
                if (recordTurnNodes(scope, before, result.insertedNodeIds)) setAgentUndoSnapshot(before);
                return result;
            } };
        } });
    }, [instanceId, agentSnapshot, applyAgentOps, finishTurn, discardTurn, agentUndoSnapshot, setAgentCanvasContext, undoAgentOps, params.templateCanvasRef, projectId, projectTitle, nodesRef, connectionsRef, selectedNodeIdsRef, viewportRef, recordTurnNodes]);
    useEffect(() => useAgentStore.subscribe((state, previous) => {
        if (state.engine !== previous.engine || state.activeThreadId !== previous.activeThreadId) discardTurn();
    }), [discardTurn]);
    useEffect(() => () => discardTurn(), [projectId, discardTurn]);
    useEffect(() => () => {
        discardTurn();
        if (useAgentStore.getState().canvasContext?.instanceId === instanceId) setAgentCanvasContext(null);
    }, [discardTurn, instanceId, setAgentCanvasContext]);

    return { applyAgentOps };
}
