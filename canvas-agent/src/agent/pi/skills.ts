import fs from "node:fs/promises";
import path from "node:path";

import { formatSkillsForPrompt, loadSkillsFromDir, parseFrontmatter, stripFrontmatter, type Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { logger } from "../../utils/logger.js";
import { errorMessage } from "../../utils/value.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/** 与 Codex 引擎技能列表保持一致的结构，网页技能页可以直接复用。 */
export type PiSkillSummary = {
    name: string;
    description: string;
    shortDescription?: string | null;
    interface?: { displayName?: string | null; shortDescription?: string | null; defaultPrompt?: string | null } | null;
    path: string;
    scope: "repo";
    enabled: boolean;
    managed: boolean;
};
export type PiSkillDiagnostic = { path: string; message: string };
type DisabledState = { version: 1; disabled: string[] };

const STATE_VERSION = 1;
const STATE_DIRECTORY = ".infinite-canvas";
const STATE_FILE = "pi-skills.json";

/** 站点工作空间里的 Skill 根目录，和画布技能页、Codex 使用同一份文件。 */
export function skillsRoot(cwd: string) {
    return path.join(cwd, ".agents", "skills");
}

/** 读取本地启停状态；文件缺失或损坏时按全部启用处理，不覆盖原文件。 */
async function readDisabled(cwd: string) {
    try {
        const raw = JSON.parse(await fs.readFile(stateFile(cwd), "utf8")) as Partial<DisabledState>;
        return raw.version === STATE_VERSION && Array.isArray(raw.disabled) ? new Set(raw.disabled.filter((name): name is string => typeof name === "string")) : new Set<string>();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") logger.warn("Failed to read pi skill state", { error: errorMessage(error) });
        return new Set<string>();
    }
}

async function writeDisabled(cwd: string, disabled: Set<string>) {
    const file = stateFile(cwd);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const state: DisabledState = { version: STATE_VERSION, disabled: [...disabled].sort() };
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temporary, file);
}

function stateFile(cwd: string) {
    return path.join(cwd, STATE_DIRECTORY, STATE_FILE);
}

/**
 * 扫描当前工作空间的 Skill。
 *
 * 直接使用 pi 官方的 loadSkillsFromDir，因此目录结构、frontmatter 校验、
 * 名称冲突处理和 agentskills.io 标准完全一致；禁用状态由画布自己保存。
 */
export async function loadPiSkills(cwd: string) {
    const result = loadSkillsFromDir({ dir: skillsRoot(cwd), source: "project" });
    const disabled = await readDisabled(cwd);
    const skills = result.skills.map((skill) => ({ ...skill, enabled: !disabled.has(skill.name) }));
    return {
        skills,
        errors: result.diagnostics.flatMap((item): PiSkillDiagnostic[] => (item.path ? [{ path: item.path, message: item.message }] : [])),
    };
}

/** 转换成网页技能页使用的结构。 */
export function piSkillSummaries(skills: Array<Skill & { enabled: boolean }>): PiSkillSummary[] {
    return skills.map((skill) => {
        const extended = skill as Skill & { shortDescription?: string | null; interface?: PiSkillSummary["interface"] };
        return {
            name: skill.name,
            description: skill.description,
            ...(extended.shortDescription ? { shortDescription: extended.shortDescription } : {}),
            ...(extended.interface ? { interface: extended.interface } : {}),
            path: skill.filePath,
            scope: "repo" as const,
            enabled: skill.enabled,
            managed: /[\\/]\.agents[\\/]skills[\\/]/.test(skill.filePath),
        };
    });
}

/** 切换 Skill 启停状态，返回切换后的完整列表。 */
export async function setPiSkillEnabled(cwd: string, name: string, enabled: boolean) {
    const result = await loadPiSkills(cwd);
    if (!result.skills.some((skill) => skill.name === name)) throw new PiSkillError("找不到指定 Skill", 404);
    const disabled = await readDisabled(cwd);
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    await writeDisabled(cwd, disabled);
    return piSkillSummaries(await loadPiSkills(cwd).then((next) => next.skills));
}

