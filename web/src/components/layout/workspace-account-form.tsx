import type { TFunction } from "i18next";
import { useEffect, useState, type FormEvent } from "react";
import { Button, Input } from "antd";
import { AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { authenticateWorkspace, getRegistrationPolicy, keycloakLoginUrl, sendRegistrationEmailCode, WorkspaceAuthError } from "@/services/api/workspace-auth";
import { clearActiveWorkspace, setKnownWorkspaces } from "@/lib/workspace";
import type { RegistrationPolicy } from "@/lib/registration";

const authErrorKeys: Record<string, string> = {
    keycloak_disabled: "accountForm.keycloakDisabled",
    keycloak_unavailable: "accountForm.keycloakUnavailable",
    keycloak_state: "accountForm.keycloakState",
    keycloak_profile: "accountForm.keycloakProfile",
    keycloak_failed: "accountForm.keycloakFailed",
    keycloak_email_unverified: "accountForm.keycloakEmailUnverified",
    keycloak_email_domain: "accountForm.keycloakEmailDomain",
    keycloak_email_conflict: "accountForm.keycloakEmailConflict",
    keycloak_bind_login_required: "accountForm.keycloakBindLoginRequired",
    keycloak_bind_identity_taken: "accountForm.keycloakBindIdentityTaken",
    keycloak_bind_already_bound: "accountForm.keycloakBindAlreadyBound",
    keycloak_bind_email_missing: "accountForm.keycloakBindEmailMissing",
    keycloak_bind_email_unverified: "accountForm.keycloakBindEmailUnverified",
    keycloak_bind_email_verified_missing: "accountForm.keycloakBindEmailVerifiedMissing",
    keycloak_bind_local_email_missing: "accountForm.keycloakBindLocalEmailMissing",
    keycloak_bind_email_mismatch: "accountForm.keycloakBindEmailMismatch",
    keycloak_bind_session_changed: "accountForm.keycloakBindSessionChanged",
    keycloak_bind_failed: "accountForm.keycloakBindFailed",
};

function authErrorCodeFromLocation() {
    return new URLSearchParams(window.location.search).get("auth_error") || "";
}

function authErrorFromLocation(t: TFunction) {
    const code = authErrorCodeFromLocation();
    return code ? t(authErrorKeys[code] || "accountForm.keycloakFailed") : "";
}

export function WorkspaceAccountForm({ keycloakEnabled = false, localLoginEnabled = true }: { keycloakEnabled?: boolean; localLoginEnabled?: boolean }) {
    const { t } = useTranslation();
    const [mode, setMode] = useState<"login" | "register">("login");
    const [pending, setPending] = useState<"sso" | "local" | "code" | null>(null);
    const [authCode] = useState(authErrorCodeFromLocation);
    const [conflict, setConflict] = useState(authCode === "keycloak_email_conflict");
    const [error, setError] = useState(() => authCode === "keycloak_email_conflict" ? "" : authErrorFromLocation(t));
    const [policy, setPolicy] = useState<RegistrationPolicy | null>(null);
    const [email, setEmail] = useState("");
    const [code, setCode] = useState("");
    const [challengeToken, setChallengeToken] = useState("");
    const [sentMinutes, setSentMinutes] = useState<number | null>(null);
    const [resendAt, setResendAt] = useState(0);
    const [clock, setClock] = useState(Date.now);
    const remaining = Math.max(0, Math.ceil((resendAt - clock) / 1000));

    useEffect(() => {
        if (mode !== "register") return;
        let active = true;
        setPolicy(null);
        void getRegistrationPolicy().then((value) => { if (active) setPolicy(value); }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : t("accountForm.policyFailed")); });
        return () => { active = false; };
    }, [mode, t]);

    useEffect(() => {
        if (!resendAt) return;
        const timer = window.setInterval(() => {
            const now = Date.now();
            setClock(now);
            if (now >= resendAt) setResendAt(0);
        }, 1000);
        return () => window.clearInterval(timer);
    }, [resendAt]);

    const sendCode = async (form: HTMLFormElement) => {
        const field = form.elements.namedItem("email") as HTMLInputElement;
        if (!field.reportValidity()) return;
        setPending("code");
        setError("");
        try {
            const sent = await sendRegistrationEmailCode(email.trim());
            setChallengeToken(sent.challengeToken);
            setSentMinutes(sent.expiresIn / 60);
            setCode("");
            setClock(Date.now());
            setResendAt(Date.now() + sent.resendAfter * 1000);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t("accountForm.codeFailed"));
            if (reason instanceof WorkspaceAuthError && reason.retryAfter) { setClock(Date.now()); setResendAt(Date.now() + reason.retryAfter * 1000); }
        } finally { setPending(null); }
    };

    useEffect(() => {
        const url = new URL(window.location.href);
        if (!url.searchParams.has("auth_error")) return;
        url.searchParams.delete("auth_error");
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }, []);

    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setConflict(false);
        setPending("local");
        setError("");
        try {
            await authenticateWorkspace(mode, String(data.get("username")).trim(), String(data.get("password")), mode === "register" ? { email: email.trim(), code, challengeToken } : undefined);
            clearActiveWorkspace();
            setKnownWorkspaces([]);
            window.location.reload();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t("accountForm.loginFailed"));
            setPending(null);
        }
    };
    const title = conflict ? t("accountForm.keycloakConflictPageTitle") : t(mode === "register" ? "accountForm.registerTitle" : "workspaceGate.loginTitle");
    const subtitle = conflict ? t("accountForm.keycloakConflictPageSubtitle") : t(mode === "register" ? "accountForm.registerHint" : keycloakEnabled ? "workspaceGate.ssoLoginSubtitle" : "workspaceGate.localLoginSubtitle");
    return <div className="space-y-6 text-foreground">
        <div><h1 id="workspace-login-title" className="text-2xl font-semibold tracking-tight">{title}</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">{subtitle}</p></div>
        {conflict ? <div className="space-y-4">
            <div className="rounded-xl border border-border bg-muted/30 p-4">
                <div className="grid size-10 place-items-center rounded-lg bg-destructive/10 text-destructive"><AlertCircle className="size-5" /></div>
                <h2 className="mt-3 text-base font-semibold">{t("accountForm.keycloakConflictTitle")}</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("accountForm.keycloakConflictDescription")}</p>
                <div className="mt-4 grid gap-2">
                    {localLoginEnabled ? <Button type="primary" block onClick={() => { setConflict(false); setError(""); }}>{t("accountForm.keycloakConflictUseLocal")}</Button> : null}
                    <Button block onClick={() => { setConflict(false); setError(""); }}>{t("accountForm.keycloakConflictBack")}</Button>
                </div>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">{localLoginEnabled ? t("accountForm.keycloakConflictLocalHint") : t("accountForm.keycloakConflictAdminHint")}</p>
        </div> : <>
        {error ? <p role="alert" className="text-sm leading-6 text-destructive">{error}</p> : null}
        {localLoginEnabled ? <form key={mode} className="space-y-4" onSubmit={(event) => void submit(event)}>
            <label className="block text-sm">{t("accountForm.username")}<Input className="mt-2" name="username" autoComplete="username" required minLength={3} maxLength={64} size="large" disabled={pending !== null} placeholder={t("accountForm.usernamePlaceholder")} /></label>
            <label className="block text-sm">{t("accountForm.password")}<Input.Password className="mt-2" name="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={mode === "register" ? 8 : undefined} maxLength={256} size="large" disabled={pending !== null} placeholder={t(mode === "register" ? "accountForm.passwordNewPlaceholder" : "accountForm.passwordPlaceholder")} /></label>
            {mode === "register" ? <>
                <label className="block text-sm">{t("accountForm.workEmail")}<Input className="mt-2" name="email" type="email" autoComplete="email" size="large" required value={email} disabled={pending !== null} placeholder={t("accountForm.emailPlaceholder")} onChange={(event) => { setEmail(event.target.value); setCode(""); setChallengeToken(""); setResendAt(0); }} /></label>
                <p className="text-xs leading-5 text-muted-foreground">{!policy ? t("accountForm.policyLoading") : !policy.ready ? t("accountForm.mailUnavailable") : policy.allowedDomains.length ? t("accountForm.allowedDomains", { domains: policy.allowedDomains.join("、") }) : t("accountForm.emailHint")}</p>
                <div className="text-sm"><label htmlFor="registration-email-code">{t("accountForm.emailCode")}</label><div className="mt-2 flex items-center gap-2"><Input id="registration-email-code" name="code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required size="large" value={code} disabled={pending !== null} placeholder={t("accountForm.emailCodePlaceholder")} onChange={(event) => setCode(event.target.value)} /><Button size="large" loading={pending === "code"} disabled={pending !== null || !policy?.ready || remaining > 0} onClick={(event) => { const form = event.currentTarget.closest("form"); if (form) void sendCode(form); }}>{remaining > 0 ? t("accountForm.resendCountdown", { seconds: remaining }) : t("accountForm.sendCode")}</Button></div></div>
                {challengeToken ? <p role="status" className="text-xs leading-5 text-muted-foreground">{t("accountForm.codeSent", { minutes: sentMinutes })}</p> : null}
            </> : null}
            <Button type="primary" htmlType="submit" size="large" block style={{ height: 44 }} loading={pending === "local"} disabled={pending === "sso" || pending === "code" || (mode === "register" && (!policy?.ready || !challengeToken))}>{t(pending === "local" ? "accountForm.processing" : mode === "register" ? "accountForm.register" : "accountForm.login")}</Button>
            <div className="flex items-center justify-center gap-1 text-sm text-muted-foreground"><span>{t(mode === "login" ? "accountForm.noAccount" : "accountForm.hasAccount")}</span><Button type="link" size="small" style={{ paddingInline: 0 }} disabled={pending !== null} onClick={() => { setMode(mode === "login" ? "register" : "login"); setConflict(false); setError(""); }}>{t(mode === "login" ? "accountForm.goRegister" : "accountForm.goLogin")}</Button></div>
        </form> : null}
        {keycloakEnabled ? <div className={`flex justify-center${localLoginEnabled ? " border-t border-border pt-6" : ""}`}>
            <Button size="large" className="min-w-[184px] max-w-full" style={{ height: 44 }} loading={pending === "sso"} disabled={pending === "local" || pending === "code"} icon={<img src="/topmax-mark.png" alt="" width={22} height={22} className="size-[22px] object-contain" />} onClick={() => { setPending("sso"); window.location.assign(keycloakLoginUrl()); }}>{t(pending === "sso" ? "accountForm.redirecting" : "accountForm.keycloakLogin")}</Button>
        </div> : null}
        </>}
    </div>;
}
