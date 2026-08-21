import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(extensionRoot, "src", "productTelemetry.js"), "utf8");
const background = readFileSync(path.join(extensionRoot, "src", "background.js"), "utf8");
const content = readFileSync(path.join(extensionRoot, "src", "contentScript.js"), "utf8");
const popup = readFileSync(path.join(extensionRoot, "src", "popup.html"), "utf8");
const popupJs = readFileSync(path.join(extensionRoot, "src", "popup.js"), "utf8");
const context = { console, Date, Map, Set, Promise, Math, setTimeout, clearTimeout };
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "productTelemetry.js" });
const telemetry = context.OrislopProductTelemetry;

const defaults = {
  eventId: "event_1234567890abcdef",
  installationId: "install_1234567890abcdef",
  sessionId: "session_1234567890abcdef",
  occurredAt: new Date().toISOString(),
  extensionVersion: "1.3.0"
};

const event = telemetry.sanitizeEvent({
  eventName: "scan_batch_completed",
  attributes: {
    platform: "youtube",
    inferenceMode: "hybrid",
    performanceMode: "heavy",
    outcome: "complete",
    durationBucket: "1s_5s",
    batchSize: 10,
    modelIds: ["gonnerthetooner/orislop-fusion", "gonnerthetooner/orislop-fusion"],
    url: "https://private.example/watch/secret",
    title: "Private title",
    captionText: "Private caption"
  }
}, defaults);
assert.equal(event.schemaVersion, 1);
assert.equal(event.attributes.platform, "youtube");
assert.deepEqual(Array.from(event.attributes.modelIds), ["gonnerthetooner/orislop-fusion"]);
assert.equal(event.attributes.url, undefined);
assert.equal(event.attributes.title, undefined);
assert.equal(event.attributes.captionText, undefined);
assert.ok(!JSON.stringify(event).includes("private.example"));
assert.ok(!JSON.stringify(event).includes("Private title"));
assert.ok(telemetry.containsSensitiveMaterial({ mediaUrl: "https://example.com/video" }));
assert.equal(telemetry.sanitizeEvent({ eventName: "unknown_event" }, defaults), null);

let queue = [];
for (let index = 0; index < 230; index += 1) {
  queue = telemetry.appendBounded(queue, telemetry.sanitizeEvent({
    eventName: "adapter_health",
    eventId: `event_${String(index).padStart(16, "0")}`,
    attributes: { platform: "youtube", adapterState: "ready" }
  }, defaults));
}
assert.equal(queue.length, telemetry.MAX_QUEUE_SIZE, "telemetry queue must remain bounded");
const duplicate = telemetry.appendBounded(queue, queue.at(-1));
assert.equal(duplicate.length, telemetry.MAX_QUEUE_SIZE, "duplicate event ids must not grow the queue");

assert.equal(telemetry.shouldRetryRequest({ method: "GET", status: 429, attempt: 0 }), true);
assert.equal(telemetry.shouldRetryRequest({ method: "GET", status: 500, attempt: 0 }), true);
assert.equal(telemetry.shouldRetryRequest({ method: "GET", status: 400, attempt: 0 }), false);
assert.equal(telemetry.shouldRetryRequest({ method: "POST", status: 500, attempt: 0 }), false);
assert.equal(telemetry.shouldRetryRequest({ method: "POST", status: 500, attempt: 0, idempotent: true }), true);
assert.equal(telemetry.retryAfterMilliseconds({ get: () => "3" }), 3000);

async function retryScenario(sequence, options = {}) {
  let calls = 0;
  const retries = [];
  const result = await telemetry.executeWithRetry(async () => {
    const next = sequence[Math.min(calls, sequence.length - 1)];
    calls += 1;
    if (next instanceof Error) throw next;
    return next;
  }, {
    method: "GET",
    maxRetries: 2,
    sleep: async () => {},
    random: () => 0,
    onRetry: (retry) => retries.push(retry),
    ...options
  });
  return { calls, retries, result };
}

assert.equal((await retryScenario([{ status: 200 }])).calls, 1, "successful calls must not retry");
assert.equal((await retryScenario([{ status: 429, headers: { get: () => "1" } }, { status: 200 }])).calls, 2, "429 must retry once and honor Retry-After");
assert.equal((await retryScenario([{ status: 500 }, { status: 200 }])).calls, 2, "transient 500 must retry");
assert.equal((await retryScenario([new TypeError("network"), { status: 200 }])).calls, 2, "network failures must retry");
await assert.rejects(
  retryScenario([Object.assign(new Error("timeout"), { name: "AbortError" })], { maxRetries: 1 }),
  /timeout/,
  "timeouts must stop after the bounded retry budget"
);
assert.equal((await retryScenario([{ status: 400 }, { status: 200 }])).calls, 1, "invalid requests must not retry");
const malformed = await retryScenario([{ status: 200, json: async () => { throw new SyntaxError("malformed"); } }]);
await assert.rejects(malformed.result.json(), /malformed/);
assert.equal(malformed.calls, 1, "malformed success payloads must not be blindly retried");

assert.ok(background.includes("scoreBatchCoalesced"), "background scoring requests must coalesce");
assert.ok(background.includes("TELEMETRY.MAX_BATCH_SIZE"), "uploads must use bounded batches");
assert.ok(background.includes("X-Orislop-Installation-Id"), "uploads must bind the pseudonymous rate identity");
assert.ok(content.includes('eventName: "correction_submitted"') || content.includes('"correction_submitted"'), "local corrections must be instrumented");
assert.ok(popup.includes('id="productAnalyticsToggle"') && popup.includes('id="attentionLogToggle"'));
assert.ok(popupJs.includes("productAnalyticsEnabled: false") && popupJs.includes("attentionLogEnabled: false"), "privacy features must default off");
assert.ok(popup.includes("Never URLs, titles, captions, page text, media, or account details"));

console.log("Product telemetry, retry, dedupe, privacy, and Attention Log checks passed.");
