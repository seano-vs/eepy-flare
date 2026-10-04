import { describe, expect, it } from "vitest";
import { authMode, isAllowedGitHubUser } from "../src/auth-config";

describe("isAllowedGitHubUser", () => {
	const sean = { login: "Seano-VS", id: 1234 };
	it("matches logins case-insensitively and numeric ids exactly", () => {
		expect(isAllowedGitHubUser("seano-vs", sean)).toBe(true);
		expect(isAllowedGitHubUser(" someone , 1234 ", sean)).toBe(true);
		expect(isAllowedGitHubUser("12345", sean)).toBe(false);
		expect(isAllowedGitHubUser("seano", sean)).toBe(false);
	});
	it("denies everyone when the allowlist is empty", () => {
		expect(isAllowedGitHubUser("", sean)).toBe(false);
		expect(isAllowedGitHubUser(undefined, sean)).toBe(false);
		expect(isAllowedGitHubUser(" , ", sean)).toBe(false);
	});
});

describe("authMode", () => {
	const env = (AUTH_MODE: string) => ({ AUTH_MODE }) as unknown as Env;
	it("defaults to authless and rejects typos", () => {
		expect(authMode(env(""))).toBe("none");
		expect(authMode(env("GitHub"))).toBe("github");
		expect(() => authMode(env("gihtub"))).toThrow(/Unknown AUTH_MODE/);
	});
});
