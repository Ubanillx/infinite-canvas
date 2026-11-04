import { Home } from "lucide-react";
import { Button } from "antd";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

export default function NotFound() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    return (
        <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
            <main className="flex h-full min-h-0 items-center justify-center overflow-y-auto bg-background px-6 py-10 text-foreground">
                <section className="w-full max-w-md text-center">
                    <div className="mx-auto mb-6 flex size-16 items-center justify-center rounded-lg border border-border bg-card text-2xl font-semibold">404</div>
                    <h1 className="text-3xl font-semibold tracking-normal">{t("notFound.title")}</h1>
                    <p className="mt-3 text-sm leading-6 text-muted-foreground">{t("notFound.description")}</p>
                    <div className="mt-8 flex flex-wrap justify-center gap-3">
                        <Button type="primary" size="large" icon={<Home className="size-4" />} onClick={() => navigate("/")}>{t("notFound.home")}</Button>
                    </div>
                </section>
            </main>
        </div>
    );
}
