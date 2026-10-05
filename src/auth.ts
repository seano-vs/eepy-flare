// Phase 2: OAuth 2.1 in front of /mcp, with GitHub as the upstream login.
//
// This Worker is the authorization server (via @cloudflare/workers-oauth-provider):
// it publishes protected-resource and authorization-server metadata, supports
// dynamic client registration and Client ID Metadata Documents, and requires
// PKCE, which is what claude.ai's custom connector flow needs. Users prove who
// they are by signing in with GitHub, and only accounts in ALLOWED_GITHUB_USERS
// get a token.
//
// Enabled with the var AUTH_MODE="github"; see README "Phase 2".

import {
	AuthorizationError,
	CimdFetchError,
	OAuthProvider,
	authorizationErrorRedirect,
	type AuthRequest,
	type ConsentDescription,
	type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { isAllowedGitHubUser } from "./auth-config";

export { authMode } from "./auth-config";

type Handler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> | Response;

/** Secrets set with `wrangler secret put`; read through this type so `wrangler types` output never conflicts. */
interface AuthSecrets {
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
	/** 32+ random characters; enables "remember this approval" for 30 days. */
	COOKIE_ENCRYPTION_KEY?: string;
	/** Overrides for GitHub Enterprise Server (and local testing). */
	GITHUB_URL?: string;
	GITHUB_API_URL?: string;
}
type AuthEnv = Env & AuthSecrets & { OAUTH_PROVIDER: OAuthHelpers };

export interface GitHubProps {
	login: string;
	id: number;
}

const providers = new Map<string, OAuthProvider<Env>>();

/** One provider per origin, so the advertised resource is this deployment's own /mcp URL. */
export function oauthProviderFor(origin: string, mcp: Handler, site: Handler): OAuthProvider<Env> {
	let p = providers.get(origin);
	if (p) return p;
	p = new OAuthProvider<Env>({
		apiRoute: "/mcp",
		apiHandler: {
			fetch(request, env, ctx) {
				// Re-check the allowlist on every call so removing a user takes effect immediately.
				const props = (ctx as ExecutionContext<GitHubProps>).props;
				if (!props?.login || !isAllowedGitHubUser(env.ALLOWED_GITHUB_USERS, props)) {
					return new Response("Forbidden", { status: 403 });
				}
				return mcp(request, env, ctx);
			},
		},
		defaultHandler: {
			fetch: (request, env, ctx) => authRoutes(request, env as AuthEnv, ctx, site),
		},
		authorizeEndpoint: "/authorize",
		tokenEndpoint: "/token",
		clientRegistrationEndpoint: "/register",
		clientIdMetadataDocumentEnabled: true,
		scopesSupported: ["sleeper:read"],
		resourceMetadata: {
			resource: `${origin}/mcp`,
			authorization_servers: [origin],
			resource_name: "Sleeper fantasy football",
		},
	});
	providers.set(origin, p);
	return p;
}

async function authRoutes(request: Request, env: AuthEnv, ctx: ExecutionContext, site: Handler): Promise<Response> {
	const url = new URL(request.url);
	try {
		if (url.pathname === "/authorize" && request.method === "GET") return await showConsent(request, env);
		if (url.pathname === "/authorize" && request.method === "POST") return await submitConsent(request, env);
		if (url.pathname === "/callback" && request.method === "GET") return await githubCallback(request, env);
	} catch (error) {
		if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
		if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
			const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
			return page("Can't continue", `<p>${escape(message ?? "The request was invalid or expired.")}</p><p>Start the connection again from your app.</p>`, 400);
		}
		throw error;
	}
	return site(request, env, ctx);
}

function githubConfig(env: AuthEnv) {
	// Trim: values pasted into the dashboard often pick up a stray space or newline.
	const clientId = env.GITHUB_CLIENT_ID?.trim();
	const clientSecret = env.GITHUB_CLIENT_SECRET?.trim();
	if (!clientId || !clientSecret) {
		throw new Error("AUTH_MODE=github needs the GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET secrets");
	}
	return {
		clientId,
		clientSecret,
		web: (env.GITHUB_URL || "https://github.com").replace(/\/+$/, ""),
		api: (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, ""),
	};
}

function rememberOptions(env: AuthEnv) {
	const secret = env.COOKIE_ENCRYPTION_KEY;
	return secret && secret.length >= 32 ? { secret } : undefined;
}

// GET /authorize: validate the client's request, then ask for consent (unless remembered).
async function showConsent(request: Request, env: AuthEnv): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const authRequest = await oauth.parseAuthRequest(request);
	const details = await oauth.describeConsent(authRequest);
	const remember = rememberOptions(env);
	if (remember && (await oauth.isConsentRemembered(request, authRequest, remember))) {
		return redirectToGitHub(request, env, authRequest, new Headers());
	}
	const consent = await oauth.beginConsent(authRequest);
	consent.headers.set("Content-Type", "text/html; charset=utf-8");
	return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

