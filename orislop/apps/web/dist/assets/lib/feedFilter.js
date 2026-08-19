import { scoreWithAiClassifier } from "./combinedScore.js";
import { scoreStaticSlop } from "./staticSlopScore.js";
import { parseYouTubeUrl } from "./youtube.js";
export const FEED_SCAN_LIMIT = 10;
export function parseFeedCandidates(input) {
    return input
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => parseFeedLine(line, index))
        .filter((candidate) => candidate !== null);
}
export function scanFeedCandidates(candidates, strictness, limit = FEED_SCAN_LIMIT) {
    return candidates.slice(0, Math.max(0, limit)).map((candidate) => {
        const heuristic = scoreStaticSlop({
            url: candidate.url,
            title: candidate.title,
            description: candidate.description,
            strictness
        });
        const parsed = parseYouTubeUrl(candidate.url);
        const score = scoreWithAiClassifier({
            heuristic,
            url: candidate.url,
            title: candidate.title,
            description: candidate.description,
            channelName: candidate.channelName,
            durationSeconds: candidate.durationSeconds,
            isShort: parsed.videoKind === "short"
        });
        return {
            candidate,
            score,
            hidden: score.recommendation === "skip",
            flagged: score.recommendation !== "watch"
        };
    });
}
function parseFeedLine(line, index) {
    const [urlPart, titlePart = "", descriptionPart = "", channelPart = "", durationPart = ""] = line.split("|").map((part) => part.trim());
    const parsed = parseYouTubeUrl(urlPart);
    if (!parsed.videoId) {
        return null;
    }
    return {
        id: parsed.videoId ?? `candidate-${index + 1}`,
        url: parsed.normalizedUrl ?? urlPart,
        title: titlePart || `YouTube video ${parsed.videoId}`,
        description: descriptionPart,
        channelName: channelPart || undefined,
        durationSeconds: durationPart ? Number(durationPart) || null : null
    };
}
