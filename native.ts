import { IpcMainInvokeEvent } from "electron";

const GIST_URL = "https://gist.githubusercontent.com/aamiaa/204cd9d42013ded9faf646fae7f89fbb/raw/CompleteDiscordQuest.md";

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