// POST /authorize: the user clicked Allow or Deny.
async function submitConsent(request: Request, env: AuthEnv): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const form = await request.formData();
	const handle = String(form.get("handle") ?? "");
	if (form.get("decision") !== "approve") {
		const denied = await oauth.denyConsent(request, handle);
		return new Response(null, { status: 302, headers: denied.headers });
	}
	const remember = rememberOptions(env);
	const approved = await oauth.approveConsent(request, handle, {
		scope: ["sleeper:read"],
		...(remember ? { remember } : {}),
	});
	return redirectToGitHub(request, env, approved.request, approved.headers);
}

async function redirectToGitHub(request: Request, env: AuthEnv, authRequest: AuthRequest, headers: Headers): Promise<Response> {
	const gh = githubConfig(env);
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const upstream = await env.OAUTH_PROVIDER.beginUpstream(authRequest, { data: { verifier }, headers });
	const target = new URL(`${gh.web}/login/oauth/authorize`);
	target.searchParams.set("client_id", gh.clientId);
	target.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
	target.searchParams.set("state", upstream.state);
	target.searchParams.set("allow_signup", "false");
	target.searchParams.set("code_challenge", await s256(verifier));
	target.searchParams.set("code_challenge_method", "S256");
	// No scope: we only need the public profile to learn who signed in.
	upstream.headers.set("Location", target.href);
	return new Response(null, { status: 302, headers: upstream.headers });
}

// GET /callback: GitHub sent the user back. Identify them, enforce the allowlist, issue our grant.
async function githubCallback(request: Request, env: AuthEnv): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const url = new URL(request.url);
	const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);
	const code = url.searchParams.get("code");
	if (url.searchParams.get("error") || !code) {
		headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
		return new Response(null, { status: 302, headers });
	}

	const gh = githubConfig(env);
	const tokenRes = await fetch(`${gh.web}/login/oauth/access_token`, {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: gh.clientId,
			client_secret: gh.clientSecret,
			code,
			redirect_uri: new URL("/callback", request.url).href,
			code_verifier: data.verifier,
		}),
	});
	const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string };
	if (!token.access_token) {
		return page("GitHub sign-in failed", `<p>${escape(token.error ?? `GitHub returned ${tokenRes.status}`)}</p>`, 502);
	}
	const userRes = await fetch(`${gh.api}/user`, {
		headers: {
			authorization: `Bearer ${token.access_token}`,
			accept: "application/vnd.github+json",
			"user-agent": "eepy-flare-sleeper-mcp",
		},
	});
	const user = (await userRes.json().catch(() => null)) as { login?: string; id?: number } | null;
	if (!userRes.ok || !user?.login || typeof user.id !== "number") {
		return page("GitHub sign-in failed", "<p>Could not read your GitHub profile.</p>", 502);
	}
	const props: GitHubProps = { login: user.login, id: user.id };

	if (!isAllowedGitHubUser(env.ALLOWED_GITHUB_USERS, props)) {
		console.warn(`denied GitHub user ${props.login} (${props.id})`);
		headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
		return new Response(null, { status: 302, headers });
	}

	// We keep only who signed in; the GitHub token is not stored.
	const { redirectTo } = await oauth.completeAuthorization({
		request: original,
		userId: String(props.id),
		metadata: { login: props.login },
		scope: original.scope.length ? original.scope : ["sleeper:read"],
		props,
	});
	headers.set("Location", redirectTo);
	return new Response(null, { status: 302, headers });
}

// ---------------------------------------------------------------- HTML

function escape(value: string): string {
	return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function consentPage(d: ConsentDescription, handle: string): string {
	const name = escape(d.clientName);
	const origin = d.clientDomain
		? `Published by <strong>${escape(d.clientDomain)}</strong>.`
		: "This app registered itself, so its name is not verified.";
	const loopback = d.redirectIsLoopback
		? "<p class=warn><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>"
		: "";
	return html(
		`Connect ${name}`,
		`<h1>Allow <em>${name}</em> to read your Sleeper league?</h1>
<p>${origin} Access will be sent to <strong>${escape(d.redirectHost)}</strong>.</p>
${loopback}
<p>Next you'll sign in with GitHub. Only allowlisted accounts can finish.</p>
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <button name="decision" value="approve">Allow</button>
  <button name="decision" value="deny" class=secondary>Deny</button>
</form>`,
	);
}

function page(title: string, body: string, status: number): Response {
	return new Response(html(escape(title), `<h1>${escape(title)}</h1>${body}`), {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'",
			"X-Frame-Options": "DENY",
		},
	});
}

function html(title: string, body: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:light dark;--fg:#1a1a1a;--bg:#fafafa;--accent:#2f6fde;--muted:#666}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--bg:#161616;--accent:#6c9cff;--muted:#aaa}}
body{font:16px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg);max-width:32rem;margin:10vh auto;padding:0 16px}
h1{font-size:1.4rem}button{font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;border:0;background:var(--accent);color:#fff;cursor:pointer;margin-right:.5rem}
button.secondary{background:transparent;color:var(--fg);border:1px solid var(--muted)}.warn{border-left:3px solid #d97706;padding-left:.75rem}
</style></head><body>${body}</body></html>`;
}

// ---------------------------------------------------------------- PKCE

function base64url(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function s256(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64url(new Uint8Array(digest));
}
