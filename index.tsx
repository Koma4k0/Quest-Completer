import "./style.css";

import { showNotification } from "@api/Notifications";
import { addServerListElement, removeServerListElement, ServerListRenderPosition } from "@api/ServerList";
import { ErrorBoundary } from "@components/index";
import { Logger } from "@utils/Logger";
import { ModalRoot, ModalSize, openModal } from "@utils/modal";
import { relaunch } from "@utils/native";
import definePlugin, { PluginNative, StartAt } from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { Alerts, NavigationRouter, React, RestAPI, useEffect, useState, UserStore } from "@webpack/common";
import { JSX } from "react";

import { Commit, GitInfo, GitResult } from "./native";

const Native = VencordNative.pluginHelpers.QuestCompleter as PluginNative<typeof import("./native")>;

// Server list components for sidebar button
const GuildlessServerListItemComponent = findComponentByCodeLazy("tooltip:", "lowerBadgeSize:");
const GuildedServerListItemPillComponent = findComponentByCodeLazy('"pill":"empty"');
// Custom badge component since Vencord's is broken
function CustomBadge({ count, color = "var(--status-danger)" }: { count: number; color?: string; }): JSX.Element | null {
    if (count <= 0) return null;
    const displayText = count > 99 ? "99+" : String(count);
    return (
        <div className="vc-quest-completer-badge" style={{ backgroundColor: color }}>
            {displayText}
        </div>
    );
}

// State for quest count updates
let questCountUpdateInterval: NodeJS.Timeout | null = null;
let currentQuestCount = 0;
let rerenderCallback: (() => void) | null = null;

function getAvailableQuestCount(): number {
    const quests = getQuestInfo();
    return quests.filter(q => !q.isClaimed).length;
}

function formatLowerBadge(count: number, maxDigits: number = 2): [string, number] {
    const maxValue = Math.pow(10, maxDigits) - 1;
    const displayText = count > maxValue ? `${maxValue}+` : `${count}`;
    const width = displayText.length <= 1 ? 16 : displayText.length <= 2 ? 22 : 30;
    return [displayText, width];
}

interface ServerListItemLowerBadgeProps {
    count: number;
    className?: string;
    color?: string;
    style?: React.CSSProperties;
    maxDigits?: number;
}

function QuestIcon(height: number, width: number, className?: string): JSX.Element {
    return (
        <svg
            viewBox="0 0 24 24"
            height={height}
            width={width}
            fill="none"
            className={className}
        >
            <path fill="currentColor" d="M7.5 21.7a8.95 8.95 0 0 1 9 0 1 1 0 0 0 1-1.73c-.6-.35-1.24-.64-1.9-.87.54-.3 1.05-.65 1.52-1.07a3.98 3.98 0 0 0 5.49-1.8.77.77 0 0 0-.24-.95 3.98 3.98 0 0 0-2.02-.76A4 4 0 0 0 23 10.47a.76.76 0 0 0-.71-.71 4.06 4.06 0 0 0-1.6.22 3.99 3.99 0 0 0 .54-5.35.77.77 0 0 0-.95-.24c-.75.36-1.37.95-1.77 1.67V6a4 4 0 0 0-4.9-3.9.77.77 0 0 0-.6.72 4 4 0 0 0 3.7 4.17c.89 1.3 1.3 2.95 1.3 4.51 0 3.66-2.75 6.5-6 6.5s-6-2.84-6-6.5c0-1.56.41-3.21 1.3-4.51A4 4 0 0 0 11 2.82a.77.77 0 0 0-.6-.72 4.01 4.01 0 0 0-4.9 3.96A4.02 4.02 0 0 0 3.73 4.4a.77.77 0 0 0-.95.24 3.98 3.98 0 0 0 .55 5.35 4 4 0 0 0-1.6-.22.76.76 0 0 0-.72.71l-.01.28a4 4 0 0 0 2.65 3.77c-.75.06-1.45.33-2.02.76-.3.22-.4.62-.24.95a4 4 0 0 0 5.49 1.8c.47.42.98.78 1.53 1.07-.67.23-1.3.52-1.91.87a1 1 0 1 0 1 1.73Z" />
        </svg>
    );
}

