import i18n from "@/i18n";
import type { AgentSkillImportFile } from "@/services/api/canvas-agent";

export async function readSkillImportFiles(files: File[], source: "zip" | "folder"): Promise<AgentSkillImportFile[]> {
    let entries: Array<{ path: string; data: Blob }>;
    if (source === "zip") {
        const file = files[0];
        if (!file || !/\.zip$/i.test(file.name)) throw new Error(i18n.t("agent.skillManager.zipRequired"));
        try {
            const { unzip } = await import("fflate");
            const bytes = new Uint8Array(await file.arrayBuffer());
            const unzipped = await new Promise<Record<string, Uint8Array<ArrayBuffer>>>((resolve, reject) => {
                unzip(bytes, (error, data) => error ? reject(error) : resolve(data));
            });
            entries = Object.entries(unzipped).filter(([path]) => !path.endsWith("/")).map(([path, data]) => ({ path, data: new Blob([data]) }));
        } catch {
            throw new Error(i18n.t("agent.skillManager.invalidZip"));
        }
    } else {
        entries = files.map((file) => ({ path: file.webkitRelativePath || file.name, data: file }));
    }
    if (!entries.some((entry) => /(^|[\\/])SKILL\.md$/.test(entry.path) && !entry.path.split(/[\\/]/).includes("__MACOSX"))) throw new Error(i18n.t("agent.skillManager.skillEntryMissing"));
    return Promise.all(entries.map(async ({ path, data }) => ({ path, content: await fileBase64(data) })));
}

function fileBase64(file: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
        reader.onerror = () => reject(new Error(i18n.t("agent.skillManager.importReadFailed")));
        reader.readAsDataURL(file);
    });
}
