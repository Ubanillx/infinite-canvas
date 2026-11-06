import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { Pool } from "pg";

import { defaultRegistrationConfig } from "../src/lib/registration";
import { bindSsoIdentity, execute, getPool, queryOne, unbindSsoIdentity, withTransaction } from "../src/server/db";
import { checkRegistrationDomain, consumeRegistrationCode, normalizeRegistrationEmail, readRegistrationConfig, redactRegistrationConfig, registrationPolicy, saveRegistrationConfig, sendRegistrationCode, validateRegistrationConfig, verifiedSsoRegistrationEmail } from "../src/server/registration";

const config = () => ({ ...structuredClone(defaultRegistrationConfig), allowedDomains: ["company.test"], smtp: { host: "smtp.company.test", port: 587, security: "starttls" as const, user: "sender", password: randomUUID(), from: "sender@company.test", fromName: "Canvas" } });

async function rejected(promise: Promise<unknown>) {
    try { await promise; } catch (error) { return error; }
    throw new Error("Expected this request to be rejected");
}

test("work email validation and domain restrictions use exact normalized domains", () => {
    expect(normalizeRegistrationEmail(" Person@COMPANY.TEST ")).toBe("person@company.test");
    expect(() => checkRegistrationDomain("person@company.test", ["company.test"])).not.toThrow();
    for (const email of ["person@sub.company.test", "person@evilcompany.test", "person@company.test.evil.test"]) expect(() => checkRegistrationDomain(email, ["company.test"])).toThrow();
    expect(() => normalizeRegistrationEmail("Name <person@company.test>")).toThrow();
    expect(() => normalizeRegistrationEmail("person@company.test\r\nBcc: victim@other.test")).toThrow();
    expect(() => checkRegistrationDomain("person@other.test", [])).not.toThrow();
});

test("SMTP secrets stay redacted and invalid policy updates are rejected", () => {
    const saved = config();
    expect(redactRegistrationConfig(saved).smtp).toMatchObject({ password: "", hasPassword: true });
    expect(JSON.stringify(redactRegistrationConfig(saved))).not.toContain(saved.smtp.password);
    expect(validateRegistrationConfig({ ...saved, smtp: { ...saved.smtp, password: "" } }, saved).smtp.password).toBe(saved.smtp.password);
    expect(() => validateRegistrationConfig({ ...saved, smtp: { ...saved.smtp, password: "", host: "other.test" } }, saved)).toThrow();
    expect(validateRegistrationConfig({ ...saved, allowedDomains: ["COMPANY.TEST", "company.test"] }, saved).allowedDomains).toEqual(["company.test"]);
    for (const domain of ["*.company.test", "@company.test", "https://company.test"]) expect(() => validateRegistrationConfig({ ...saved, allowedDomains: [domain] }, saved)).toThrow();
    for (const key of ["codeTtlMinutes", "resendSeconds", "maxAttempts", "hourlyLimit"]) for (const value of [0, -1, 1.5, Infinity]) expect(() => validateRegistrationConfig({ ...saved, [key]: value }, saved)).toThrow();
    expect(registrationPolicy(defaultRegistrationConfig).ready).toBe(false);
});

