import type {
  ContentIntent,
  OrislopAction,
  OrislopScoreResult,
  SignalResult
} from "../src/types.ts";

export type SignalExpectation = {
  name: string;
  applicable?: boolean;
  scoreIsNull?: boolean;
};

export type ScoreFloorExpectation = {
  slopScore?: number;
  claimRiskScore?: number;
  aiGeneratedScore?: number;
  possibleUnlabeledAiScore?: number;
  skipProbability?: number;
};

export type ScoreCeilingExpectation = {
  slopScore?: number;
  claimRiskScore?: number;
  aiGeneratedScore?: number;
  possibleUnlabeledAiScore?: number;
  skipProbability?: number;
};

export type FixtureExpectation = {
  action?: OrislopAction;
  skipReason?: string | null;
  userFacingReasonIncludes?: string;
  contentIntent?: ContentIntent;
  categoriesInclude?: string[];
  categoriesExclude?: string[];
  evidenceReasonIdsInclude?: string[];
  settingsAppliedInclude?: string[];
  signals?: SignalExpectation[];
  minScores?: ScoreFloorExpectation;
  maxScores?: ScoreCeilingExpectation;
};

export function assertFixtureOutcome(
  fixtureName: string,
  result: OrislopScoreResult,
  expected: FixtureExpectation
): void {
  assertMachineReadableEvidence(fixtureName, result);
  assertNonApplicableSignalsUseNullScore(fixtureName, result.signals);

  if (expected.action !== undefined) {
    assertEqual(fixtureName, "action", result.action, expected.action);
  }

  if ("skipReason" in expected) {
    assertEqual(fixtureName, "skipReason", result.skipReason, expected.skipReason ?? null);
  }

  if (expected.userFacingReasonIncludes !== undefined) {
    assertIncludes(
      fixtureName,
      "userFacingReason",
      result.userFacingReason ?? "",
      expected.userFacingReasonIncludes
    );
  }

  if (expected.contentIntent !== undefined) {
    assertEqual(fixtureName, "contentIntent", result.contentIntent, expected.contentIntent);
  }

  for (const category of expected.categoriesInclude ?? []) {
    assertArrayIncludes(fixtureName, "categories", result.categories, category);
  }

  for (const category of expected.categoriesExclude ?? []) {
    assertArrayExcludes(fixtureName, "categories", result.categories, category);
  }

  const reasonIds = result.evidence.map((item) => item.reasonId);
  for (const reasonId of expected.evidenceReasonIdsInclude ?? []) {
    assertArrayIncludes(fixtureName, "evidence.reasonId", reasonIds, reasonId);
  }

  for (const settingName of expected.settingsAppliedInclude ?? []) {
    assertArrayIncludes(fixtureName, "settingsApplied", result.settingsApplied, settingName);
  }

  for (const signalExpectation of expected.signals ?? []) {
    assertSignalExpectation(fixtureName, result.signals, signalExpectation);
  }

  assertScoreFloors(fixtureName, result, expected.minScores);
  assertScoreCeilings(fixtureName, result, expected.maxScores);
}

function assertSignalExpectation(
  fixtureName: string,
  signals: SignalResult[],
  expected: SignalExpectation
): void {
  const signal = signals.find((item) => item.name === expected.name);
  if (!signal) {
    throw new Error(`${fixtureName}: expected signal "${expected.name}" to be present.`);
  }

  if (expected.applicable !== undefined) {
    assertEqual(fixtureName, `${expected.name}.applicable`, signal.applicable, expected.applicable);
  }

  if (expected.scoreIsNull !== undefined) {
    assertEqual(fixtureName, `${expected.name}.scoreIsNull`, signal.score === null, expected.scoreIsNull);
  }
}

function assertMachineReadableEvidence(fixtureName: string, result: OrislopScoreResult): void {
  for (const evidence of result.evidence) {
    if (!/^[a-z0-9_]+$/.test(evidence.reasonId)) {
      throw new Error(`${fixtureName}: evidence reasonId is not machine-readable: ${evidence.reasonId}`);
    }
  }
}

function assertNonApplicableSignalsUseNullScore(
  fixtureName: string,
  signals: SignalResult[]
): void {
  for (const signal of signals) {
    if (!signal.applicable && signal.score !== null) {
      throw new Error(`${fixtureName}: non-applicable signal "${signal.name}" used score ${signal.score}.`);
    }
  }
}

function assertScoreFloors(
  fixtureName: string,
  result: OrislopScoreResult,
  floors: ScoreFloorExpectation | undefined
): void {
  if (!floors) {
    return;
  }

  for (const [field, floor] of Object.entries(floors)) {
    const value = result[field as keyof ScoreFloorExpectation];
    if (typeof value !== "number" || value < floor) {
      throw new Error(`${fixtureName}: expected ${field} >= ${floor}, got ${String(value)}.`);
    }
  }
}

function assertScoreCeilings(
  fixtureName: string,
  result: OrislopScoreResult,
  ceilings: ScoreCeilingExpectation | undefined
): void {
  if (!ceilings) {
    return;
  }

  for (const [field, ceiling] of Object.entries(ceilings)) {
    const value = result[field as keyof ScoreCeilingExpectation];
    if (typeof value !== "number" || value > ceiling) {
      throw new Error(`${fixtureName}: expected ${field} <= ${ceiling}, got ${String(value)}.`);
    }
  }
}

function assertEqual<T>(
  fixtureName: string,
  field: string,
  actual: T,
  expected: T
): void {
  if (actual !== expected) {
    throw new Error(`${fixtureName}: expected ${field} to be ${String(expected)}, got ${String(actual)}.`);
  }
}

function assertIncludes(
  fixtureName: string,
  field: string,
  actual: string,
  expectedSubstring: string
): void {
  if (!actual.includes(expectedSubstring)) {
    throw new Error(`${fixtureName}: expected ${field} to include "${expectedSubstring}", got "${actual}".`);
  }
}

function assertArrayIncludes(
  fixtureName: string,
  field: string,
  actual: string[],
  expected: string
): void {
  if (!actual.includes(expected)) {
    throw new Error(`${fixtureName}: expected ${field} to include "${expected}", got [${actual.join(", ")}].`);
  }
}

function assertArrayExcludes(
  fixtureName: string,
  field: string,
  actual: string[],
  expected: string
): void {
  if (actual.includes(expected)) {
    throw new Error(`${fixtureName}: expected ${field} to exclude "${expected}", got [${actual.join(", ")}].`);
  }
}
