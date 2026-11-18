import * as os from "node:os";
import { getAgentDir, getProjectDir, logger, postmortem } from "@oh-my-pi/pi-utils";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { agoraHelp as commandHelp } from "../cli/command-help";
import { Settings } from "../config/settings";
import { AgoraClient, loadAgoraEnv } from "../agora/client";
import { AgoraDaemon } from "../agora/daemon";
import {
	cfgAgoraAllowedUsers,
	cfgAgoraDefaultRepo,
	cfgAgoraEnvFile,
	cfgAgoraIdleMinutes,
	cfgAgoraMaxAttachmentMB,
	cfgAgoraMaxSessions,
	cfgAgoraRepos,
} from "../agora/settings";
import { SessionHost } from "../agora/session-host";
import { AgoraStore, defaultAgoraStorePath } from "../agora/store";
import { currentOmpxBaseCommand } from "../task/omp-command";

export default class Agora extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Agora action",
			required: false,
			options: ["serve"],
		}),
	};
	static flags = {
		once: Flags.boolean({ description: "Handle the first message that reaches a session, then exit" }),
		env: Flags.string({ description: "Agora identity file (overrides agora.envFile); run one daemon per workspace" }),
		repo: Flags.string({ description: "Default repository for new chats (overrides agora.defaultRepo)" }),
	};
	static examples = ["ompx agora serve", "ompx agora serve --env ~/.config/agora-ompx/env-bynai --repo bynai"];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Agora);
		if (args.action !== "serve") throw new CliUsageError("Usage: ompx agora serve [--once]");

		const settings = await Settings.init({ cwd: getProjectDir() });
		const envFile = (flags.env ?? cfgAgoraEnvFile.get(settings)).replace(/^~(?=\/)/, os.homedir());
		const env = await loadAgoraEnv(envFile);
		const store = new AgoraStore(defaultAgoraStorePath(flags.env ? env.workspace : undefined));
		const base = currentOmpxBaseCommand([], {});
		const daemon = new AgoraDaemon({
			client: new AgoraClient(env),
			store,
			settings: {
				repos: cfgAgoraRepos.get(settings),
				defaultRepo: flags.repo ?? cfgAgoraDefaultRepo.get(settings),
				allowedUsers: [...cfgAgoraAllowedUsers.get(settings)],
				maxSessions: cfgAgoraMaxSessions.get(settings),
				idleMinutes: cfgAgoraIdleMinutes.get(settings),
				maxAttachmentMB: cfgAgoraMaxAttachmentMB.get(settings),
			},
			createHost: options => new SessionHost({ ...options, envFile, command: [base.cmd, ...base.args] }),
			settingsFor: cwd => settings.cloneForCwd(cwd),
			agentDir: getAgentDir(),
			log: logger,
		});
		// postmortem owns SIGTERM/SIGINT and exits after its cleanups: stopping here posts the restart notice first.
		const cancelCleanup = postmortem.register("agora-daemon", () => daemon.stop(), { exitOnly: true });
		console.log(`ompx agora: serving ${env.url} (${env.workspace ?? "default workspace"})`);
		try {
			await daemon.run({ once: flags.once });
		} finally {
			cancelCleanup();
			store.close();
		}
	}
}
