import { execFile as cpExecFile, ExecFileOptions } from "node:child_process";
import { IpcMainInvokeEvent } from "electron";
import { promisify } from "util";

const execFile = promisify(cpExecFile);
//updater testing
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

function getVencordRoot(): string {
    // When bundled, __dirname is in dist folder. We need to get back to Vencord root.
    // __dirname might be something like: C:\Users\...\Vencord\dist
    // We want: C:\Users\...\Vencord
    if (__dirname.includes("dist")) {
        return __dirname.replace(/[\\\/]dist[\\\/]?.*$/, "");
    }
    // If running from source, go up from src/userplugins/<plugin-folder> to root
    return __dirname.replace(/[\\\/]src[\\\/]userplugins[\\\/][^\\\/]+[\\\/]?$/, "");
}

const VENCORD_ROOT = getVencordRoot();

async function git(...args: string[]): Promise<GitResult> {
    const opts: ExecFileOptions = { cwd: VENCORD_ROOT, shell: true };

    console.log("[QuestCompleter] Git command:", args, "in dir:", VENCORD_ROOT);

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