/** 带 HTTP 状态码的 Skill 操作错误，由路由统一映射。 */
export class PiSkillError extends Error {
    override name = "PiSkillError";
    constructor(message: string, readonly statusCode: 400 | 404 | 409) {
        super(message);
    }
}

/** 拼接到系统提示词末尾的 Skill 清单；没有可用 Skill 时返回空串。 */
export function skillsPromptBlock(skills: Array<Skill & { enabled: boolean }>) {
    const visible = skills.filter((skill) => skill.enabled && !skill.disableModelInvocation);
    if (!visible.length) return "";
    // 使用官方 XML 结构保证和 agentskills.io 标准一致，再补一句说明实际加载工具名。
    return `${formatSkillsForPrompt(visible, "indirect")}\n\nUse the read_skill tool to load a skill's SKILL.md before following it; pass the skill name exactly as listed above.`;
}

/** 供模型按需加载 SKILL.md 的工具；pi 引擎没有内置 read 工具，因此单独提供。 */
export function createReadSkillTool(skills: Array<Skill & { enabled: boolean }>): AgentTool {
    return {
        name: "read_skill",
        label: "加载 Skill",
        description: "读取指定 Skill 的完整说明。任务匹配某个 Skill 的描述时，先调用本工具加载它，再按其中的步骤执行。",
        parameters: Type.Object({ name: Type.String({ description: "Skill 名称，取自系统提示词中的可用 Skill 列表" }) }),
        execute: async (_toolCallId, params) => {
            const name = String((params as { name?: unknown }).name || "");
            const skill = skills.find((item) => item.name === name && item.enabled);
            if (!skill) return { content: [{ type: "text" as const, text: `找不到可用 Skill：${name}` }], details: { name }, isError: true };
            try {
                const raw = await fs.readFile(skill.filePath, "utf8");
                return { content: [{ type: "text" as const, text: stripFrontmatter(raw).trim() }], details: { name, path: skill.filePath } };
            } catch (error) {
                return { content: [{ type: "text" as const, text: `读取 Skill 失败：${errorMessage(error)}` }], details: { name }, isError: true };
            }
        },
    };
}

/**
 * 解析网页显式选择的 Skill，返回要追加到本轮提示词前的说明。
 *
 * 和 Codex 的 `{type:"skill"}` 输入等价：用户点名某个 Skill 时无条件加载，
 * 不依赖模型自己判断描述是否匹配。
 */
export async function resolveExplicitSkill(cwd: string, selector: { name?: unknown; path?: unknown }) {
    const name = String(selector.name || "");
    const filePath = String(selector.path || "");
    if (!name || !filePath) throw new PiSkillError("Skill 选择无效", 400);
    const { skills } = await loadPiSkills(cwd);
    const skill = skills.find((item) => item.name === name && path.resolve(item.filePath) === path.resolve(filePath));
    if (!skill) throw new PiSkillError("找不到指定 Skill，请刷新列表后重试", 404);
    if (!skill.enabled) throw new PiSkillError("该 Skill 已停用，请先启用后再使用", 409);
    const raw = await fs.readFile(skill.filePath, "utf8");
    const { frontmatter } = parseFrontmatter(raw);
    const display = typeof (frontmatter as Record<string, unknown>).description === "string" ? String((frontmatter as Record<string, unknown>).description) : skill.description;
    return `已加载 Skill：${skill.name}\n说明：${display}\n\n${stripFrontmatter(raw).trim()}`;
}

/** Skill 清单指纹，用于判断运行中的引擎是否需要重建系统提示词。 */
export function skillsFingerprint(skills: Array<Skill & { enabled: boolean }>) {
    return skills.map((skill) => `${skill.name}:${skill.enabled ? 1 : 0}`).join("|");
}
