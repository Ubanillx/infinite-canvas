import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Button, Empty, Form, Input, Modal, Select, Spin } from "antd";
import { KeyRound, LogOut, Plus, Unlock } from "lucide-react";

import { clearActiveWorkspace, getActiveWorkspace, getKnownWorkspaces, migrateLegacyDataToWorkspace, setActiveWorkspace, setKnownWorkspaces, type WorkspaceAccess } from "@/lib/workspace";
import { createWorkspace, listWorkspaces, unlockWorkspace, verifyWorkspace } from "@/services/workspace";

type GateMode = "select" | "unlock" | "create" | "created";

export function WorkspaceGate({ children }: { children: ReactNode }) {
    const [ready, setReady] = useState(false);
    const [loading, setLoading] = useState(true);
    const [mode, setMode] = useState<GateMode>("select");
    const [workspaces, setWorkspaces] = useState<WorkspaceAccess[]>(getKnownWorkspaces);
    const [error, setError] = useState("");
    const [createdWorkspace, setCreatedWorkspace] = useState<WorkspaceAccess | null>(null);
    const [form] = Form.useForm<Record<string, string>>();

    useEffect(() => {
        void (async () => {
            try {
                const available = await listWorkspaces();
                setKnownWorkspaces(available);
                setWorkspaces(available);
                const active = getActiveWorkspace();
                const listed = active && available.find((item) => item.id === active.id);
                if (listed && active.accessKey) {
                    const verified = await verifyWorkspace();
                    const workspace = { ...listed, ...verified, accessKey: active.accessKey };
                    setActiveWorkspace(workspace);
                    await migrateLegacyDataToWorkspace(workspace);
                    setReady(true);
                    return;
                }
                setMode(available.length ? "select" : "create");
            } catch (reason) {
                setError(reason instanceof Error ? reason.message : "无法读取工作区列表");
                setMode("create");
            } finally {
                setLoading(false);
            }
        })();
    }, []);

    const submit = async (values: Record<string, string>) => {
        setLoading(true);
        setError("");
        try {
            if (mode === "select") {
                const workspace = workspaces.find((item) => item.id === values.workspaceId);
                if (!workspace) throw new Error("请选择工作区");
                setMode("unlock");
                form.setFieldsValue({ workspaceId: workspace.id });
            } else if (mode === "unlock") {
                const workspace = await unlockWorkspace(values.workspaceId, values.accessKey.trim());
                setActiveWorkspace(workspace);
                await migrateLegacyDataToWorkspace(workspace);
                window.location.reload();
            } else if (mode === "create") {
                const workspace = await createWorkspace(values.name.trim());
                setActiveWorkspace(workspace);
                setCreatedWorkspace(workspace);
                setMode("created");
            }
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "工作区操作失败");
        } finally {
            setLoading(false);
        }
    };

    const workspaceOptions = useMemo(() => workspaces.map((item) => ({ value: item.id, label: item.name })), [workspaces]);
    if (ready) return <>{children}</>;
    return (
        <div className="flex min-h-dvh items-center justify-center bg-background px-5 text-foreground">
            <section className="w-full max-w-md rounded-lg border border-stone-200 bg-background p-6 shadow-sm dark:border-stone-800">
                <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-md bg-stone-100 dark:bg-stone-900"><KeyRound className="size-5" /></div>
                    <div><div className="text-base font-semibold">选择工作区</div><div className="mt-1 text-xs text-stone-500">数据按工作区独立保存，输入访问密钥即可进入。</div></div>
                </div>
                {loading ? <div className="flex min-h-48 items-center justify-center"><Spin /></div> : mode === "created" && createdWorkspace ? (
                    <div className="mt-6 space-y-4">
                        <div className="text-sm">工作区已创建，请保存访问密钥。之后可用它在其他浏览器进入此工作区。</div>
                        <Input.Password readOnly value={createdWorkspace.accessKey} onFocus={(event) => event.currentTarget.select()} />
                        <Button type="primary" block onClick={() => window.location.reload()}>保存后进入工作区</Button>
                    </div>
                ) : <>
                    {mode === "select" && !workspaces.length ? <Empty className="my-8" image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可用工作区" /> : null}
                    <Form form={form} layout="vertical" className="mt-6" onFinish={(values) => void submit(values)}>
                        {mode === "select" ? <Form.Item name="workspaceId" label="工作区" initialValue={workspaces[0]?.id} rules={[{ required: true, message: "请选择工作区" }]}><Select options={workspaceOptions} /></Form.Item> : null}
                        {mode === "unlock" ? <><Form.Item name="workspaceId" label="工作区" rules={[{ required: true, message: "请选择工作区" }]}><Select options={workspaceOptions} /></Form.Item><Form.Item name="accessKey" label="访问密钥" rules={[{ required: true, message: "请输入访问密钥" }]}><Input.Password autoFocus autoComplete="off" /></Form.Item></> : null}
                        {mode === "create" ? <Form.Item name="name" label="新工作区名称" rules={[{ required: true, whitespace: true, message: "请输入工作区名称" }]}><Input autoFocus maxLength={80} placeholder="例如：产品设计团队" /></Form.Item> : null}
                        {error ? <div className="mb-4 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/30 dark:text-red-300">{error}</div> : null}
                        {mode === "select" ? <Button type="primary" htmlType="submit" block icon={<Unlock className="size-4" />}>输入密钥</Button> : null}
                        {mode === "unlock" ? <Button type="primary" htmlType="submit" block icon={<Unlock className="size-4" />}>解锁并进入</Button> : null}
                        {mode === "create" ? <Button type="primary" htmlType="submit" block icon={<Plus className="size-4" />}>创建工作区</Button> : null}
                    </Form>
                    <div className="mt-4 flex flex-wrap gap-2">
                        {mode !== "select" && workspaces.length ? <Button size="small" type="text" onClick={() => { form.resetFields(); setMode("select"); }}>返回工作区列表</Button> : null}
                        {mode !== "create" ? <Button size="small" type="text" onClick={() => { form.resetFields(); setError(""); setMode("create"); }}>新建工作区</Button> : null}
                    </div>
                </>}
            </section>
        </div>
    );
}

export function WorkspaceSwitcher() {
    const [open, setOpen] = useState(false);
    const workspace = getActiveWorkspace();
    const workspaces = getKnownWorkspaces();
    if (!workspace) return null;
    return <><Button type="text" size="small" className="max-w-40 truncate" title="切换工作区" onClick={() => setOpen(true)}>{workspace.name}</Button><Modal title="工作区" open={open} footer={null} onCancel={() => setOpen(false)}><div className="flex flex-col gap-2.5">{workspaces.map((item) => <Button key={item.id} block className="!h-10" type={item.id === workspace.id ? "primary" : "default"} onClick={() => { if (item.accessKey) { setActiveWorkspace(item); window.location.reload(); } }}>{item.name}</Button>)}<Button block className="!h-10" icon={<Plus className="size-4" />} onClick={() => { clearActiveWorkspace(); window.location.reload(); }}>选择或创建工作区</Button><Button danger block className="!h-10" icon={<LogOut className="size-4" />} onClick={() => { clearActiveWorkspace(); window.location.reload(); }}>退出当前工作区</Button></div></Modal></>;
}
