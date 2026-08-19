import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const backgroundSource = readFileSync(path.join(repoRoot, "apps", "extension", "dist", "background.js"), "utf8");
const manifest = JSON.parse(readFileSync(path.join(repoRoot, "apps", "extension", "dist", "manifest.json"), "utf8"));
const extensionOrigin = process.env.ORISLOP_EXTENSION_ORIGIN || `chrome-extension://${extensionIdFromManifestKey(manifest.key)}`;
const model = process.env.ORISLOP_OLLAMA_MODEL || "qwen2.5:1.5b-instruct";
const artifactRoot = path.join(repoRoot, "dist", "qa", "ollama-live");
let messageListener;

function extensionIdFromManifestKey(key) {
  const digest = createHash("sha256").update(Buffer.from(String(key || ""), "base64")).digest().subarray(0, 16);
  return [...digest].map((byte) => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`).join("");
}

const classifier = {
  scoreCandidate(candidate) {
    return {
      candidate,
      hardAiSynthetic: false,
      factCheckEligible: false,
      recommendation: "watch",
      score: 0,
      reasons: [],
      breakdown: {}
    };
  },
  mergeOllamaDecision(local, decision) {
    if (!decision?.available) return { ...local, ollamaUsed: false, ollamaStatus: decision?.status || "unavailable" };
    return {
      ...local,
      recommendation: decision.verdict === "skip" ? "skip" : "watch",
      ollamaUsed: true,
      ollamaStatus: "available",
      ollamaDecision: decision
    };
  },
  mergeDetectorDecision(result, decision) {
    return { ...result, detectorStatus: decision?.status || "ready" };
  },
  mergeFactCheckDecision(result, decision) {
    return { ...result, factCheckStatus: decision?.status || "not_eligible" };
  }
};

const context = vm.createContext({
  AbortController,
  console,
  importScripts() {},
  navigator: { hardwareConcurrency: 4, deviceMemory: 4 },
  setTimeout,
  clearTimeout,
  OrislopClassifier: classifier,
  fetch: async (url, options = {}) => {
    const target = new URL(String(url));
    if (target.origin === "http://127.0.0.1:4317" && target.pathname === "/v1/analyze") {
      const request = JSON.parse(options.body || "{}");
      return new Response(JSON.stringify({
        ok: true,
        state: "ready",
        results: (request.candidates || []).map(({ id }) => ({ id, status: "ready", synthetic: false }))
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const headers = new Headers(options.headers || {});
    headers.set("Origin", extensionOrigin);
    return fetch(url, { ...options, headers });
  },
  chrome: {
    runtime: {
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        }
      }
    }
  }
});
context.globalThis = context;
vm.runInContext(backgroundSource, context, { filename: "background.js" });
assert.equal(typeof messageListener, "function", "background worker should register its message listener");

const timer = performance.now();
const smoke = await sendMessage({ type: "orislop.testOllama", model }, 90000);
assert.equal(smoke.ok, true, smoke.error || smoke.message);
assert.match(smoke.message, /completed (?:local companion|cloud) inference/i);

const candidates = [
  candidate("edu", "How black holes bend light", "A professor explains gravitational lensing with a diagram."),
  candidate("tutorial", "Repair a broken package lock", "A software tutorial with commands and explanations."),
  candidate("art", "Watercolor landscape process", "The artist explains each original painting step."),
  candidate("bait", "Wait until the end", "You will not believe this recycled viral clip. Like and subscribe."),
  candidate("compilation", "Top ten celebrity moments", "A compilation with no original commentary. Follow for part two."),
  candidate("stolen", "Reaction clip", "An empty reaction using stolen footage and engagement bait.")
];
const scored = await scoreUntilContextSettles({
  type: "orislop.scoreBatch",
  candidates,
  settings: { ollamaModel: model }
}, 240000);

assert.equal(scored.ok, true, scored.error);
assert.equal(scored.ollamaStatus, "available", scored.ollamaError);
const liveDecisions = scored.results.map((result, index) => ({
  id: candidates[index].itemId,
  recommendation: result.recommendation,
  ollamaDecision: result.ollamaDecision || null
}));
if (liveDecisions.slice(3).some((item) => item.recommendation !== "skip")) {
  console.error(JSON.stringify({ unexpectedLiveDecisions: liveDecisions }, null, 2));
}
assert.deepEqual(
  scored.results.map((result) => result.recommendation),
  ["watch", "watch", "watch", "skip", "skip", "skip"]
);

const explained = await sendMessage({
  type: "orislop.explainVideo",
  candidate: {
    ...candidate("explain", "Why rainbows form", "A science teacher explains that sunlight bends and separates into colors inside water droplets."),
    transcriptText: "Sunlight enters a water droplet, refracts, reflects from the inside surface, and refracts again as it leaves. Different wavelengths bend by different amounts, so the light separates into visible colors."
  },
  decision: {
    recommendation: "watch",
    score: 8,
    reasons: ["Educational explanation", "Original teaching context"],
    factCheckDecision: null
  },
  mode: "explain",
  settings: { ollamaModel: model, inferenceMode: "local", performanceMode: "fast" }
}, 90000);
assert.equal(explained.ok, true, explained.error);
assert.ok(explained.explanation.length >= 40, "live Qwen explanation should contain a useful plain-language answer");
assert.ok(explained.decisionExplanation.length >= 15, "live Qwen explanation should describe Orislop's decision");

const contradictedCandidate = {
  ...candidate("contradicted", "False vaccine microchip claim", "The video claims routine vaccines contain tracking microchips."),
  transcriptText: "The speaker claims routine vaccines contain tracking microchips and says public-health agencies confirmed it."
};
const contradictedDecision = {
  recommendation: "skip",
  reasons: ["Trusted evidence contradicts the video's factual claim"],
  factCheckDecision: {
    verdict: "contradicted",
    claim: "Routine vaccines contain tracking microchips.",
    summary: "The supplied public-health sources contradict the video's claim.",
    sources: [
      {
        title: "Vaccine ingredients and safety",
        url: "https://www.cdc.gov/vaccine-safety/about/",
        domain: "cdc.gov",
        publisher: "CDC",
        snippet: "The listed vaccine ingredients do not include tracking microchips.",
        rating: "Contradicted",
        trusted: true
      },
      {
        title: "Vaccine safety questions and answers",
        url: "https://www.who.int/news-room/questions-and-answers/item/vaccines-and-immunization-vaccine-safety",
        domain: "who.int",
        publisher: "World Health Organization",
        snippet: "Vaccine safety information does not support the tracking-microchip claim.",
        rating: "Contradicted",
        trusted: true
      }
    ]
  }
};
const whyWrong = await sendMessage({
  type: "orislop.explainVideo",
  candidate: contradictedCandidate,
  decision: contradictedDecision,
  mode: "why_wrong",
  settings: { ollamaModel: model, inferenceMode: "local", performanceMode: "fast" }
}, 120000);
assert.equal(whyWrong.ok, true, whyWrong.error);
assert.equal(whyWrong.mode, "why_wrong");
assert.ok(whyWrong.explanation.length >= 40, "live why-wrong explanation should be useful");
assert.equal(whyWrong.sources.length, 2, "live why-wrong explanation should retain both trusted sources");

const chat = await sendMessage({
  type: "orislop.chatVideo",
  candidate: contradictedCandidate,
  decision: contradictedDecision,
  question: "What evidence contradicts the video's claim?",
  history: [],
  settings: { ollamaModel: model, inferenceMode: "local", performanceMode: "fast" }
}, 120000);
assert.equal(chat.ok, true, chat.error);
assert.ok(chat.answer.length >= 30, "live fact-check chat should answer from the supplied evidence");
assert.equal(chat.sources.length, 2, "live fact-check chat should retain both trusted sources");

const linkedInCandidate = {
  platform: "linkedin",
  itemId: "linkedin-launch-check",
  itemKey: "linkedin:linkedin-launch-check",
  itemKind: "profile",
  mediaType: "text",
  fullVideoAnalysisRequested: true,
  url: "https://www.linkedin.com/in/orislop-launch-check/",
  title: "Launch Check Profile",
  channelName: "Launch Check",
  visibleText: "The profile says this person led a 25-person product team and increased customer retention by 42 percent in 2025.",
  imageText: "",
  transcriptText: ""
};
const linkedInDecision = {
  recommendation: "watch",
  score: 0,
  reasons: ["Professional claim needs source verification"],
  factCheckDecision: {
    verdict: "insufficient",
    claim: "The person led a 25-person team and increased retention by 42 percent.",
    summary: "No independent trusted sources were supplied.",
    sources: []
  }
};
const linkedInExplanation = await sendMessage({
  type: "orislop.explainVideo",
  candidate: linkedInCandidate,
  decision: linkedInDecision,
  mode: "explain",
  settings: { ollamaModel: model, inferenceMode: "local", performanceMode: "fast" }
}, 120000);
assert.equal(linkedInExplanation.ok, true, linkedInExplanation.error);
assert.ok(linkedInExplanation.explanation.length >= 40, "live LinkedIn profile explanation should be useful");

const linkedInChat = await sendMessage({
  type: "orislop.chatItem",
  candidate: linkedInCandidate,
  decision: linkedInDecision,
  question: "What does this profile claim, and what remains unverified?",
  history: [],
  settings: { ollamaModel: model, inferenceMode: "local", performanceMode: "fast" }
}, 120000);
assert.equal(linkedInChat.ok, true, linkedInChat.error);
assert.ok(linkedInChat.answer.length >= 30, "live LinkedIn chat should answer from the profile content");

const emptyLinkedInQuestion = await sendMessage({
  type: "orislop.chatItem",
  candidate: linkedInCandidate,
  decision: linkedInDecision,
  question: " ",
  history: [],
  settings: { ollamaModel: model, inferenceMode: "local", performanceMode: "fast" }
}, 10000);
assert.equal(emptyLinkedInQuestion.ok, false);
assert.match(emptyLinkedInQuestion.error, /enter a question/i);

const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  ok: true,
  model,
  origin: extensionOrigin,
  elapsedSeconds: Math.round((performance.now() - timer) / 100) / 10,
  explanationWords: explained.explanation.split(/\s+/).filter(Boolean).length,
  whyWrongWords: whyWrong.explanation.split(/\s+/).filter(Boolean).length,
  factChatWords: chat.answer.split(/\s+/).filter(Boolean).length,
  linkedInExplanationWords: linkedInExplanation.explanation.split(/\s+/).filter(Boolean).length,
  linkedInChatWords: linkedInChat.answer.split(/\s+/).filter(Boolean).length,
  emptyLinkedInQuestionRejected: true,
  verdicts: liveDecisions.map((result) => ({ id: result.id, verdict: result.recommendation, category: result.ollamaDecision?.category || "" }))
};
mkdirSync(artifactRoot, { recursive: true });
writeFileSync(path.join(artifactRoot, "ollama-live-check.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

function candidate(itemId, title, visibleText) {
  return {
    platform: "youtube",
    itemId,
    url: `https://www.youtube.com/shorts/${itemId}`,
    title,
    visibleText,
    transcriptText: "",
    channelName: "Live Check"
  };
}

function sendMessage(message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Live message timed out after ${timeoutMs}ms`)), timeoutMs);
    const asyncResponse = messageListener(message, {}, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
    if (asyncResponse !== true) {
      clearTimeout(timeout);
      reject(new Error(`Background worker did not keep the ${message.type} response channel open`));
    }
  });
}

async function scoreUntilContextSettles(message, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastResponse = null;
  while (Date.now() < deadline) {
    lastResponse = await sendMessage(message, Math.min(110000, Math.max(1000, deadline - Date.now())));
    if (!lastResponse?.ok) return lastResponse;
    if (lastResponse.ollamaStatus === "available"
      && lastResponse.results?.every((result) => result.ollamaUsed === true)) {
      return lastResponse;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Live context scoring did not settle within ${timeoutMs}ms (last status: ${lastResponse?.ollamaStatus || "unknown"})`);
}
