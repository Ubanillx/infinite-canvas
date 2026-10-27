import { useState, type FormEvent } from "react";
import { authenticateWorkspace } from "@/services/api/workspace-auth";
import { clearActiveWorkspace, setKnownWorkspaces } from "@/lib/workspace";

export function WorkspaceAccountForm() {
    const [mode, setMode] = useState<"login" | "register">("login");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState("");
    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setPending(true);
        setError("");
        try {
            await authenticateWorkspace(mode, String(data.get("username")).trim(), String(data.get("password")));
            clearActiveWorkspace();
            setKnownWorkspaces([]);
            window.location.reload();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "登录失败");
            setPending(false);
        }
    };
    const inputClass = "mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/30";
    return <form key={mode} className="max-w-md space-y-5 text-foreground" onSubmit={(event) => void submit(event)}>
        <p className="text-sm text-muted-foreground">{mode === "register" ? "注册后将创建一个归属于你的工作区。" : "登录后仅显示你已加入的工作区。"}旧版无成员工作区需由管理员明确绑定，不会自动认领。</p>
        <label className="block text-sm">用户名<input name="username" autoComplete="username" required minLength={3} maxLength={64} className={inputClass} /></label>
        <label className="block text-sm">密码<input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={mode === "register" ? 8 : undefined} maxLength={256} className={inputClass} /></label>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div className="flex flex-wrap items-center gap-4">
            <button type="submit" disabled={pending} className="rounded-md bg-foreground/5 px-5 py-2 text-sm font-medium hover:bg-foreground/10 disabled:opacity-50">{pending ? "正在处理…" : mode === "login" ? "登录" : "注册并创建工作区"}</button>
            <button type="button" disabled={pending} className="rounded-md px-2 py-2 text-sm text-muted-foreground hover:bg-foreground/5" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>{mode === "login" ? "注册账户" : "已有账户，去登录"}</button>
        </div>
    </form>;
}
