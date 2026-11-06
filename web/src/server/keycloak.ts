import * as client from "openid-client";

export type KeycloakTransaction = {
    state: string;
    nonce: string;
    codeVerifier: string;
    redirect: string;
    redirectUri: string;
    mode?: "login" | "bind";
    userId?: string;
};

export type KeycloakProfile = {
    subject: string;
    username: string;
    displayName: string;
    email: string;
    emailVerified: boolean;
};

type Settings = {
    issuer: URL;
    clientId: string;
    clientSecret?: string;
    scopes: string;
    allowInsecure: boolean;
};

function settings(): Settings | null {
    const base = process.env.KEYCLOAK_URL?.trim().replace(/\/+$/, "");
    const realm = process.env.KEYCLOAK_REALM?.trim();
    const clientId = process.env.KEYCLOAK_CLIENT_ID?.trim();
    if (!base || !realm || !clientId) return null;
    try {
        const issuer = new URL(`${base}/realms/${encodeURIComponent(realm)}`);
        if (issuer.protocol !== "https:" && issuer.protocol !== "http:") return null;
        const scopes = (process.env.KEYCLOAK_SCOPES?.trim() || "profile email").split(/\s+/).filter(Boolean);
        return {
            issuer,
            clientId,
            clientSecret: process.env.KEYCLOAK_CLIENT_SECRET?.trim() || undefined,
            scopes: [...new Set(["openid", ...scopes])].join(" "),
            allowInsecure: process.env.KEYCLOAK_ALLOW_INSECURE === "true",
        };
    } catch {
        return null;
    }
}

export function isKeycloakEnabled() {
    return settings() !== null;
}

export function localLoginAllowed() {
    return !isKeycloakEnabled() || process.env.KEYCLOAK_ALLOW_LOCAL_LOGIN === "true";
}

let configuration: Promise<client.Configuration> | undefined;

function keycloakClient(current: Settings) {
    if (configuration) return configuration;
    const pending = client.discovery(
        current.issuer,
        current.clientId,
        current.clientSecret,
        undefined,
        current.allowInsecure ? { execute: [client.allowInsecureRequests] } : undefined,
    );
    configuration = pending;
    pending.catch(() => {
        if (configuration === pending) configuration = undefined;
    });
    return pending;
}

function configuredUrl(name: string) {
    const value = process.env[name]?.trim();
    if (!value) return "";
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
    } catch {
        return "";
    }
}

export function keycloakRedirectUrl(origin: string) {
    return configuredUrl("KEYCLOAK_REDIRECT_URI") || `${origin}/api/auth/keycloak/callback`;
}

export function keycloakPostLogoutRedirectUrl(origin: string) {
    return configuredUrl("KEYCLOAK_POST_LOGOUT_REDIRECT_URI") || `${origin}/`;
}

export async function createKeycloakAuthorization(origin: string, redirect: string, mode: "login" | "bind" = "login", bindUserId?: string) {
    const current = settings();
    if (!current) throw new Error("Keycloak is not configured");
    const config = await keycloakClient(current);
    const state = client.randomState();
    const nonce = client.randomNonce();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const redirectUri = keycloakRedirectUrl(origin);
    const url = client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: current.scopes,
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
    });
    return { url, transaction: { state, nonce, codeVerifier, redirect, redirectUri, mode, userId: mode === "bind" ? bindUserId : undefined } satisfies KeycloakTransaction };
}

export async function completeKeycloakAuthorization(callbackUrl: URL, transaction: KeycloakTransaction) {
    const current = settings();
    if (!current) throw new Error("Keycloak is not configured");
    const config = await keycloakClient(current);
    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: transaction.codeVerifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error("Keycloak did not return an ID token");
    return { claims, idToken: tokens.id_token ?? "" };
}

function claimString(claims: client.IDToken, key: string) {
    const value = claims[key];
    return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function keycloakProfile(claims: client.IDToken): KeycloakProfile | null {
    const subject = claimString(claims, "sub");
    if (!subject) return null;
    const username = claimString(claims, "preferred_username") || claimString(claims, "email") || subject;
    return { subject, username, displayName: claimString(claims, "name") || username, email: claimString(claims, "email"), emailVerified: claims.email_verified === true || claims.email_verified === "true" };
}

export async function keycloakLogoutUrl(origin: string, idToken: string) {
    const current = settings();
    if (!current) return null;
    const config = await keycloakClient(current);
    return client.buildEndSessionUrl(config, {
        id_token_hint: idToken,
        post_logout_redirect_uri: keycloakPostLogoutRedirectUrl(origin),
    }).href;
}