interface GuildlessServerListItemProps {
    id?: string;
    className?: string;
    icon?: JSX.Element;
    tooltip?: string;
    showPill?: boolean;
    isVisible?: boolean;
    isSelected?: boolean;
    hasUnread?: boolean;
    lowerBadgeProps?: ServerListItemLowerBadgeProps;
    onClick?: ((e: React.MouseEvent) => void);
}

function GuildlessServerListItem({
    id,
    className = "vc-quest-completer",
    icon,
    tooltip,
    showPill = true,
    isVisible = true,
    isSelected = false,
    hasUnread = false,
    lowerBadgeProps,
    onClick
}: GuildlessServerListItemProps): JSX.Element {
    const [hovered, setHovered] = useState(false);

    const badgeCount = lowerBadgeProps?.count ?? 0;

    const wrappedIcon = icon ? (
        <div className={`${className}-icon-container`}>
            {icon}
        </div>
    ) : undefined;

    const componentProps: Record<string, any> = {
        ...(wrappedIcon && { icon: () => wrappedIcon }),
        ...(tooltip !== undefined && { tooltip }),
        ...(onClick !== undefined && { onClick }),
    };

    return (
        <ErrorBoundary>
            {isVisible && (
                <div {...(id !== undefined ? { id } : {})} className={`${className}-container`}>
                    <div className={`${className}-pill-container`}>
                        <GuildedServerListItemPillComponent
                            unread={hasUnread && showPill}
                            selected={isSelected && showPill}
                            hovered={hovered && showPill}
                            className={`${className}-pill${isSelected ? " selected" : hovered ? " hovered" : ""}`}
                        />
                    </div>
                    <div className={`${className}-server-list-button-container`}>
                        <GuildlessServerListItemComponent
                            showPill={false}
                            selected={isSelected}
                            className={`${className}-button`}
                            onMouseEnter={() => setHovered(true)}
                            onMouseLeave={() => setHovered(false)}
                            {...componentProps}
                        />
                        <CustomBadge count={badgeCount} color={lowerBadgeProps?.color} />
                    </div>
                </div>
            )}
        </ErrorBoundary>
    );
}

function QuestCompleterButton(): JSX.Element {
    const [questCount, setQuestCount] = useState(getAvailableQuestCount());

    useEffect(() => {
        rerenderCallback = () => setQuestCount(getAvailableQuestCount());
        return () => { rerenderCallback = null; };
    }, []);

    const lowerBadgeProps = {
        count: questCount,
        maxDigits: 2,
        color: "var(--status-danger)",
        style: { color: "white" }
    };

    return (
        <GuildlessServerListItem
            id="vc-quest-completer-button"
            className="vc-quest-completer"
            icon={QuestIcon(26, 26)}
            tooltip="Quest Completer"
            showPill={true}
            isVisible={true}
            isSelected={false}
            hasUnread={questCount > 0}
            lowerBadgeProps={lowerBadgeProps}
            onClick={openQuestCompleterModal}
        />
    );
}

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
    description: "Adds a sidebar button to automatically complete Discord quests with a badge showing available quest count.",
    authors: [{ name: "Koma4k", id: 1133030912397938820n }],
    dependencies: ["ServerListAPI"],
    startAt: StartAt.Init, // Load early to position above ReadAllNotificationsButton

    renderQuestCompleterButton: ErrorBoundary.wrap(QuestCompleterButton, { noop: true }),

    start() {
        QuestCompleterLogger.info("QuestCompleter started");
        addServerListElement(ServerListRenderPosition.Above, this.renderQuestCompleterButton);

        // Trigger immediate update after a short delay to let Discord load
        setTimeout(() => {
            currentQuestCount = getAvailableQuestCount();
            rerenderCallback?.();
        }, 1000);

        // Update quest count periodically (every 5 seconds)
        questCountUpdateInterval = setInterval(() => {
            const newCount = getAvailableQuestCount();
            if (newCount !== currentQuestCount) {
                currentQuestCount = newCount;
                rerenderCallback?.();
            }
        }, 5000);

        checkForUpdatesAndNotify();
    },

    stop() {
        QuestCompleterLogger.info("QuestCompleter stopped");
        removeServerListElement(ServerListRenderPosition.Above, this.renderQuestCompleterButton);

        if (questCountUpdateInterval) {
            clearInterval(questCountUpdateInterval);
            questCountUpdateInterval = null;
        }
    }
});