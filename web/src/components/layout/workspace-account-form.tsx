import type { TFunction } from "i18next";
import { useEffect, useState, type FormEvent } from "react";
import { Button, Input } from "antd";
import { useTranslation } from "react-i18next";

import { authenticateWorkspace, keycloakLoginUrl } from "@/services/api/workspace-auth";
import { clearActiveWorkspace, setKnownWorkspaces } from "@/lib/workspace";

const authErrorKeys: Record<string, string> = {
    keycloak_disabled: "accountForm.keycloakDisabled",
    keycloak_unavailable: "accountForm.keycloakUnavailable",
    keycloak_state: "accountForm.keycloakState",
    keycloak_profile: "accountForm.keycloakProfile",
    keycloak_failed: "accountForm.keycloakFailed",
};

function authErrorFromLocation(t: TFunction) {
    const code = new URLSearchParams(window.location.search).get("auth_error");
    return code ? t(authErrorKeys[code] || "accountForm.keycloakFailed") : "";
}

export function WorkspaceAccountForm({ keycloakEnabled = false, localLoginEnabled = true }: { keycloakEnabled?: boolean; localLoginEnabled?: boolean }) {
    const { t } = useTranslation();
    const [mode, setMode] = useState<"login" | "register">("login");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState(() => authErrorFromLocation(t));

    useEffect(() => {
        const url = new URL(window.location.href);
        if (!url.searchParams.has("auth_error")) return;
        url.searchParams.delete("auth_error");
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }, []);

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
            setError(reason instanceof Error ? reason.message : t("accountForm.loginFailed"));
            setPending(false);
        }
    };
    return <div className="max-w-md space-y-6 text-foreground">
        {keycloakEnabled ? <div className="space-y-4">
            <Button size="large" block disabled={pending} onClick={() => { setPending(true); window.location.assign(keycloakLoginUrl()); }}>{t("accountForm.keycloakLogin")}</Button>
            <p className="text-xs text-muted-foreground">{t("accountForm.keycloakHint")}</p>
            {localLoginEnabled ? <div className="flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" />{t("accountForm.orLocal")}<span className="h-px flex-1 bg-border" /></div> : null}
        </div> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {localLoginEnabled ? <form key={mode} className="space-y-5" onSubmit={(event) => void submit(event)}>
            <p className="text-sm text-muted-foreground">{t(mode === "register" ? "accountForm.registerHint" : "accountForm.loginHint")}</p>
            <label className="block text-sm">{t("accountForm.username")}<Input className="mt-2" name="username" autoComplete="username" required minLength={3} maxLength={64} size="large" /></label>
            <label className="block text-sm">{t("accountForm.password")}<Input.Password className="mt-2" name="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={mode === "register" ? 8 : undefined} maxLength={256} size="large" /></label>
            <div className="flex flex-wrap items-center gap-4">
                <Button type="primary" htmlType="submit" size="large" loading={pending}>{pending ? t("accountForm.processing") : mode === "login" ? t("accountForm.login") : t("accountForm.register")}</Button>
                <Button type="text" size="large" disabled={pending} onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>{mode === "login" ? t("accountForm.registerAccount") : t("accountForm.goLogin")}</Button>
            </div>
        </form> : keycloakEnabled ? <p className="text-sm text-muted-foreground">{t("accountForm.localDisabled")}</p> : null}
    </div>;
}
