#!/usr/bin/env node
/**
 * dsh-tui 安装器 — 把本包以官方 profile-bundle 方式装入 dsh。
 *
 * 参考 argent install-argent.mjs 的插件供给模式（同款 `pnpm add file:` 装入 +
 * 强制刷新 + manifest 自检），但 dsh-tui 是独立迭代的仓库，不依赖 argent-dsh。
 *
 * 做什么：
 *   1. 解析目标 home（$DSH_HOME 或 ~/.dsh）——多实例（argent 式 DSH_HOME 隔离）天然支持；
 *   2. 引导/规整 `$DSH_HOME/profiles/tui`：package.json 的
 *      dsh.profile.bundles = [@deepseek-ai/dsh-base, dsh-tui]（缺一补齐）；
 *      清掉 dependencies 里任何 @deepseek-ai/*（必须解析自 dsh 安装闭包，
 *      绝不能从 registry 装——混合版本会断链，见 dsh 全局规则）；
 *   3. 用 pnpm 把本仓库以 `file:` 依赖装入 profile（先删旧拷贝强制刷新，
 *      与 argent 安装器同款踩坑对策）；
 *   4. 自检：bundle 行齐 + 可选 `--check` 冒烟（dsh --profile tui --help）。
 *
 * 用法：
 *   node scripts/install.mjs            装入默认 home
 *   DSH_HOME=~/.dsh-some-instance node scripts/install.mjs   装入指定实例
 *   node scripts/install.mjs --check    装入后冒烟验证
 *   node scripts/install.mjs --uninstall  移除该 home 的 tui profile
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const PROFILE = "tui";
const PROFILE_DIR = join(HOME, "profiles", PROFILE);
const PACKAGE = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
const BUNDLES = ["@deepseek-ai/dsh-base", PACKAGE.name];

const say = (text) => console.log(`[dsh-tui] ${text}`);
const ok = (text) => console.log(`[dsh-tui] ✓ ${text}`);
const warn = (text) => console.warn(`[dsh-tui] ⚠ ${text}`);
const die = (text) => {
	console.error(`[dsh-tui] ✗ ${text}`);
	process.exit(1);
};

/** 与 install-argent.mjs 同款：找到可用的 pnpm（PATH → corepack）。 */
function ensurePnpm() {
	const tryRun = (cmd, args) => {
		try {
			const out = execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
			return String(out).trim();
		} catch {
			return "";
		}
	};
	const direct = tryRun("pnpm", ["--version"]);
	if (direct !== "") return "pnpm";
	const corepack = tryRun("corepack", ["which", "pnpm"]);
	if (corepack !== "") return corepack;
	return "";
}

const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`;
const PNPM_WORKSPACE_TEMPLATE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;

/** 引导或规整 profile manifest（幂等）。 */
function ensureProfile() {
	mkdirSync(PROFILE_DIR, { recursive: true });
	const manifestPath = join(PROFILE_DIR, "package.json");
	let manifest;
	if (existsSync(manifestPath)) {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		// 清掉任何 @deepseek-ai/* 依赖：dsh 子包必须来自安装闭包，registry 拷贝会混合版本
		for (const key of Object.keys(manifest.dependencies ?? {})) {
			if (key.startsWith("@deepseek-ai/")) delete manifest.dependencies[key];
		}
		if (Object.keys(manifest.dependencies ?? {}).length === 0) delete manifest.dependencies;
	} else {
		manifest = { name: `dsh-profile-${PROFILE}`, private: true };
	}
	const bundles = [...(manifest.dsh?.profile?.bundles ?? [])];
	for (const bundle of BUNDLES) {
		if (!bundles.includes(bundle)) bundles.push(bundle);
	}
	manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles } };
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	if (!existsSync(join(PROFILE_DIR, "cordis.patch.yml"))) {
		writeFileSync(join(PROFILE_DIR, "cordis.patch.yml"), PROFILE_PATCH_TEMPLATE);
	}
	if (!existsSync(join(PROFILE_DIR, "pnpm-workspace.yaml"))) {
		writeFileSync(join(PROFILE_DIR, "pnpm-workspace.yaml"), PNPM_WORKSPACE_TEMPLATE);
	}
	ok(`profile ${PROFILE_DIR} 就绪（bundles: ${bundles.join(", ")}）`);
}

/** 用 pnpm 以 file: 依赖装入（先删旧拷贝强制刷新，同 install-argent.mjs add()）。 */
function installPackage() {
	const pnpm = ensurePnpm();
	if (pnpm === "") die("未找到 pnpm（PATH 或 corepack）——请先安装 pnpm 后重试");
	rmSync(join(PROFILE_DIR, "node_modules", PACKAGE.name), { recursive: true, force: true });
	say(`pnpm add file:${REPO_ROOT} → ${PROFILE_DIR}`);
	try {
		execFileSync(pnpm, ["add", `file:${REPO_ROOT}`], {
			cwd: PROFILE_DIR,
			stdio: "inherit"
		});
	} catch {
		die("pnpm add 失败——请查看上方输出");
	}
	// 自检：bundle 行必须仍在（pnpm add 只装依赖不写 bundles，行由我们引导时写好）
	const manifest = JSON.parse(readFileSync(join(PROFILE_DIR, "package.json"), "utf8"));
	const bundles = manifest.dsh?.profile?.bundles ?? [];
	if (!bundles.includes(PACKAGE.name)) die("自检失败：profile bundles 缺少 dsh-tui");
	ok(`已装入 ${PACKAGE.name}@${PACKAGE.version}（pnpm 管理）`);
}

/** 冒烟：dsh --profile tui --help 必须退出 0。 */
function smokeCheck() {
	say("冒烟：dsh --profile tui --help");
	try {
		execFileSync("dsh", ["--profile", PROFILE, "--help"], { stdio: "inherit" });
	} catch {
		die("冒烟失败：dsh --profile tui --help 非零退出");
	}
	ok("冒烟通过");
}

function uninstall() {
	if (!existsSync(PROFILE_DIR)) {
		say("profile 不存在，无需卸载");
		return;
	}
	rmSync(PROFILE_DIR, { recursive: true, force: true });
	ok(`已移除 ${PROFILE_DIR}`);
}

const args = process.argv.slice(2);
if (args.includes("--uninstall")) {
	uninstall();
} else {
	say(`dsh-tui@${PACKAGE.version} 安装器（home: ${HOME}）`);
	ensureProfile();
	installPackage();
	if (args.includes("--check")) smokeCheck();
	say("完成。使用：dsh --profile tui [--resume <sessionId>] [--workspace <dir>]");
}
