import { describe, expect, test } from "bun:test";
import {
  evaluateSessionForCorpusQuality,
  getQualityProfile,
} from "../src/index";

describe("corpus quality profiles", () => {
  test("falls back to default profile for unknown names", () => {
    const profile = getQualityProfile("definitely-not-a-profile");
    expect(profile.name).toBe("default");
  });

  test("uses profile from environment variable", () => {
    const previous = process.env.AGENT_LOGGER_QUALITY_PROFILE;
    process.env.AGENT_LOGGER_QUALITY_PROFILE = "conservative";
    try {
      const profile = getQualityProfile();
      expect(profile.name).toBe("conservative");
      expect(profile.weights.taskSuccess).toBeLessThan(1);
    } finally {
      process.env.AGENT_LOGGER_QUALITY_PROFILE = previous;
    }
  });

  test("flags short conversations when profile requires minimum turns", () => {
    const evalResult = evaluateSessionForCorpusQuality(
      {
        efficiencyScore: 1,
        taskSuccess: true,
        toolTotal: 2,
        toolCompleted: 2,
        toolErrors: 0,
        toolDurationMs: 1000,
        uniqueToolCount: 1,
        userMessages: 1,
        assistantMessages: 1,
        hasSystemPrompt: false,
      },
      "conservative",
    );
    expect(evalResult.score).toBeGreaterThan(0);
    expect(evalResult.blockers).toContain("conversation_too_short_2");
    expect(evalResult.profileName).toBe("conservative");
  });

  test("scores higher for stronger signal when task succeeds cleanly", () => {
    const weak = evaluateSessionForCorpusQuality({
      efficiencyScore: 0.4,
      taskSuccess: false,
      toolTotal: 1,
      toolCompleted: 1,
      toolErrors: 1,
      toolDurationMs: 2000,
      uniqueToolCount: 1,
      userMessages: 2,
      assistantMessages: 2,
      hasSystemPrompt: true,
    });
    const strong = evaluateSessionForCorpusQuality({
      efficiencyScore: 0.95,
      taskSuccess: true,
      toolTotal: 4,
      toolCompleted: 4,
      toolErrors: 0,
      toolDurationMs: 3000,
      uniqueToolCount: 3,
      userMessages: 3,
      assistantMessages: 3,
      hasSystemPrompt: true,
    });
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.blockers).toHaveLength(0);
  });
});
