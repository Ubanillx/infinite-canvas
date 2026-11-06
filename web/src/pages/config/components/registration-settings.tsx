import { App, Button, Input, Select } from "antd";
import { Save } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { registrationMailText, type RegistrationConfig } from "@/lib/registration";
import { getRegistrationConfig, saveRegistrationConfig, testRegistrationSmtp } from "@/services/api/registration";

const limits = ["codeTtlMinutes", "resendSeconds", "maxAttempts", "hourlyLimit"] as const;

export function RegistrationSettings({ headerActionsId }: { headerActionsId?: string }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [config, setConfig] = useState<RegistrationConfig | null>(null);
    const [domains, setDomains] = useState("");
    const [busy, setBusy] = useState<"save" | "test" | null>(null);
    const [error, setError] = useState("");
    const [actionsTarget, setActionsTarget] = useState<HTMLElement | null>(null);
    const formRef = useRef<HTMLFormElement>(null);

    useEffect(() => {
        let active = true;
        void getRegistrationConfig().then((value) => { if (active) { setConfig(value); setDomains(value.allowedDomains.join("\n")); } }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : t("registrationSettings.loadFailed")); });
        return () => { active = false; };
    }, [t]);

    useLayoutEffect(() => {
        setActionsTarget(headerActionsId ? document.getElementById(headerActionsId) : null);
    }, [headerActionsId]);

    const save = async (test: boolean) => {
        if (!config) return;
        setBusy(test ? "test" : "save");
        setError("");
        try {
            const saved = await saveRegistrationConfig({ ...config, allowedDomains: domains.split(/[\s,;，；]+/).filter(Boolean) });
            setConfig(saved);
            setDomains(saved.allowedDomains.join("\n"));
            if (test) await testRegistrationSmtp();
            message.success(t(test ? "registrationSettings.connectionOk" : "registrationSettings.saved"));
        } catch (reason) { setError(reason instanceof Error ? reason.message : t("registrationSettings.saveFailed")); }
        finally { setBusy(null); }
    };
    const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void save(false); };
    const updateSmtp = (key: keyof RegistrationConfig["smtp"], value: string | number) => setConfig((current) => current ? { ...current, smtp: { ...current.smtp, [key]: value } } : current);

    if (!config) return <p role={error ? "alert" : "status"} className={error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{error || t("registrationSettings.loading")}</p>;
    const smtp = config.smtp;
    const preview = { host: smtp.host, port: smtp.port, security: smtp.security, user: smtp.user, from: smtp.from, fromName: smtp.fromName, password: t(smtp.password || smtp.hasPassword ? "registrationSettings.passwordSet" : "registrationSettings.passwordEmpty") };
    const saveButton = <Button type="primary" icon={<Save className="size-4" />} loading={busy === "save"} disabled={busy !== null} onClick={() => { if (formRef.current?.reportValidity()) void save(false); }}>{t("config.serverStorage.save")}</Button>;

    return <form ref={formRef} className="space-y-5" onSubmit={submit}>
        {error ? <p role="alert" className="text-sm leading-6 text-destructive">{error}</p> : null}
        <fieldset disabled={busy !== null} className="min-w-0 space-y-5">
            <section className="space-y-4 rounded-xl border border-border p-5">
                <h2 className="text-sm font-semibold text-foreground">{t("registrationSettings.registrationTitle")}</h2>
                <label className="block text-sm text-foreground">{t("registrationSettings.domains")}<Input.TextArea className="mt-2" rows={3} value={domains} onChange={(event) => setDomains(event.target.value)} placeholder="topmax.cn" /></label>
                <p className="text-xs leading-5 text-muted-foreground">{t("registrationSettings.domainsHint")}</p>
                <div className="grid gap-4 sm:grid-cols-2">{limits.map((key) => <label key={key} className="block text-sm text-foreground">{t(`registrationSettings.${key}`)}<Input className="mt-2" type="number" min={1} step={1} required value={config[key]} onChange={(event) => setConfig({ ...config, [key]: Number(event.target.value) })} /></label>)}</div>
                <p className="text-xs leading-5 text-muted-foreground">{t("registrationSettings.limitsHint")}</p>
            </section>
            <section className="space-y-4 rounded-xl border border-border p-5">
                <h2 className="text-sm font-semibold text-foreground">{t("registrationSettings.smtpTitle")}</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                    <label className="block text-sm text-foreground">{t("registrationSettings.host")}<Input className="mt-2" value={smtp.host} autoComplete="off" placeholder={t("registrationSettings.hostPlaceholder")} onChange={(event) => updateSmtp("host", event.target.value)} /></label>
                    <label className="block text-sm text-foreground">{t("registrationSettings.port")}<Input className="mt-2" type="number" min={1} max={65535} required value={smtp.port} onChange={(event) => updateSmtp("port", Number(event.target.value))} /></label>
                    <div className="text-sm text-foreground"><label htmlFor="registration-smtp-security">{t("registrationSettings.security")}</label><Select id="registration-smtp-security" className="mt-2 w-full" disabled={busy !== null} value={smtp.security} onChange={(value) => updateSmtp("security", value)} options={[{ value: "starttls", label: "STARTTLS" }, { value: "tls", label: "TLS" }]} /></div>
                    <label className="block text-sm text-foreground">{t("registrationSettings.user")}<Input className="mt-2" value={smtp.user} autoComplete="off" placeholder={t("registrationSettings.userPlaceholder")} onChange={(event) => updateSmtp("user", event.target.value)} /></label>
                    <label className="block text-sm text-foreground">{t("registrationSettings.password")}<Input.Password className="mt-2" value={smtp.password} autoComplete="new-password" placeholder={t(smtp.hasPassword ? "registrationSettings.keepPassword" : "registrationSettings.passwordEmpty")} onChange={(event) => updateSmtp("password", event.target.value)} /></label>
                    <label className="block text-sm text-foreground">{t("registrationSettings.from")}<Input className="mt-2" type="email" value={smtp.from} placeholder={t("registrationSettings.fromPlaceholder")} onChange={(event) => updateSmtp("from", event.target.value)} /></label>
                    <label className="block text-sm text-foreground">{t("registrationSettings.fromName")}<Input className="mt-2" value={smtp.fromName} placeholder={t("registrationSettings.fromNamePlaceholder")} onChange={(event) => updateSmtp("fromName", event.target.value)} /></label>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">{t("registrationSettings.smtpHint")}</p>
            </section>
        </fieldset>
        <div className="flex flex-wrap gap-3 pt-4">{actionsTarget ? null : saveButton}<Button loading={busy === "test"} disabled={busy !== null} onClick={(event) => { if (event.currentTarget.closest("form")?.reportValidity()) void save(true); }}>{t("registrationSettings.test")}</Button></div>
        <div className="grid gap-5 lg:grid-cols-2">
            <section className="min-w-0 rounded-xl border border-border p-5"><h2 className="mb-3 text-sm font-semibold text-foreground">{t("registrationSettings.preview")}</h2><pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-4 text-xs leading-6 text-foreground">{JSON.stringify(preview, null, 2)}</pre></section>
            <section className="min-w-0 rounded-xl border border-border p-5"><h2 className="mb-3 text-sm font-semibold text-foreground">{t("registrationSettings.mailPreview")}</h2><p className="whitespace-pre-line text-sm leading-7 text-muted-foreground">{registrationMailText("••••••", config.codeTtlMinutes)}</p></section>
        </div>
        {actionsTarget ? createPortal(saveButton, actionsTarget) : null}
    </form>;
}
