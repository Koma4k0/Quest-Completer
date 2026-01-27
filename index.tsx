import "./style.css";

import { showNotification } from "@api/Notifications";
import { Logger } from "@utils/Logger";
import { ModalRoot, ModalSize, openModal } from "@utils/modal";
import { relaunch } from "@utils/native";
import definePlugin, { PluginNative } from "@utils/types";
import { Alerts, NavigationRouter, React, RestAPI, useEffect, useState, UserStore } from "@webpack/common";

import { Commit, GitInfo, GitResult } from "./native";

const Native = VencordNative.pluginHelpers.QuestCompleter as PluginNative<typeof import("./native")>;

const QuestCompleterLogger = new Logger("QuestCompleter");

interface QuestInfo {
    id: string;
    questName: string;
    applicationName: string;
    taskType: string;
    secondsNeeded: number;
    secondsDone: number;
    expiresAt: string;
    isCompleted: boolean;
    isClaimed: boolean;
    isEnrolled: boolean;
    rewardName: string;
    rewardImage: string | null;
}

const SUPPORTED_TASKS = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"];

function getQuestInfo(): QuestInfo[] {
    try {
        const wpRequire = (window as any).webpackChunkdiscord_app.push([[Symbol()], {}, (r: any) => r]);
        (window as any).webpackChunkdiscord_app.pop();

        const modules = Object.values(wpRequire.c) as any[];
        let QuestsStore = modules.find((x: any) => x?.exports?.Z?.__proto__?.getQuest)?.exports?.Z;
        if (!QuestsStore) {
            QuestsStore = modules.find((x: any) => x?.exports?.A?.__proto__?.getQuest)?.exports?.A;
        }

        if (!QuestsStore) return [];

        const quests = [...QuestsStore.quests.values()].filter((x: any) =>
            new Date(x.config.expiresAt).getTime() > Date.now() &&
            SUPPORTED_TASKS.find(y => Object.keys((x.config.taskConfig ?? x.config.taskConfigV2).tasks).includes(y))
        );

        return quests.map((quest: any) => {
            const taskConfig = quest.config.taskConfig ?? quest.config.taskConfigV2;
            const taskName = SUPPORTED_TASKS.find(x => taskConfig.tasks[x] != null) || "UNKNOWN";
            const secondsNeeded = taskConfig.tasks[taskName]?.target || 0;
            const secondsDone = quest.userStatus?.progress?.[taskName]?.value ?? 0;
            const isEnrolled = quest.userStatus?.enrolledAt != null;
            const isCompleted = isEnrolled && (secondsDone >= secondsNeeded || quest.userStatus?.completedAt != null);
            const isClaimed = quest.userStatus?.claimedAt != null;

            const reward = quest.config.rewardsConfig?.rewards?.[0];
            const rewardName = reward?.messages?.name ?? "Unknown Reward";
            const rewardAsset = reward?.asset;
            const rewardType = reward?.type;

            let rewardImage: string | null = null;
            if (rewardType === 4) {
                rewardImage = "https://cdn.discordapp.com/assets/content/fb761d9c206f93cd8c4e7301798abe3f623039a4054f2e7accd019e1bb059fc8.webm?format=webp";
            } else if (rewardAsset) {
                rewardImage = `https://cdn.discordapp.com/${rewardAsset}`;
            }

            QuestCompleterLogger.info(`Quest ${quest.id} reward:`, { rewardName, rewardAsset, reward });

            return {
                id: quest.id,
                questName: quest.config.messages.questName,
                applicationName: quest.config.application.name,
                taskType: taskName,
                secondsNeeded,
                secondsDone: isEnrolled ? secondsDone : 0,
                expiresAt: quest.config.expiresAt,
                isCompleted,
                isClaimed,
                isEnrolled,
                rewardName,
                rewardImage
            };
        });
    } catch (e) {
        QuestCompleterLogger.error("Failed to get quest info:", e);
        return [];
    }
}

function formatTimeLeft(expiresAt: string): string {
    const now = Date.now();
    const expires = new Date(expiresAt).getTime();
    const diff = expires - now;

    if (diff <= 0) return "Expired";

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    if (days > 0) return `${days}d ${hours}h left`;
    if (hours > 0) return `${hours}h ${minutes}m left`;
    return `${minutes}m left`;
}

