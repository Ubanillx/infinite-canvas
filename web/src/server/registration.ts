import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { domainToASCII } from "node:url";
import nodemailer from "nodemailer";
import isEmail from "validator/lib/isEmail.js";
import isFQDN from "validator/lib/isFQDN.js";

import { defaultRegistrationConfig, registrationMailText, type RegistrationConfig, type RegistrationPolicy } from "../lib/registration";
import { execute, getPool, hashToken, newSessionToken, queryMany, queryOne, withTransaction, type SqlExecutor } from "./db";

export class RegistrationError extends Error {
    constructor(message: string, public status = 400, public retryAfter?: number) { super(message); }
}

export function normalizeRegistrationEmail(value: unknown) {
    if (typeof value !== "string" || !isEmail(value.trim())) throw new RegistrationError("请输入有效的工作邮箱");
    const email = value.trim().toLowerCase();
    const at = email.lastIndexOf("@");
    return `${email.slice(0, at)}@${domainToASCII(email.slice(at + 1))}`;
}

export function checkRegistrationDomain(email: string, domains: string[]) {
    if (domains.length && !domains.includes(email.slice(email.lastIndexOf("@") + 1))) throw new RegistrationError("该邮箱域名不在允许注册的范围内", 403);
}

export async function readRegistrationConfig(db?: SqlExecutor): Promise<RegistrationConfig> {
    const row = await queryOne<{ value: RegistrationConfig }>(db || await getPool(), "SELECT value FROM registration_settings WHERE id = 'registration'");
    if (row) return row.value;
    return {
        ...defaultRegistrationConfig, smtp: {
            ...defaultRegistrationConfig.smtp,
            host: process.env.SMTP_HOST || "", port: Number(process.env.SMTP_PORT || 587),
            security: process.env.SMTP_SECURITY === "tls" ? "tls" : "starttls",
            user: process.env.SMTP_USER || "", password: process.env.SMTP_PASSWORD || "",
            from: process.env.SMTP_FROM || "", fromName: process.env.SMTP_FROM_NAME || "无限画布",
        },
    };
}

export function redactRegistrationConfig(config: RegistrationConfig): RegistrationConfig {
    return { ...config, smtp: { ...config.smtp, password: "", hasPassword: Boolean(config.smtp.password) } };
}

export function registrationPolicy(config: RegistrationConfig): RegistrationPolicy {
    const { allowedDomains, resendSeconds, codeTtlMinutes, smtp } = config;
    return { allowedDomains, resendSeconds, codeTtlMinutes, codeLength: 6, ready: Boolean(smtp.host && smtp.from && (!smtp.user || smtp.password)) };
}

