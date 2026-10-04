// Auth settings shared by the Worker and unit tests (no runtime-only imports).

export function authMode(env: Env): "none" | "github" {
	const mode = (env.AUTH_MODE ?? "").trim().toLowerCase();
	if (mode === "github") return "github";
	if (mode === "" || mode === "none") return "none";
	throw new Error(`Unknown AUTH_MODE "${env.AUTH_MODE}" (expected "none" or "github")`);
}

/** ALLOWED_GITHUB_USERS: comma-separated logins and/or numeric user ids. Empty denies everyone. */
export function isAllowedGitHubUser(allowlist: string | undefined, user: { login: string; id: number }): boolean {
	const entries = (allowlist ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	return entries.some((e) => (/^\d+$/.test(e) ? Number(e) === user.id : e === user.login.toLowerCase()));
}
