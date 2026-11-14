#!/usr/bin/env bun
/**
 * Build the standalone `ompx` binary from this checkout and install it as the
 * global `ompx` on PATH.
 *
 * Steps:
 * 1. `bun install --frozen-lockfile`, so the build's generated-bundle drift
 *    checks run against the locked dependencies.
 * 2. The compiled binary embeds the Bun runtime and refuses to start below the
 *    coding-agent `engines.bun` minimum. When the local `bun` is older, the
 *    matching runtime is downloaded once into `~/.cache/ompx-build/` and passed
 *    to the build via `BUN_COMPILE_EXECUTABLE_PATH`; the global `bun` is left
 *    alone.
 * 3. `bun --cwd=packages/coding-agent run build` -> `packages/coding-agent/dist/ompx`,
 *    validated with `--version` and `--smoke-test`. A stale embedded native
 *    addon (missing `__piNativesV<ver>` sentinel) triggers a native rebuild,
 *    removal of `~/.omp/natives/<ver>`, and one rebuild of the binary.
 * 4. Install. When the global `ompx` is a symlink to a prebuilt binary, the new
 *    build is stored beside that binary as `ompx-<branch>-<sha>` and the
 *    symlink is repointed, so earlier builds stay available for rollback. A
 *    symlink into a source checkout (`bun link` -> `src/cli.ts`) and a plain
 *    file are replaced by the binary. Every replacement is a rename, so a
 *    running `ompx` keeps its old inode.
 *
 * Usage: bun scripts/install-local-binary.ts [--native] [--target <path>]
 *   --native         rebuild the native addon before building the binary
 *   --target <path>  install to this path instead of the `ompx` found on PATH
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const repoRoot = path.resolve(import.meta.dir, "..");
const agentPackage = path.join(repoRoot, "packages", "coding-agent");
const builtBinary = path.join(agentPackage, "dist", "ompx");

function parseArgs(argv: string[]): { native: boolean; target?: string } {
	let native = false;
	let target: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--native") native = true;
		else if (arg === "--target") {
			target = argv[++i];
			if (!target) throw new Error("--target requires a path");
		} else throw new Error(`unknown argument: ${arg}`);
	}
	return { native, target };
}

async function run(label: string, cmd: string[], env?: Record<string, string>): Promise<void> {
	console.log(`\n==> ${label}`);
	const proc = Bun.spawn(cmd, {
		cwd: repoRoot,
		env: env ? { ...Bun.env, ...env } : undefined,
		stdout: "inherit",
		stderr: "inherit",
	});
	if ((await proc.exited) !== 0) throw new Error(`${label} failed (exit ${proc.exitCode})`);
}

/** Returns a runtime path for BUN_COMPILE_EXECUTABLE_PATH, or null when the local bun suffices. */
async function resolveCompileRuntime(): Promise<string | null> {
	if (Bun.env.BUN_COMPILE_EXECUTABLE_PATH) return Bun.env.BUN_COMPILE_EXECUTABLE_PATH;
	const { engines } = (await Bun.file(path.join(agentPackage, "package.json")).json()) as {
		engines: { bun: string };
	};
	if (Bun.semver.satisfies(Bun.version, engines.bun)) return null;

	const version = engines.bun.replace(/^[^\d]*/, "");
	const arch = process.arch === "arm64" ? "aarch64" : "x64";
	const asset = `bun-${process.platform}-${arch}`;
	const cacheDir = path.join(os.homedir(), ".cache", "ompx-build", `bun-${version}`);
	const runtime = path.join(cacheDir, asset, "bun");
	if (await Bun.file(runtime).exists()) return runtime;

	console.log(`\n==> Local bun ${Bun.version} is below ${engines.bun}; downloading bun ${version} runtime`);
	const url = `https://github.com/oven-sh/bun/releases/download/bun-v${version}/${asset}.zip`;
	const zip = path.join(cacheDir, `${asset}.zip`);
	await fs.mkdir(cacheDir, { recursive: true });
	// curl, not fetch: Bun's fetch stalls on the GitHub release-asset redirect here.
	const download = await $`curl -fsSL --max-time 600 -o ${zip} ${url}`.quiet().nothrow();
	if (download.exitCode !== 0) throw new Error(`download ${url} failed: ${download.stderr.toString().trim()}`);
	const unzip = await $`unzip -oq ${zip} -d ${cacheDir}`.quiet().nothrow();
	if (unzip.exitCode !== 0) throw new Error(`unzip ${zip} failed: ${unzip.stderr.toString().trim()}`);
	await fs.rm(zip);
	return runtime;
}

