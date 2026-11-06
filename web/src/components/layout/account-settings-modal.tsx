import { useEffect, useState } from "react";
import { App, Button, Modal, Tag } from "antd";
import { AlertCircle, Check, Info, ShieldCheck, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getWorkspaceSession, keycloakBindUrl, unbindKeycloakIdentity, type WorkspaceSession } from "@/services/api/workspace-auth";

export function AccountSettingsModal({ open, onClose, errorNotice }: { open: boolean; onClose: () => void; errorNotice?: string }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [session, setSession] = useState<WorkspaceSession | null>(null);
    const [loading, setLoading] = useState(open);
    const [error, setError] = useState("");
    const [bindOpen, setBindOpen] = useState(false);
    const [unbindOpen, setUnbindOpen] = useState(false);
    const [unbinding, setUnbinding] = useState(false);

    const load = async () => {
        setLoading(true);
        setError("");
        try {
            setSession(await getWorkspaceSession());
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t("accountSettings.loadFailed"));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (!open) {
            setBindOpen(false);
            setUnbindOpen(false);
            return;
        }
        setSession(null);
        void load();
    }, [open]);

    const user = session?.user;
    const identity = session?.identities?.find((item) => item.provider === "keycloak");
    const keycloakEnabled = Boolean(session?.keycloak?.enabled);
    const localLoginEnabled = session?.keycloak?.localLogin ?? true;
    const canBind = keycloakEnabled && Boolean(user?.email && user.emailVerifiedAt);
    const canUnbind = Boolean(identity) && localLoginEnabled && Boolean(user?.hasPassword);
    const unbindReason = !localLoginEnabled ? t("accountSettings.unbindDisabledSsoOnly") : t("accountSettings.unbindDisabledNoPassword");

    const bind = () => {
        if (!canBind) return;
        window.location.assign(keycloakBindUrl(`${window.location.pathname}${window.location.search}`));
    };

    const unbind = async () => {
        setUnbinding(true);
        try {
            await unbindKeycloakIdentity();
            setUnbindOpen(false);
            await load();
            message.success(t("accountSettings.unbindSuccess"));
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : t("accountSettings.unbindFailed"));
        } finally {
            setUnbinding(false);
        }
    };

    const initials = (user?.displayName || user?.username || "?").trim().slice(0, 1);
    const showLoading = loading || (!session && !error);

    return (
        <>
            <Modal
                title={t("accountSettings.title")}
                open={open}
                onCancel={onClose}
                footer={null}
                width={560}
                destroyOnHidden
                styles={{ container: { boxShadow: "none", border: "1px solid var(--border)" } }}
            >
                {errorNotice ? <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm leading-6 text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" />{t(`accountSettings.errors.${errorNotice}`)}</div> : null}
                {showLoading ? <p role="status" className="py-10 text-center text-sm text-muted-foreground">{t("accountSettings.loading")}</p> : null}
                {!showLoading && error ? <div className="space-y-4 py-6 text-center"><p role="alert" className="text-sm text-destructive">{error}</p><Button onClick={() => void load()}>{t("accountSettings.retry")}</Button></div> : null}
                {!showLoading && !error && !user ? <div className="space-y-4 py-6 text-center"><p role="alert" className="text-sm text-destructive">{t("accountSettings.sessionExpired")}</p><div className="flex justify-center gap-2"><Button onClick={onClose}>{t("accountSettings.done")}</Button><Button type="primary" onClick={() => window.location.reload()}>{t("accountSettings.signInAgain")}</Button></div></div> : null}
                {!showLoading && !error && user ? <div className="space-y-5 pt-1">
                    <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 p-4">
                        <div className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">{initials}</div>
                        <div className="min-w-0">
                            <div className="truncate text-sm font-semibold">{user.displayName}</div>
                            <div className="mt-0.5 truncate text-xs text-muted-foreground">@{user.username}{user.email ? ` · ${user.email}` : ""}</div>
                        </div>
                    </div>
                    <div>
                        <div className="mb-2 text-xs font-medium text-muted-foreground">{t("accountSettings.loginMethods")}</div>
                        <div className="overflow-hidden rounded-xl border border-border">
                            <div className="flex items-center gap-3 p-4">
                                <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted"><UserRound className="size-4" /></div>
                                <div className="min-w-0 flex-1"><div className="text-sm font-medium">{t("accountSettings.localTitle")}</div><div className="mt-0.5 truncate text-xs text-muted-foreground">{user.username}</div></div>
                                <span className="shrink-0 text-xs text-muted-foreground">{user.hasPassword ? <span className="inline-flex items-center gap-1"><Check className="size-3.5" />{t("accountSettings.localPasswordSet")}</span> : t("accountSettings.localPasswordMissing")}</span>
                            </div>
                            <div className="border-t border-border">
                                <div className="flex items-center gap-3 p-4">
                                    <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted"><ShieldCheck className="size-4" /></div>
                                    <div className="min-w-0 flex-1">
                                        <div className="text-sm font-medium">{t("accountSettings.topmaxTitle")}</div>
                                        <div className="mt-0.5 break-all text-xs text-muted-foreground">{identity ? identity.email || identity.displayName || t("accountSettings.bound") : !keycloakEnabled ? t("accountSettings.topmaxDisabled") : t("accountSettings.unboundHint")}</div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
                                        {identity ? <Tag color="success" className="m-0">{t("accountSettings.bound")}</Tag> : null}
                                        {identity ? <Button type="text" danger size="small" disabled={!canUnbind} title={!canUnbind ? unbindReason : undefined} onClick={() => setUnbindOpen(true)}>{t("accountSettings.unbind")}</Button> : null}
                                        {!identity && keycloakEnabled ? <Button type="primary" size="small" disabled={!canBind} title={!canBind ? t("accountSettings.verifyEmailFirst") : undefined} onClick={() => setBindOpen(true)}>{t("accountSettings.bind")}</Button> : null}
                                    </div>
                                </div>
                                {identity && !canUnbind ? <p className="px-4 pb-4 text-xs leading-5 text-muted-foreground">{unbindReason}</p> : null}
                                {!identity && keycloakEnabled && !canBind ? <p className="px-4 pb-4 text-xs leading-5 text-muted-foreground">{t("accountSettings.verifyEmailFirst")}</p> : null}
                            </div>
                        </div>
                    </div>
                    <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" />{t("accountSettings.bindHint")}</p>
                    <div className="flex justify-end border-t border-border pt-4"><Button onClick={onClose}>{t("accountSettings.done")}</Button></div>
                </div> : null}
            </Modal>
            <Modal
                title={t("accountSettings.bindTitle")}
                open={bindOpen}
                onCancel={() => setBindOpen(false)}
                onOk={bind}
                okText={t("accountSettings.bindConfirm")}
                cancelText={t("common.cancel")}
                width={460}
                styles={{ container: { boxShadow: "none", border: "1px solid var(--border)" } }}
            >
                <p className="text-sm leading-6 text-muted-foreground">{t("accountSettings.bindDescription")}</p>
                <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
                    <li className="flex items-start gap-2"><Check className="mt-0.5 size-4 shrink-0" />{t("accountSettings.bindEffectAccount")}</li>
                    <li className="flex items-start gap-2"><Check className="mt-0.5 size-4 shrink-0" />{t("accountSettings.bindEffectLocal")}</li>
                    <li className="flex items-start gap-2"><Check className="mt-0.5 size-4 shrink-0" />{t("accountSettings.bindEffectEmail")}</li>
                </ul>
            </Modal>
            <Modal
                title={t("accountSettings.unbindTitle")}
                open={unbindOpen}
                onCancel={() => setUnbindOpen(false)}
                onOk={() => void unbind()}
                confirmLoading={unbinding}
                okText={t("accountSettings.unbindConfirm")}
                cancelText={t("common.cancel")}
                okButtonProps={{ danger: true }}
                width={420}
                styles={{ container: { boxShadow: "none", border: "1px solid var(--border)" } }}
            >
                <p className="text-sm leading-6 text-muted-foreground">{t("accountSettings.unbindDescription")}</p>
            </Modal>
        </>
    );
}
