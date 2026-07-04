import { readFile } from "node:fs/promises";
import { scoreVideo } from "../src/scoreVideo.ts";
import { assertFixtureOutcome } from "./scoreVideo.test.ts";

const FIXTURE_NAMES = [
  "obviousBrainrot",
  "redditTtsStory",
  "fakeTextStory",
  "minecraftParkourFacts",
  "normalComedy",
  "normalEntertainment",
  "educationalUseful",
  "usefulAiExplainer",
  "scammyFinance",
  "riskyHealthClaim",
  "missingTranscript"
];

const fixtureBaseUrl = new URL("./fixtures/", import.meta.url);

let passed = 0;

for (const fixtureName of FIXTURE_NAMES) {
  const fixture = await readFixture(fixtureName);
  const result = scoreVideo(fixture.short, fixture.settings, fixture.options);
  assertFixtureOutcome(fixtureName, result, fixture.expect);
  passed += 1;
}

await assertUserPreferenceChecks();

console.log(`Phase 3 fixture checks passed (${passed} fixtures + user preference checks).`);

async function readFixture(fixtureName) {
  const url = new URL(`${fixtureName}.json`, fixtureBaseUrl);
  return JSON.parse(await readFile(url, "utf8"));
}

async function assertUserPreferenceChecks() {
  const obviousBrainrot = await readFixture("obviousBrainrot");
  const allowed = scoreVideo(obviousBrainrot.short, undefined, {
    userPreferences: {
      alwaysAllowChannels: [obviousBrainrot.short.channelName]
    }
  });
  assertFixtureOutcome("userPreferenceAlwaysAllow", allowed, {
    action: "allow",
    skipReason: null,
    categoriesInclude: ["high_value_content"],
    evidenceReasonIdsInclude: ["user_preference_always_allow_channel"]
  });

  const normalEntertainment = await readFixture("normalEntertainment");
  const blocked = scoreVideo(normalEntertainment.short, undefined, {
    userPreferences: {
      alwaysBlockChannels: [normalEntertainment.short.channelName]
    }
  });
  assertFixtureOutcome("userPreferenceAlwaysBlock", blocked, {
    action: "skip",
    skipReason: "user_blocked",
    categoriesInclude: ["user_blocked"],
    evidenceReasonIdsInclude: ["user_preference_always_block_channel"]
  });
}