function formatTaskType(taskType: string): string {
    const mapping: Record<string, string> = {
        "WATCH_VIDEO": "Watch Video",
        "PLAY_ON_DESKTOP": "Play Game",
        "STREAM_ON_DESKTOP": "Stream Game",
        "PLAY_ACTIVITY": "Play Activity",
        "WATCH_VIDEO_ON_MOBILE": "Watch Video (Mobile)"
    };
    return mapping[taskType] || taskType;
}

function RewardMedia({ src, alt }: { src: string; alt: string; }) {
    const isVideo = src.endsWith(".mp4") || src.endsWith(".webm");
    const baseStyle = { width: "48px", height: "48px", borderRadius: "6px", objectFit: "cover" as const };
    const wrapperStyle = { flexShrink: 0, alignSelf: "center" as const };

    if (isVideo) {
        return (
            <div style={{ ...wrapperStyle, background: "#000", borderRadius: "6px" }}>
                <video src={src} autoPlay loop muted playsInline style={{ ...baseStyle, display: "block" }} />
            </div>
        );
    }
    return (
        <div style={wrapperStyle}>
            <img src={src} alt={alt} style={baseStyle} />
        </div>
    );
}

function openQuestPage(onClose?: () => void): void {
    NavigationRouter.transitionTo("/quest-home");
    setTimeout(() => {
        onClose?.();
    }, 2000);
}

async function enrollInQuest(questId: string): Promise<boolean> {
    try {
        await RestAPI.post({
            url: `/quests/${questId}/enroll`,
            body: {
                location: 11,
                is_targeted: false,
                metadata_raw: null,
                metadata_sealed: null
            }
        });

        showNotification({
            title: "Quest Completer",
            body: "Successfully enrolled in quest!",
            color: "#248046"
        });
        return true;
    } catch (e) {
        QuestCompleterLogger.error("Failed to enroll in quest:", e);
        showNotification({
            title: "Quest Completer Error",
            body: `Failed to enroll: ${e}`,
            color: "#ED4245"
        });
        return false;
    }
}

async function fetchAndRunScript(): Promise<void> {
    try {
        QuestCompleterLogger.info("Fetching quest completer script...");

        const script = await Native.fetchQuestScript();

        QuestCompleterLogger.info("Running quest completer script...");

        eval(script);

        showNotification({
            title: "Quest Completer",
            body: "Quest Completion Started! Please check back soon to claim completed quests.",
            color: "var(--green-360)"
        });

    } catch (e) {
        QuestCompleterLogger.error("Failed to run script:", e);
        showNotification({
            title: "Quest Completer Error",
            body: `Failed to Complete Quest: ${e}`,
            color: "var(--red-400)"
        });
    }
}



