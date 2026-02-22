import { execFile as cpExecFile, ExecFileOptions } from "node:child_process";
import { IpcMainInvokeEvent } from "electron";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";

const execFile = promisify(cpExecFile);

const GIST_URL = "https://gist.githubusercontent.com/aamiaa/204cd9d42013ded9faf646fae7f89fbb/raw/CompleteDiscordQuest.md";

const isFlatpak = process.platform === "linux" && Boolean(process.env.FLATPAK_ID?.includes("discordapp") || process.env.FLATPAK_ID?.includes("Discord"));
if (process.platform === "darwin") process.env.PATH = `/usr/local/bin:${process.env.PATH}`;

export interface GitResult {
    ok: boolean;
    value?: any;
    error?: any;
    message?: string;
    cmd?: string;
}

export interface Commit {
    hash: string;
    longHash: string;
    message: string;
    author: string;
}

export interface GitInfo {
    repo: string;
    gitHash: string;
}

const VENCORD_USER_PLUGIN_DIR = join(__dirname, "..", "src", "userplugins");

const getCwd = async () => {
    const dirs = await readdir(VENCORD_USER_PLUGIN_DIR, { withFileTypes: true });

    for (const dir of dirs) {
        if (!dir.isDirectory()) continue;

        const pluginDir = join(VENCORD_USER_PLUGIN_DIR, dir.name);
        const files = await readdir(pluginDir);

        // Look for .git folder to find the cloned Quest-Completer repo
        if (files.includes(".git") && dir.name.toLowerCase().includes("quest")) {
            return pluginDir;
        }
    }

    return;
};

async function git(...args: string[]): Promise<GitResult> {
    const opts: ExecFileOptions = { cwd: await getCwd(), shell: true };

    console.log("[QuestCompleter] Git command:", args, "in dir:", opts.cwd);

    try {
        let result;
        if (isFlatpak) {
            result = await execFile("flatpak-spawn", ["--host", "git", ...args], opts);
        } else {
            result = await execFile("git", args, opts);
        }

        console.log("[QuestCompleter] Git result:", result.stdout.trim());
        return { value: result.stdout.trim(), ok: true };
    } catch (error: any) {
        console.error("[QuestCompleter] Git error:", error.stderr, error);
        return {
            ok: false,
            cmd: error.cmd as string,
            message: error.stderr as string,
            error
        };
    }
}

export async function getRepoInfo(_: IpcMainInvokeEvent): Promise<GitResult> {
    const res = await git("remote", "get-url", "origin");
    if (!res.ok) return res;

    const gitHash = await git("rev-parse", "HEAD");
    if (!gitHash.ok) return gitHash;

    return {
        ok: true,
        value: {
            repo: res.value
                .replace(/git@(.+):/, "https://$1/")
                .replace(/\.git$/, ""),
            gitHash: gitHash.value
        }
    };
}

export async function getNewCommits(_: IpcMainInvokeEvent): Promise<GitResult> {
    const branch = await git("branch", "--show-current");
    if (!branch.ok) return branch;

    const logFormat = "%H;%an;%s";
    const branchRange = `HEAD..origin/${branch.value}`;

    try {
        await git("fetch");

        const logOutput = await git("log", `--format="${logFormat}"`, branchRange);
        if (!logOutput.ok) return logOutput;

        if (logOutput.value.trim() === "") {
            return { ok: true, value: [] };
        }

        const commitLines = logOutput.value.trim().split("\n");
        const commits: Commit[] = commitLines.map(line => {
            const [hash, author, ...rest] = line.split(";");
            return { longHash: hash, hash: hash.slice(0, 7), author, message: rest.join(";") };
        });

        return { ok: true, value: commits };
    } catch (error: any) {
        return { ok: false, cmd: error.cmd, message: error.message, error };
    }
}

export async function update(_: IpcMainInvokeEvent): Promise<GitResult> {
    return await git("pull");
}

export async function fetchQuestScript(_: IpcMainInvokeEvent): Promise<string> {
    try {
        const response = await fetch(GIST_URL);
        if (!response.ok) {
            throw new Error(`Failed to fetch: ${response.status}`);
        }

        const markdown = await response.text();

        const jsMatch = markdown.match(/```js\n([\s\S]*?)```/);
        if (!jsMatch || !jsMatch[1]) {
            throw new Error("Could not find JavaScript code in the gist");
        }

        return jsMatch[1].trim();
    } catch (e) {
        throw new Error(`Failed to fetch quest script: ${e}`);
    }
}

export async function completeAchievementQuest(_: IpcMainInvokeEvent, appID: string, authCode: string, questTarget: number): Promise<{ success: boolean; error: string | null; }> {
    const authResult = await authorizeAchievementQuest(appID, authCode);

    if (authResult.error || !authResult.token) {
        return { success: false, error: JSON.stringify(authResult.error) };
    }

    const progressResult = await reportAchievementQuestProgress(appID, authResult.token, questTarget);

    if (progressResult.error || !progressResult.success) {
        return { success: false, error: JSON.stringify(progressResult.error) };
    }

    return { success: true, error: null };
}

async function authorizeAchievementQuest(appID: string, authCode: string): Promise<{ token: string | false; error: any; }> {
    let error = null;

    const token = await fetch(`https://${appID}.discordsays.com/.proxy/acf/authorize`, {
        body: JSON.stringify({ code: authCode }),
        method: "POST",
        mode: "cors",
        credentials: "include"
    }).then(res => res.json()).then(data => data.token).catch((e) => { error = e; return ""; });

    return { token, error };
}

async function reportAchievementQuestProgress(appID: string, token: string, questTarget: number): Promise<{ success: boolean; error: any; }> {
    let error = null;

    const success = await fetch(`https://${appID}.discordsays.com/.proxy/acf/quest/progress`, {
        headers: { "x-auth-token": token },
        body: JSON.stringify({ progress: questTarget }),
        method: "POST",
        mode: "cors",
        credentials: "include"
    }).then(res => res.ok).catch((e) => { error = e; return false; });

    return { success, error };
}