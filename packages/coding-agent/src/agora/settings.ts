/**
 * Settings declared by the Agora chat bridge (`ompx agora serve`). `config/all-settings.ts` registers this domain.
 * No settings-panel entries: the daemon is configured in `config.yml` (see docs/agora-bridge.md).
 */
import { register } from "../config/registry";

/** Tilde-prefixed paths are expanded by `loadAgoraEnv`. */
export const cfgAgoraEnvFile = register({
	id: "agora.envFile",
	type: "string",
	default: "~/.config/agora-ompx/env",
});

/** Repository name -> absolute path of the main checkout the bridge may use. */
export const cfgAgoraRepos = register({
	id: "agora.repos",
	type: "record",
	default: {},
});

export const cfgAgoraDefaultRepo = register({
	id: "agora.defaultRepo",
	type: "string",
	default: "",
});

/** Agora usernames allowed to drive sessions; empty = the daemon refuses to start. */
export const cfgAgoraAllowedUsers = register({
	id: "agora.allowedUsers",
	type: "array",
	default: [],
});

export const cfgAgoraMaxSessions = register({
	id: "agora.maxSessions",
	type: "number",
	default: 4,
});

export const cfgAgoraIdleMinutes = register({
	id: "agora.idleMinutes",
	type: "number",
	default: 30,
});

export const cfgAgoraMaxAttachmentMB = register({
	id: "agora.maxAttachmentMB",
	type: "number",
	default: 25,
});