const testDatabaseUrl = process.env.REGISTRATION_TEST_DATABASE_URL;
describe.skipIf(!testDatabaseUrl)("registration verification in an isolated PostgreSQL schema", () => {
    const schema = `registration_test_${randomUUID().replaceAll("-", "")}`;
    const originalUrl = process.env.DATABASE_URL;
    let admin: Pool;
    let latestCode = "";
    let deliveryFails = false;
    let deliveries = 0;
    let restoreMailer: () => void;
    let jsonMailer: ReturnType<typeof nodemailer.createTransport>;

    beforeAll(async () => {
        admin = new Pool({ connectionString: testDatabaseUrl });
        await admin.query(`CREATE SCHEMA "${schema}"`);
        const url = new URL(testDatabaseUrl!);
        url.searchParams.set("options", `-c search_path=${schema}`);
        process.env.DATABASE_URL = url.href;
        await getPool();
        jsonMailer = nodemailer.createTransport({ jsonTransport: true });
        const mock = spyOn(nodemailer, "createTransport").mockImplementation(() => ({
            sendMail: async (mail: nodemailer.SendMailOptions) => {
                if (deliveryFails) throw new Error("Simulated SMTP failure");
                const message = await jsonMailer.sendMail(mail);
                const text = JSON.parse(String(message.message)).text as string;
                latestCode = text.match(/邮箱验证码：(\d{6})/)![1];
                deliveries++;
                return { accepted: [mail.to], rejected: [] };
            }, close: () => undefined,
        }) as ReturnType<typeof nodemailer.createTransport>);
        restoreMailer = () => mock.mockRestore();
    });

    beforeEach(async () => {
        await execute(await getPool(), "DELETE FROM registration_email_codes");
        await saveRegistrationConfig(config());
        deliveryFails = false;
        deliveries = 0;
    });

    afterAll(async () => {
        restoreMailer?.();
        jsonMailer?.close();
        // 仅清理本测试创建的随机 schema；不会访问 public 或用户工作区。
        if (admin && /^registration_test_[a-f0-9]+$/.test(schema)) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
        if (originalUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalUrl;
    });

    const consume = (email: string, token: string, code: string) => withTransaction((tx) => consumeRegistrationCode(tx, email, token, code));

    test("codes are bound to their mailbox and consumed once, including concurrent submissions", async () => {
        const sent = await sendRegistrationCode("person@company.test");
        const code = latestCode;
        expect(sent).toMatchObject({ resendAfter: 60, expiresIn: 600 });
        expect(await consume("other@company.test", sent.challengeToken, code)).toBeTruthy();
        const outcomes = await Promise.all([consume("person@company.test", sent.challengeToken, code), consume("person@company.test", sent.challengeToken, code)]);
        expect(outcomes.filter((value) => value === null)).toHaveLength(1);
        const row = await queryOne<{ code_hash: string }>(await getPool(), "SELECT code_hash FROM registration_email_codes LIMIT 1");
        expect(row!.code_hash).not.toBe(code);
        expect(JSON.stringify(row)).not.toContain(sent.challengeToken);
    });

    test("incorrect attempts persist through requests and the fifth invalidates the code", async () => {
        const sent = await sendRegistrationCode("person@company.test");
        const code = latestCode;
        const wrong = code === "000000" ? "000001" : "000000";
        for (let i = 0; i < 5; i++) expect(await consume("person@company.test", sent.challengeToken, wrong)).toBeTruthy();
        expect(await consume("person@company.test", sent.challengeToken, code)).toBeTruthy();
        expect((await queryOne<{ attempts: number }>(await getPool(), "SELECT attempts FROM registration_email_codes LIMIT 1"))!.attempts).toBe(5);
    });

    test("expiry and resend rules reject stale codes; concurrent resends send only one email", async () => {
        const sent = await sendRegistrationCode("person@company.test");
        const oldCode = latestCode;
        const cooldown = await sendRegistrationCode("person@company.test").catch((reason) => reason);
        expect(cooldown.status).toBe(429);
        expect(cooldown.retryAfter).toBeGreaterThan(0);
        await execute(await getPool(), "UPDATE registration_email_codes SET sent_at = now() - interval '2 minutes', expires_at = now() - interval '1 second'");
        expect(await consume("person@company.test", sent.challengeToken, oldCode)).toBeTruthy();
        const resends = await Promise.allSettled([sendRegistrationCode("person@company.test"), sendRegistrationCode("person@company.test")]);
        expect(resends.filter((value) => value.status === "fulfilled")).toHaveLength(1);
        expect(deliveries).toBe(2);
        expect(await consume("person@company.test", sent.challengeToken, oldCode)).toBeTruthy();
    });

    test("successful resend invalidates an unexpired code", async () => {
        const first = await sendRegistrationCode("person@company.test");
        const oldCode = latestCode;
        await execute(await getPool(), "UPDATE registration_email_codes SET sent_at = now() - interval '2 minutes'");
        const next = await sendRegistrationCode("person@company.test");
        expect(await consume("person@company.test", first.challengeToken, oldCode)).toBeTruthy();
        expect(await consume("person@company.test", next.challengeToken, latestCode)).toBeNull();
    });

    test("failed delivery preserves the current code and does not consume successful-send quota", async () => {
        const first = await sendRegistrationCode("person@company.test");
        const code = latestCode;
        await execute(await getPool(), "UPDATE registration_email_codes SET sent_at = now() - interval '2 minutes'");
        deliveryFails = true;
        expect(await rejected(sendRegistrationCode("person@company.test"))).toMatchObject({ status: 502 });
        expect((await queryOne<{ count: number }>(await getPool(), "SELECT count(*)::int AS count FROM registration_email_codes"))!.count).toBe(1);
        expect(await consume("person@company.test", first.challengeToken, code)).toBeNull();
    });

    test("hourly quota and changed domain or attempt policies are applied server-side", async () => {
        for (let i = 0; i < 5; i++) { await sendRegistrationCode("person@company.test"); await execute(await getPool(), "UPDATE registration_email_codes SET sent_at = sent_at - interval '2 minutes'"); }
        expect(await rejected(sendRegistrationCode("person@company.test"))).toMatchObject({ status: 429 });
        const updated = await saveRegistrationConfig({ ...config(), hourlyLimit: 6, maxAttempts: 1 });
        expect(updated.smtp.password).toBe("");
        const sent = await sendRegistrationCode("person@company.test");
        const code = latestCode;
        expect(await consume("person@company.test", sent.challengeToken, code === "000000" ? "000001" : "000000")).toContain("上限");
        await saveRegistrationConfig({ ...config(), allowedDomains: ["other.test"] });
        expect(await rejected(consume("person@company.test", sent.challengeToken, code))).toMatchObject({ status: 403 });
        expect((await readRegistrationConfig()).allowedDomains).toEqual(["other.test"]);
    });

    test("SSO provisioning requires a verified email and follows domain policy", async () => {
        expect(await rejected(verifiedSsoRegistrationEmail("person@company.test", false))).toBeInstanceOf(Error);
        expect(await rejected(verifiedSsoRegistrationEmail("person@other.test", true))).toBeInstanceOf(Error);
        expect(await verifiedSsoRegistrationEmail("PERSON@COMPANY.TEST", true)).toBe("person@company.test");
    });

    test("rejected domains and an already-bound email cannot send verification emails", async () => {
        expect(await rejected(sendRegistrationCode("person@other.test"))).toMatchObject({ status: 403 });
        await execute(await getPool(), "INSERT INTO users (id, username, display_name, password_hash, email, email_verified_at, created_at) VALUES ($1, $1, 'Bound', '', 'bound@company.test', now(), now())", randomUUID());
        expect(await rejected(sendRegistrationCode("BOUND@company.test"))).toMatchObject({ status: 409 });
        expect(deliveries).toBe(0);
    });

    test("failed account creation rolls back code consumption so the user can retry", async () => {
        const sent = await sendRegistrationCode("person@company.test");
        const code = latestCode;
        expect(await rejected(withTransaction(async (tx) => {
            expect(await consumeRegistrationCode(tx, "person@company.test", sent.challengeToken, code)).toBeNull();
            throw new Error("Simulated account creation failure");
        }))).toMatchObject({ message: "Simulated account creation failure" });
        expect(await consume("person@company.test", sent.challengeToken, code)).toBeNull();
    });

    test("SSO binding requires the same verified email and one identity per user", async () => {
        const userId = randomUUID();
        const email = `binding-${randomUUID()}@company.test`;
        const username = `binding-${randomUUID()}`;
        await execute(await getPool(), "INSERT INTO users (id, username, display_name, password_hash, email, email_verified_at, created_at) VALUES ($1,$2,'Binding user','hash',$3,now(),now())", userId, username, email);
        const identity = { provider: "keycloak", subject: `subject-${randomUUID()}`, username, displayName: "Binding user", email, emailVerified: true };
        await bindSsoIdentity(userId, identity);
        const row = await queryOne<{ email: string; last_login_at: Date }>(await getPool(), "SELECT email, last_login_at FROM user_identities WHERE user_id = $1 AND provider = 'keycloak'", userId);
        expect(row?.email).toBe(email);
        expect(row?.last_login_at).toBeTruthy();
        await bindSsoIdentity(userId, identity);
        expect((await queryOne<{ count: number }>(await getPool(), "SELECT count(*)::int AS count FROM user_identities WHERE user_id = $1", userId))!.count).toBe(1);
        expect(await rejected(bindSsoIdentity(userId, { ...identity, subject: `subject-${randomUUID()}` }))).toMatchObject({ code: "already_bound" });
        const otherUserId = randomUUID();
        await execute(await getPool(), "INSERT INTO users (id, username, display_name, password_hash, email, email_verified_at, created_at) VALUES ($1,$2,'Other user','hash',$3,now(),now())", otherUserId, `other-${randomUUID()}`, `other-${randomUUID()}@company.test`);
        expect(await rejected(bindSsoIdentity(otherUserId, identity))).toMatchObject({ code: "identity_taken" });
        const mismatchUserId = randomUUID();
        await execute(await getPool(), "INSERT INTO users (id, username, display_name, password_hash, email, email_verified_at, created_at) VALUES ($1,$2,'Mismatch user','hash',$3,now(),now())", mismatchUserId, `mismatch-${randomUUID()}`, `mismatch-${randomUUID()}@company.test`);
        expect(await rejected(bindSsoIdentity(mismatchUserId, { ...identity, subject: `subject-${randomUUID()}` }))).toMatchObject({ code: "email_mismatch" });
        const unverifiedUserId = randomUUID();
        await execute(await getPool(), "INSERT INTO users (id, username, display_name, password_hash, email, email_verified_at, created_at) VALUES ($1,$2,'Unverified user','hash',NULL,NULL,now())", unverifiedUserId, `unverified-${randomUUID()}`);
        expect(await rejected(bindSsoIdentity(unverifiedUserId, { ...identity, subject: `subject-${randomUUID()}` }))).toMatchObject({ code: "local_email_missing" });
        const unverifiedSsoUserId = randomUUID();
        const unverifiedSsoEmail = `unverified-sso-${randomUUID()}@company.test`;
        await execute(await getPool(), "INSERT INTO users (id, username, display_name, password_hash, email, email_verified_at, created_at) VALUES ($1,$2,'Unverified SSO user','hash',$3,now(),now())", unverifiedSsoUserId, `unverified-sso-${randomUUID()}`, unverifiedSsoEmail);
        expect(await rejected(bindSsoIdentity(unverifiedSsoUserId, { ...identity, subject: `subject-${randomUUID()}`, email: unverifiedSsoEmail, emailVerified: false }))).toMatchObject({ code: "email_unverified" });
        await unbindSsoIdentity(await getPool(), userId, "keycloak");
        expect((await queryOne<{ count: number }>(await getPool(), "SELECT count(*)::int AS count FROM user_identities WHERE user_id = $1", userId))!.count).toBe(0);
    });

    test("SSO binding compares verified emails without case sensitivity", async () => {
        const userId = randomUUID();
        const email = `case-${randomUUID()}@company.test`;
        await execute(await getPool(), "INSERT INTO users (id, username, display_name, password_hash, email, email_verified_at, created_at) VALUES ($1,$2,'Case user','hash',$3,now(),now())", userId, `case-${randomUUID()}`, email);
        await bindSsoIdentity(userId, { provider: "keycloak", subject: `subject-${randomUUID()}`, username: "case", displayName: "Case user", email: email.toUpperCase(), emailVerified: true });
        expect((await queryOne<{ count: number }>(await getPool(), "SELECT count(*)::int AS count FROM user_identities WHERE user_id = $1", userId))!.count).toBe(1);
    });

    test("SSO binding rejects a profile without an email", async () => {
        const userId = randomUUID();
        const email = `no-sso-email-${randomUUID()}@company.test`;
        await execute(await getPool(), "INSERT INTO users (id, username, display_name, password_hash, email, email_verified_at, created_at) VALUES ($1,$2,'No SSO email','hash',$3,now(),now())", userId, `no-sso-email-${randomUUID()}`, email);
        expect(await rejected(bindSsoIdentity(userId, { provider: "keycloak", subject: `subject-${randomUUID()}`, username: "no-email", displayName: "No SSO email", emailVerified: true }))).toMatchObject({ code: "email_missing" });
    });

    test("SSO binding distinguishes a missing email verification claim", async () => {
        const userId = randomUUID();
        const email = `missing-claim-${randomUUID()}@company.test`;
        await execute(await getPool(), "INSERT INTO users (id, username, display_name, password_hash, email, email_verified_at, created_at) VALUES ($1,$2,'Missing claim','hash',$3,now(),now())", userId, `missing-claim-${randomUUID()}`, email);
        expect(await rejected(bindSsoIdentity(userId, { provider: "keycloak", subject: `subject-${randomUUID()}`, username: "missing-claim", displayName: "Missing claim", email, emailVerified: false, emailVerifiedMissing: true }))).toMatchObject({ code: "email_verified_missing" });
    });

    test("SSO binding rejects a local email without verification", async () => {
        const userId = randomUUID();
        const email = `unverified-${randomUUID()}@company.test`;
        await execute(await getPool(), "INSERT INTO users (id, username, display_name, password_hash, email, email_verified_at, created_at) VALUES ($1,$2,'Unverified user','hash',$3,NULL,now())", userId, `unverified-${randomUUID()}`, email);
        expect(await rejected(bindSsoIdentity(userId, { provider: "keycloak", subject: `subject-${randomUUID()}`, username: "unverified", displayName: "Unverified user", email, emailVerified: true }))).toMatchObject({ code: "local_email_missing" });
    });

    test("concurrent binding of one SSO identity yields a single owner", async () => {
        const email = `race-${randomUUID()}@company.test`;
        const firstUserId = randomUUID();
        const secondUserId = randomUUID();
        await execute(await getPool(), "INSERT INTO users (id, username, display_name, password_hash, email, email_verified_at, created_at) VALUES ($1,$2,'Race owner','hash',$3,now(),now())", firstUserId, `race-${randomUUID()}`, email);
        await execute(await getPool(), "INSERT INTO users (id, username, display_name, password_hash, email, email_verified_at, created_at) VALUES ($1,$2,'Race other','hash',$3,now(),now())", secondUserId, `race-other-${randomUUID()}`, `race-other-${randomUUID()}@company.test`);
        const identity = { provider: "keycloak", subject: `subject-${randomUUID()}`, username: "race", displayName: "Race user", email, emailVerified: true };
        const results = await Promise.allSettled([bindSsoIdentity(firstUserId, identity), bindSsoIdentity(secondUserId, identity)]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        const owner = await queryOne<{ user_id: string }>(await getPool(), "SELECT user_id FROM user_identities WHERE provider = $1 AND subject = $2", identity.provider, identity.subject);
        expect([firstUserId, secondUserId]).toContain(owner!.user_id);
    });
});
