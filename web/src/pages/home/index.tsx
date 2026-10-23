import { ArrowRight, Image as ImageIcon, Sparkles, Type } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";

import { navigationTools } from "@/constant/navigation-tools";
import { VersionReleaseModal } from "@/components/layout/version-release-modal";
import { HomeAmbientBackground } from "./home-ambient-background";
import orbitalArtwork from "./orbital-artwork.svg";

import "./home.css";

export default function IndexPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [primaryTool] = navigationTools;

    return (
        <main className="home-page">
            <HomeAmbientBackground />
            <section className="home-hero">
                <div className="home-copy">
                    <h1 className={`home-title${t("meta.title").length > 6 ? " home-title-long" : ""}`}>{t("meta.title")}<span className="home-title-period">.</span></h1>
                    <p className="home-tagline">{t("home.tagline")}</p>
                    <p className="home-description">
                        <Trans i18nKey="home.description" components={{ content: <strong /> }} />
                    </p>
                    <div className="home-actions">
                        <button className="home-action-primary" type="button" onClick={() => navigate(`/${primaryTool.slug}`)}>
                            {t("home.start")} <ArrowRight size={18} strokeWidth={1.8} />
                        </button>
                    </div>
                </div>

                <div className="home-art" aria-hidden="true">
                    <div className="home-art-grid" />
                    <div className="home-art-halo" />
                    <svg className="home-connections" viewBox="0 0 680 600" fill="none" preserveAspectRatio="none">
                        <path d="M177 291 C254 291 220 161 327 161 H404" />
                        <path d="M177 291 C254 291 235 426 327 426 H431" />
                        <path d="M474 190 C505 190 491 278 540 278" />
                        <circle cx="177" cy="291" r="5" /><circle cx="404" cy="161" r="5" /><circle cx="431" cy="426" r="5" />
                    </svg>
                    <div className="home-node home-node-source">
                        <div className="home-node-grip"><i /><i /><i /></div>
                        <div className="home-node-source-body"><Sparkles size={27} strokeWidth={1.4} /><span className="home-node-scribble"><i /><i /></span></div>
                    </div>
                    <div className="home-node home-node-image">
                        <div className="home-node-bar"><ImageIcon size={14} strokeWidth={1.7} /><span className="home-node-dots"><i /><i /><i /></span></div>
                        <div className="home-orb"><img src={orbitalArtwork} alt="" draggable={false} /></div>
                        <div className="home-node-footer"><span /><span /><span /></div>
                    </div>
                    <div className="home-node home-node-text">
                        <div className="home-node-bar"><Type size={14} strokeWidth={1.7} /><span className="home-node-dots"><i /><i /><i /></span></div>
                        <div className="home-type-lines"><i /><i /><i /><i /></div>
                    </div>
                    <div className="home-crosshair home-crosshair-one" /><div className="home-crosshair home-crosshair-two" />
                </div>
            </section>
            <footer className="home-footer"><VersionReleaseModal className="home-version" /></footer>
        </main>
    );
}
