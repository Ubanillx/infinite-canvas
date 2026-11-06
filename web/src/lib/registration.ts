export type RegistrationConfig = {
    allowedDomains: string[];
    codeTtlMinutes: number;
    resendSeconds: number;
    maxAttempts: number;
    hourlyLimit: number;
    smtp: { host: string; port: number; security: "tls" | "starttls"; user: string; password: string; from: string; fromName: string; hasPassword?: boolean };
};

export type RegistrationPolicy = Pick<RegistrationConfig, "allowedDomains" | "resendSeconds" | "codeTtlMinutes"> & { ready: boolean; codeLength: number };

export const defaultRegistrationConfig: RegistrationConfig = {
    allowedDomains: [], codeTtlMinutes: 10, resendSeconds: 60, maxAttempts: 5, hourlyLimit: 5,
    smtp: { host: "", port: 587, security: "starttls", user: "", password: "", from: "", fromName: "无限画布" },
};

export function registrationMailText(code: string, minutes: number) {
    return `你正在注册无限画布。\n\n邮箱验证码：${code}\n\n验证码在 ${minutes} 分钟内有效，仅用于本次注册，请勿向他人透露。\n如果不是你本人操作，请忽略此邮件。`;
}