function QuestCompleterModal({ rootProps }: { rootProps: any; }) {
    const [quests, setQuests] = useState<QuestInfo[]>([]);
    const [isRunning, setIsRunning] = useState(false);
    const [enrollingId, setEnrollingId] = useState<string | null>(null);

    useEffect(() => {
        setQuests(getQuestInfo());

        const interval = setInterval(() => {
            setQuests(getQuestInfo());
        }, 5000);

        return () => clearInterval(interval);
    }, []);

    const handleRunScript = async () => {
        setIsRunning(true);
        await fetchAndRunScript();
        setTimeout(() => {
            setIsRunning(false);
            setQuests(getQuestInfo());
        }, 2000);
    };

    const handleRefresh = () => {
        setQuests(getQuestInfo());
    };

    const handleEnroll = async (questId: string) => {
        setEnrollingId(questId);
        const success = await enrollInQuest(questId);
        setEnrollingId(null);
        if (success) {
            setTimeout(() => setQuests(getQuestInfo()), 500);
        }
    };

    const availableQuests = quests.filter(q => !q.isClaimed);
    const enrolledQuests = availableQuests.filter(q => q.isEnrolled);
    const notEnrolledQuests = availableQuests.filter(q => !q.isEnrolled);

    const currentUser = UserStore.getCurrentUser();
    const userAvatar = currentUser?.getAvatarURL(undefined, 64, true);

    return (
        <ModalRoot {...rootProps} size={ModalSize.MEDIUM}>
            <div style={{ padding: "12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
                    {userAvatar ? (
                        <img src={userAvatar} alt="Avatar" style={{ width: "36px", height: "36px", borderRadius: "50%" }} />
                    ) : (
                        <div style={{ fontSize: "28px" }}>🎮</div>
                    )}
                    <div style={{ flex: 1 }}>
                        <div style={{ color: "#FFFFFF", fontSize: "16px", fontWeight: 600 }}>Quest Completer</div>
                        <div style={{ color: "#B5BAC1", fontSize: "11px" }}>{availableQuests.length} quest{availableQuests.length !== 1 ? "s" : ""} available</div>
                    </div>
                    <button onClick={handleRefresh} style={{ background: "transparent", border: "none", color: "#B5BAC1", cursor: "pointer", fontSize: "16px", padding: "4px" }} title="Refresh">↻</button>
                    <button onClick={rootProps.onClose} style={{ background: "transparent", border: "none", color: "#B5BAC1", cursor: "pointer", fontSize: "16px", padding: "4px" }}>✕</button>
                </div>
                <div className="vc-quest-scroll" style={{ maxHeight: "60vh", overflowY: "auto" }}>

                    {availableQuests.length === 0 ? (
                        <div style={{ textAlign: "center", padding: "40px 20px" }}>
                            <div style={{ fontSize: "48px", marginBottom: "16px" }}>🔍</div>
                            <div style={{ fontSize: "16px", fontWeight: 500, marginBottom: "8px", color: "#FFFFFF" }}>No Quests Available</div>
                            <div style={{ fontSize: "14px", color: "#B5BAC1" }}>Check back later for new quests!</div>
                        </div>
                    ) : (
                        <>
                            {enrolledQuests.length > 0 && (
                                <>
                                    <div style={{ color: "#FFFFFF", fontSize: "14px", fontWeight: 600, marginBottom: "8px" }}>
                                        Your Quests ({enrolledQuests.length})
                                    </div>
                                    <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "16px" }}>
                                        {enrolledQuests.map((quest, i) => {
                                            const percent = quest.secondsNeeded > 0 ? Math.min(100, Math.floor((quest.secondsDone / quest.secondsNeeded) * 100)) : 0;
                                            const isComplete = quest.isCompleted || percent >= 100;
                                            return (
                                                <div
                                                    key={i}
                                                    style={{
                                                        background: "#2B2D31",
                                                        borderRadius: "8px",
                                                        padding: "12px",
                                                        display: "flex",
                                                        gap: "12px"
                                                    }}
                                                >
                                                    {quest.rewardImage && (
                                                        <RewardMedia src={quest.rewardImage} alt={quest.rewardName} />
                                                    )}
                                                    <div style={{ flex: 1, minWidth: 0 }}>
                                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "4px" }}>
                                                            <div style={{ minWidth: 0 }}>
                                                                <div style={{ color: "#FFFFFF", fontSize: "14px", fontWeight: 600, marginBottom: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{quest.questName}</div>
                                                                <div style={{ color: "#B5BAC1", fontSize: "11px" }}>{quest.applicationName} • {formatTaskType(quest.taskType)}</div>
                                                            </div>
                                                            <div style={{ background: isComplete ? "#248046" : "#5865F2", padding: "2px 6px", borderRadius: "4px", fontSize: "11px", fontWeight: 500, color: "#FFFFFF", flexShrink: 0, marginLeft: "8px" }}>
                                                                {isComplete ? "Complete!" : formatTimeLeft(quest.expiresAt)}
                                                            </div>
                                                        </div>
                                                        <div style={{ color: "#FFFFFF", fontSize: "11px", marginBottom: "6px" }}>
                                                            🎁 {quest.rewardName}
                                                        </div>
                                                        <div style={{ marginBottom: "4px", display: "flex", justifyContent: "space-between", fontSize: "11px" }}>
                                                            <span style={{ color: "#B5BAC1" }}>Progress</span>
                                                            <span style={{ color: "#DBDEE1" }}>{Math.floor(quest.secondsDone / 60)}/{Math.floor(quest.secondsNeeded / 60)} min ({percent}%)</span>
                                                        </div>
                                                        <div style={{ height: "6px", background: "#1E1F22", borderRadius: "3px", overflow: "hidden" }}>
                                                            <div style={{ height: "100%", width: `${percent}%`, background: isComplete ? "#248046" : "#5865F2", borderRadius: "3px" }} />
                                                        </div>
                                                        {isComplete && (
                                                            <button
                                                                onClick={(e) => { e.stopPropagation(); openQuestPage(rootProps.onClose); }}
                                                                style={{ width: "100%", marginTop: "8px", padding: "6px 10px", background: "#248046", border: "none", borderRadius: "4px", color: "#FFFFFF", fontSize: "12px", fontWeight: 500, cursor: "pointer" }}
                                                            >
                                                                Open Quest Page to Claim
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </>
                            )}

                            {notEnrolledQuests.length > 0 && (
                                <>
                                    <div style={{ color: "#FFFFFF", fontSize: "14px", fontWeight: 600, marginBottom: "8px" }}>
                                        Available Quests ({notEnrolledQuests.length})
                                    </div>
                                    <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "16px" }}>
                                        {notEnrolledQuests.map((quest, i) => {
                                            const isEnrolling = enrollingId === quest.id;
                                            return (
                                                <div
                                                    key={i}
                                                    style={{
                                                        background: "#2B2D31",
                                                        borderRadius: "8px",
                                                        padding: "12px",
                                                        display: "flex",
                                                        gap: "12px"
                                                    }}
                                                >
                                                    {quest.rewardImage && (
                                                        <RewardMedia src={quest.rewardImage} alt={quest.rewardName} />
                                                    )}
                                                    <div style={{ flex: 1, minWidth: 0 }}>
                                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "4px" }}>
                                                            <div style={{ minWidth: 0 }}>
                                                                <div style={{ color: "#FFFFFF", fontSize: "14px", fontWeight: 600, marginBottom: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{quest.questName}</div>
                                                                <div style={{ color: "#B5BAC1", fontSize: "11px" }}>{quest.applicationName} • {formatTaskType(quest.taskType)}</div>
                                                            </div>
                                                            <div style={{ background: "#4E5058", padding: "2px 6px", borderRadius: "4px", fontSize: "11px", fontWeight: 500, color: "#FFFFFF", flexShrink: 0, marginLeft: "8px" }}>
                                                                {formatTimeLeft(quest.expiresAt)}
                                                            </div>
                                                        </div>
                                                        <div style={{ color: "#5865F2", fontSize: "11px", marginBottom: "6px" }}>
                                                            🎁 {quest.rewardName}
                                                        </div>
                                                        <div style={{ fontSize: "11px", color: "#B5BAC1", marginBottom: "8px" }}>
                                                            {Math.floor(quest.secondsNeeded / 60)} min required
                                                        </div>
                                                        <button
                                                            onClick={() => handleEnroll(quest.id)}
                                                            disabled={isEnrolling}
                                                            style={{
                                                                width: "100%",
                                                                padding: "6px 10px",
                                                                background: isEnrolling ? "#4E5058" : "#5865F2",
                                                                border: "none",
                                                                borderRadius: "4px",
                                                                color: "#FFFFFF",
                                                                fontSize: "12px",
                                                                fontWeight: 500,
                                                                cursor: isEnrolling ? "not-allowed" : "pointer",
                                                                opacity: isEnrolling ? 0.5 : 1
                                                            }}
                                                        >
                                                            {isEnrolling ? "Enrolling..." : "Enroll (Desktop)"}
                                                        </button>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </>
                            )}
                        </>
                    )}
                </div>

                <button
                    onClick={handleRunScript}
                    disabled={isRunning || enrolledQuests.length === 0}
                    style={{
                        width: "100%",
                        marginTop: "8px",
                        padding: "10px 12px",
                        background: isRunning || enrolledQuests.length === 0 ? "#4E5058" : "#5865F2",
                        border: "none",
                        borderRadius: "4px",
                        color: "#FFFFFF",
                        fontSize: "13px",
                        fontWeight: 500,
                        cursor: isRunning || enrolledQuests.length === 0 ? "not-allowed" : "pointer",
                        opacity: isRunning || enrolledQuests.length === 0 ? 0.5 : 1
                    }}
                >
                    {isRunning ? "Running..." : "Complete All Enrolled Quests"}
                </button>

                <div style={{ marginTop: "8px", padding: "8px", background: "#2B2D31", borderRadius: "4px", fontSize: "11px", color: "#B5BAC1" }}>
                    <span style={{ color: "#DBDEE1", fontWeight: 500 }}>Tip:</span> Enroll → Complete All → Claim from quest page.
                </div>
            </div>
        </ModalRoot>
    );
}

function openQuestCompleterModal() {
    openModal(props => <QuestCompleterModal rootProps={props} />);
}

let updateError: GitResult | undefined;
let isOutdated = false;
let changes: Commit[] = [];
let repoInfo: GitInfo | undefined;

async function unwrap<T>(p: Promise<GitResult>): Promise<T | undefined> {
    const res = await p;
    if (res.ok) return res.value as T;
    updateError = res;
    if (res.error) QuestCompleterLogger.error("Update error:", res.error);
    return undefined;
}

async function checkForUpdates(): Promise<boolean> {
    const newChanges = await unwrap<Commit[]>(Native.getNewCommits());
    if (!newChanges) return isOutdated = false;

    changes = newChanges;
    return isOutdated = changes.length > 0;
}

async function doUpdate(): Promise<void> {
    const res = await Native.update();
    if (!res.ok) {
        return Alerts.show({
            title: "Update Failed",
            body: `Failed to update Quest Completer: ${res.message || "Unknown error"}`,
        });
    }

    if (!(await VencordNative.updater.rebuild()).ok) {
        return Alerts.show({
            title: "Build Failed",
            body: "The build failed. Please try manually rebuilding Vencord.",
        });
    }

    Alerts.show({
        title: "Update Success!",
        body: "Quest Completer updated successfully. Restart to apply changes?",
        confirmText: "Restart",
        cancelText: "Later",
        onConfirm: () => relaunch(),
    });

    changes = [];
    isOutdated = false;
}

async function checkForUpdatesAndNotify(): Promise<void> {
    if (IS_WEB) return;

    try {
        QuestCompleterLogger.info("Checking for updates...");

        const repoResult = await Native.getRepoInfo();
        QuestCompleterLogger.info("getRepoInfo result:", repoResult);

        if (!repoResult.ok) {
            QuestCompleterLogger.error("Failed to get repo info:", repoResult.message, repoResult.error);
            return;
        }
        repoInfo = repoResult.value;

        const commitsResult = await Native.getNewCommits();
        QuestCompleterLogger.info("getNewCommits result:", commitsResult);

        if (!commitsResult.ok) {
            QuestCompleterLogger.error("Failed to get new commits:", commitsResult.message, commitsResult.error);
            return;
        }

        changes = commitsResult.value || [];
        isOutdated = changes.length > 0;

        QuestCompleterLogger.info(`Found ${changes.length} new commits, isOutdated: ${isOutdated}`);

        if (isOutdated) {
            QuestCompleterLogger.info("Showing update notification...");
            setTimeout(() => {
                QuestCompleterLogger.info("Notification timeout fired");
                Alerts.show({
                    title: "Quest Completer Update",
                    body: `Update available! ${changes.length} new commit${changes.length > 1 ? "s" : ""}.\n\nWould you like to update now?`,
                    confirmText: "Update",
                    cancelText: "Later",
                    onConfirm: () => doUpdate(),
                });
            }, 3_000);
        }
    } catch (e) {
        QuestCompleterLogger.error("Failed to check for updates:", e);
    }
}

export default definePlugin({
    name: "QuestCompleter",
    description: "Adds modal to automatically complete Discord quests, open it from the vencord toolbox!",
    authors: [{ name: "Koma4k", id: 1133030912397938820n }],

    toolboxActions: {
        "Open Quest TEST": openQuestCompleterModal
    },

    start() {
        QuestCompleterLogger.info("QuestCompleter started");
        checkForUpdatesAndNotify();
    },

    stop() {
        QuestCompleterLogger.info("QuestCompleter stopped");
    }
});