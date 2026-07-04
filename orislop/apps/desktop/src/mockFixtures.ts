import type { ExtractedShort } from "../../../packages/shared/src/types.ts";

export type MockShortFixture = {
  id: string;
  label: string;
  description: string;
  short: ExtractedShort;
};

export const MOCK_SHORT_FIXTURES: MockShortFixture[] = [
  {
    id: "obvious-brainrot",
    label: "Obvious Brainrot",
    description: "Engagement bait with template/minecraft metadata.",
    short: {
      url: "https://www.youtube.com/shorts/mock-obvious-brainrot",
      videoId: "mock-obvious-brainrot",
      title: "You won't believe this minecraft parkour secret trick!!!",
      channelName: "ClipsMax",
      channelUrl: "https://www.youtube.com/@clipsmax",
      description: "Watch till the end before they take this down. Like and follow for part 2.",
      hashtags: ["brainrot", "minecraftparkour"],
      visiblePageText: "satisfying background mobile game background",
      hasPlatformAiLabel: false,
      platformAiLabelText: null,
      transcript: "Watch till the end wait for it. Like and follow, subscribe for more, wait for it."
    }
  },
  {
    id: "normal-comedy",
    label: "Normal Comedy",
    description: "Comedy/satire with claim-like wording.",
    short: {
      url: "https://www.youtube.com/shorts/mock-normal-comedy",
      videoId: "mock-normal-comedy",
      title: "POV scientists found pizza makes Mondays illegal",
      channelName: "StudioBits",
      channelUrl: "https://www.youtube.com/@studiobits",
      description: "A short comedy skit with an absurd punchline.",
      hashtags: ["comedy", "skit"],
      visiblePageText: "comedy skit",
      hasPlatformAiLabel: false,
      platformAiLabelText: null,
      transcript: "POV scientists found pizza makes Mondays illegal, and everyone laughs. This is a comedy skit, not advice."
    }
  },
  {
    id: "useful-ai-explainer",
    label: "Useful AI Explainer",
    description: "Educational video with a platform AI label.",
    short: {
      url: "https://www.youtube.com/shorts/mock-useful-ai-explainer",
      videoId: "mock-useful-ai-explainer",
      title: "AI-generated explainer: how transformers work",
      channelName: "Model Notes",
      channelUrl: "https://www.youtube.com/@modelnotes",
      description: "Educational guide to attention layers.",
      hashtags: ["ai", "education"],
      visiblePageText: "Altered or synthetic content",
      hasPlatformAiLabel: true,
      platformAiLabelText: "Altered or synthetic content",
      transcript: "This lesson explains how attention layers compare tokens and combine context in a transformer model."
    }
  },
  {
    id: "scammy-finance",
    label: "Scammy Finance",
    description: "High-risk finance/scam language.",
    short: {
      url: "https://www.youtube.com/shorts/mock-scammy-finance",
      videoId: "mock-scammy-finance",
      title: "Guaranteed returns with my crypto signals",
      channelName: "Signal Vault",
      channelUrl: "https://www.youtube.com/@signalvault",
      description: "Limited spots in my telegram group. DM me for guaranteed profit.",
      hashtags: ["crypto", "money"],
      visiblePageText: "copy my trades risk free",
      hasPlatformAiLabel: false,
      platformAiLabelText: null,
      transcript: "Copy my trades in my telegram group. Guaranteed returns are waiting if you join before the limited spots close."
    }
  },
  {
    id: "missing-transcript",
    label: "Missing Transcript",
    description: "Normal entertainment with no transcript signal.",
    short: {
      url: "https://www.youtube.com/shorts/mock-missing-transcript",
      videoId: "mock-missing-transcript",
      title: "Calm woodworking vlog",
      channelName: "Bench Notes",
      channelUrl: "https://www.youtube.com/@benchnotes",
      description: "A normal entertainment clip from the shop.",
      hashtags: ["woodworking", "vlog"],
      visiblePageText: "normal entertainment vlog",
      hasPlatformAiLabel: false,
      platformAiLabelText: null,
      transcript: null
    }
  }
];