async function buildNative(): Promise<void> {
	await run("Building native addon", ["bun", "--cwd=packages/natives", "run", "build"]);
	const { version } = (await Bun.file(path.join(repoRoot, "packages", "natives", "package.json")).json()) as {
		version: string;
	};
	const extracted = path.join(os.homedir(), ".omp", "natives", version);
	await fs.rm(extracted, { recursive: true, force: true });
	console.log(`Removed stale native extraction ${extracted}`);
}

/** Returns null on success, otherwise the failure output. */
async function validate(binary: string): Promise<string | null> {
	for (const flag of ["--version", "--smoke-test"]) {
		const result = await $`${binary} ${flag}`.quiet().nothrow();
		const output = `${result.stdout}${result.stderr}`.trim();
		if (result.exitCode !== 0) return output || `${flag} exited ${result.exitCode}`;
		if (flag === "--version") console.log(`Validated ${binary}: ${output}`);
	}
	return null;
}

async function resolveTarget(explicit: string | undefined): Promise<string> {
	if (explicit) return path.resolve(explicit);
	// `bun run` prepends this checkout's node_modules/.bin, whose `ompx` is the workspace bin link.
	const globalPath = (Bun.env.PATH ?? "")
		.split(path.delimiter)
		.filter(dir => dir && !path.resolve(dir).startsWith(repoRoot + path.sep))
		.join(path.delimiter);
	const onPath = Bun.which("ompx", { PATH: globalPath });
	if (onPath) return onPath;
	const bunBin = (await $`bun pm -g bin`.quiet().nothrow()).text().trim();
	return path.join(bunBin || path.join(Bun.env.BUN_INSTALL ?? path.join(os.homedir(), ".bun"), "bin"), "ompx");
}

/** Copies the build to `dest` via a staged file and rename. */
async function placeBinary(dest: string): Promise<void> {
	await fs.mkdir(path.dirname(dest), { recursive: true });
	const staged = `${dest}.install-${process.pid}`;
	await fs.copyFile(builtBinary, staged);
	await fs.chmod(staged, 0o755);
	await fs.rename(staged, dest);
}

async function linkedBuildDir(target: string): Promise<string | null> {
	const stat = await fs.lstat(target).catch(() => null);
	if (!stat?.isSymbolicLink()) return null;
	const real = await fs.realpath(target).catch(() => null);
	if (!real) return null;
	// A link into a source checkout (bun link -> src/cli.ts, wrapper scripts) is not a build store.
	const inCheckout =
		(await $`git -C ${path.dirname(real)} rev-parse --is-inside-work-tree`.quiet().nothrow()).exitCode === 0;
	return inCheckout ? null : path.dirname(real);
}

async function install(target: string): Promise<string> {
	const buildDir = await linkedBuildDir(target);
	if (!buildDir) {
		await placeBinary(target);
		return target;
	}
	const branch = (await $`git -C ${repoRoot} rev-parse --abbrev-ref HEAD`.quiet().text()).trim().replaceAll("/", "-");
	const sha = (await $`git -C ${repoRoot} rev-parse --short=10 HEAD`.quiet().text()).trim();
	const versioned = path.join(buildDir, `ompx-${branch}-${sha}`);
	await placeBinary(versioned);
	const stagedLink = `${target}.install-${process.pid}`;
	await fs.symlink(versioned, stagedLink);
	await fs.rename(stagedLink, target);
	return versioned;
}

async function main(): Promise<void> {
	if (process.platform === "win32") throw new Error("Windows is not supported; copy dist/ompx.exe manually");
	const args = parseArgs(process.argv.slice(2));

	await run("Syncing dependencies", ["bun", "install", "--frozen-lockfile"]);
	const runtime = await resolveCompileRuntime();
	const buildEnv = runtime ? { BUN_COMPILE_EXECUTABLE_PATH: runtime } : undefined;
	const buildCmd = ["bun", "--cwd=packages/coding-agent", "run", "build"];

	if (args.native) await buildNative();
	await run("Building ompx binary", buildCmd, buildEnv);
	let failure = await validate(builtBinary);
	if (failure?.includes("version sentinel") && !args.native) {
		console.log("\nEmbedded native addon is stale; rebuilding it.");
		await buildNative();
		await run("Building ompx binary", buildCmd, buildEnv);
		failure = await validate(builtBinary);
	}
	if (failure) throw new Error(`built binary failed validation:\n${failure}`);

	const target = await resolveTarget(args.target);
	const installed = await install(target);
	failure = await validate(target);
	if (failure) throw new Error(`installed binary at ${target} failed validation:\n${failure}`);
	console.log(
		installed === target ? `\nInstalled ${target}` : `\nInstalled ${installed}\nLinked ${target} -> ${installed}`,
	);
}

try {
	await main();
} catch (err) {
	console.error(`install-local-binary: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}