export function validateRegistrationConfig(input: unknown, previous: RegistrationConfig): RegistrationConfig {
    if (!input || typeof input !== "object") throw new RegistrationError("注册配置无效");
    const value = input as RegistrationConfig;
    if (!Array.isArray(value.allowedDomains) || value.allowedDomains.some((item) => typeof item !== "string")) throw new RegistrationError("邮箱域名配置无效");
    const allowedDomains = [...new Set(value.allowedDomains.map((item) => domainToASCII(item.trim().toLowerCase())))];
    if (allowedDomains.some((item) => !isFQDN(item))) throw new RegistrationError("请填写完整邮箱域名，不含 @、通配符或网址");
    for (const key of ["codeTtlMinutes", "resendSeconds", "maxAttempts", "hourlyLimit"] as const) {
        if (!Number.isSafeInteger(value[key]) || value[key] <= 0) throw new RegistrationError("验证码限制必须为正整数");
    }
    if (![value.codeTtlMinutes * 60_000, value.resendSeconds * 1000].every((duration) => Number.isFinite(new Date(Date.now() + duration).getTime()) && Number.isFinite(new Date(Date.now() - duration).getTime()))) throw new RegistrationError("验证码有效期或重发间隔超出日期范围");
    const smtp = value.smtp;
    if (!smtp || !["tls", "starttls"].includes(smtp.security) || !Number.isInteger(smtp.port) || smtp.port < 1 || smtp.port > 65535) throw new RegistrationError("SMTP 端口或加密方式无效");
    for (const key of ["host", "user", "password", "from", "fromName"] as const) {
        if (typeof smtp[key] !== "string" || /[\r\n\0]/.test(smtp[key])) throw new RegistrationError("SMTP 配置包含无效字符");
    }
    if (smtp.from.trim()) normalizeRegistrationEmail(smtp.from);
    if (smtp.host.trim() && /[\s/@?#]/.test(smtp.host.trim())) throw new RegistrationError("SMTP 服务器只填写主机名或 IP，不包含协议或路径");
    if (previous.smtp.password && !smtp.password && ["host", "port", "security", "user"].some((key) => smtp[key as keyof typeof smtp] !== previous.smtp[key as keyof typeof smtp])) throw new RegistrationError("修改 SMTP 连接或认证账户时，请重新填写密码或授权码");
    return {
        allowedDomains, codeTtlMinutes: value.codeTtlMinutes, resendSeconds: value.resendSeconds, maxAttempts: value.maxAttempts, hourlyLimit: value.hourlyLimit,
        smtp: { host: smtp.host.trim(), port: smtp.port, security: smtp.security, user: smtp.user.trim(), password: smtp.password || previous.smtp.password, from: smtp.from.trim(), fromName: smtp.fromName.trim() },
    };
}

export async function saveRegistrationConfig(input: unknown) {
    await getPool();
    return withTransaction(async (tx) => {
        await execute(tx, "SELECT pg_advisory_xact_lock(hashtext('infinite-canvas:registration-settings')::bigint)");
        const config = validateRegistrationConfig(input, await readRegistrationConfig(tx));
        await execute(tx, "INSERT INTO registration_settings (id, value) VALUES ('registration', $1::jsonb) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value", JSON.stringify(config));
        return redactRegistrationConfig(config);
    });
}

function smtpTransport(config: RegistrationConfig) {
    if (!registrationPolicy(config).ready) throw new RegistrationError("邮箱服务尚未配置，暂时无法注册", 503);
    const smtp = config.smtp;
    return nodemailer.createTransport({
        host: smtp.host, port: smtp.port, secure: smtp.security === "tls", requireTLS: smtp.security === "starttls",
        auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
        disableFileAccess: true, disableUrlAccess: true,
    });
}

export async function verifyRegistrationSmtp() {
    const transport = smtpTransport(await readRegistrationConfig());
    try { await transport.verify(); }
    catch { throw new RegistrationError("SMTP 连接或认证失败，请检查服务器、加密方式和授权码", 502); }
    finally { transport.close(); }
}

function codeDigest(token: string, email: string, code: string) {
    return createHmac("sha256", token).update(`${email}:${code}`).digest("hex");
}

export async function sendRegistrationCode(value: unknown) {
    const email = normalizeRegistrationEmail(value);
    await getPool();
    return withTransaction(async (tx) => {
        await execute(tx, "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", `registration:${email}`);
        const config = await readRegistrationConfig(tx);
        checkRegistrationDomain(email, config.allowedDomains);
        if (await queryOne(tx, "SELECT 1 FROM users WHERE lower(email) = $1", email)) throw new RegistrationError("该工作邮箱已绑定账户，请直接登录", 409);
        const now = Date.now();
        const recent = await queryMany<{ sent_at: Date }>(tx, "SELECT sent_at FROM registration_email_codes WHERE email = $1 AND sent_at > $2 ORDER BY sent_at DESC", email, new Date(now - Math.max(3600, config.resendSeconds) * 1000).toISOString());
        const lastSent = recent[0]?.sent_at.getTime();
        const retryAfter = lastSent ? Math.ceil((lastSent + config.resendSeconds * 1000 - now) / 1000) : 0;
        if (retryAfter > 0) throw new RegistrationError("发送过于频繁，请稍后重试", 429, retryAfter);
        const hourly = recent.filter((row) => row.sent_at.getTime() > now - 3600_000);
        if (hourly.length >= config.hourlyLimit) throw new RegistrationError("该邮箱已达到每小时发送上限，请稍后重试", 429, Math.ceil((hourly[config.hourlyLimit - 1].sent_at.getTime() + 3600_000 - now) / 1000));
        const token = newSessionToken();
        const code = String(randomInt(1_000_000)).padStart(6, "0");
        const transport = smtpTransport(config);
        try {
            const sent = await transport.sendMail({ from: { address: config.smtp.from, name: config.smtp.fromName }, to: email, subject: "无限画布 · 注册邮箱验证码", text: registrationMailText(code, config.codeTtlMinutes) });
            if (!sent.accepted.length || sent.rejected.length) throw new Error("Mail rejected");
        } catch { throw new RegistrationError("验证码发送失败，请稍后重试或联系管理员", 502); }
        finally { transport.close(); }
        const sentAt = new Date();
        await execute(tx, "UPDATE registration_email_codes SET used_at = $2 WHERE email = $1 AND used_at IS NULL", email, sentAt.toISOString());
        await execute(tx, "INSERT INTO registration_email_codes (id, email, code_hash, expires_at, sent_at) VALUES ($1, $2, $3, $4, $5)", await hashToken(token), email, codeDigest(token, email, code), new Date(sentAt.getTime() + config.codeTtlMinutes * 60_000).toISOString(), sentAt.toISOString());
        return { challengeToken: token, resendAfter: config.resendSeconds, expiresIn: config.codeTtlMinutes * 60 };
    });
}

/** 错误次数通过返回值提交事务；调用者不能在错误结果上抛异常回滚计数。 */
export async function consumeRegistrationCode(tx: SqlExecutor, email: string, token: unknown, code: unknown): Promise<string | null> {
    const config = await readRegistrationConfig(tx);
    checkRegistrationDomain(email, config.allowedDomains);
    if (!registrationPolicy(config).ready) throw new RegistrationError("邮箱服务尚未配置，暂时无法注册", 503);
    if (typeof token !== "string" || !token || typeof code !== "string") return "请先获取并填写邮箱验证码";
    await execute(tx, "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", `registration:${email}`);
    const row = await queryOne<{ code_hash: string; expires_at: Date; used_at: Date | null; attempts: number }>(tx, "SELECT code_hash, expires_at, used_at, attempts FROM registration_email_codes WHERE id = $1 AND email = $2 FOR UPDATE", await hashToken(token), email);
    if (!row || row.used_at || row.expires_at.getTime() <= Date.now()) return "验证码无效或已过期，请重新获取";
    if (row.attempts >= config.maxAttempts) return "验证码错误次数已达上限，请重新获取";
    const actual = Buffer.from(codeDigest(token, email, code.trim()), "hex");
    if (!timingSafeEqual(actual, Buffer.from(row.code_hash, "hex"))) {
        await execute(tx, "UPDATE registration_email_codes SET attempts = attempts + 1, used_at = CASE WHEN attempts + 1 >= $2::numeric THEN now() ELSE used_at END WHERE id = $1", await hashToken(token), config.maxAttempts);
        return row.attempts + 1 >= config.maxAttempts ? "验证码错误次数已达上限，请重新获取" : "邮箱验证码不正确";
    }
    await execute(tx, "UPDATE registration_email_codes SET used_at = now() WHERE id = $1", await hashToken(token));
    return null;
}

export async function verifiedSsoRegistrationEmail(email: unknown, verified: boolean) {
    if (!verified) throw new RegistrationError("请先在 TOPMAX 完成邮箱验证，再重新登录", 403);
    const normalized = normalizeRegistrationEmail(email);
    checkRegistrationDomain(normalized, (await readRegistrationConfig()).allowedDomains);
    return normalized;
}
