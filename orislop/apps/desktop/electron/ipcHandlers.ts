import type { DesktopMockService } from "./desktopService.ts";
import {
  readCalibrationImportPayload,
  readCalibrationLabelPayload,
  readFeedbackPayload,
  readScoreLookaheadPayload,
  readScorePayload,
  readSettingsPatch
} from "./ipcValidation.ts";

type IpcMainLike = {
  handle: (
    channel: string,
    listener: (event: unknown, payload?: unknown) => Promise<unknown> | unknown
  ) => void;
};

export function registerOrislopIpcHandlers(
  ipcMain: IpcMainLike,
  service: DesktopMockService
): void {
  const handle = (
    channel: string,
    listener: (payload?: unknown) => Promise<unknown> | unknown
  ): void => {
    ipcMain.handle(channel, (event, payload) => {
      assertTrustedIpcSender(event);
      return listener(payload);
    });
  };

  handle("orislop:listFixtures", () => service.listFixtures());
  handle("orislop:scoreShort", (payload) => service.scoreShort(readScorePayload(payload)));
  handle("orislop:getSettings", () => service.getSettings());
  handle("orislop:updateSettings", (payload) => service.updateSettings(readSettingsPatch(payload)));
  handle("orislop:resetSettings", () => service.resetSettings());
  handle("orislop:saveFeedback", (payload) => service.saveFeedback(readFeedbackPayload(payload)));
  handle("orislop:saveCalibrationLabel", (payload) => service.saveCalibrationLabel(readCalibrationLabelPayload(payload)));
  handle("orislop:listCalibrationLabels", () => service.listCalibrationLabels());
  handle("orislop:exportCalibrationLabels", () => service.exportCalibrationLabels());
  handle("orislop:importCalibrationLabels", (payload) => service.importCalibrationLabels(readCalibrationImportPayload(payload)));
  handle("orislop:getCachedScore", (payload) => service.getCachedScore(readScorePayload(payload)));
  handle("orislop:scoreLookaheadCandidates", (payload) => service.scoreLookaheadCandidates(readScoreLookaheadPayload(payload)));
  handle("orislop:clearCache", () => service.clearCache());
  handle("orislop:forceRescan", (payload) => service.forceRescan(readScorePayload(payload)));
  handle("orislop:getSkipHistory", () => service.getSkipHistory());
  handle("orislop:markScrolledBack", (payload) => service.markScrolledBack(readScorePayload(payload)));
  handle("orislop:markWatchedAnyway", (payload) => service.markWatchedAnyway(readScorePayload(payload)));
}

export function assertTrustedIpcSender(event: unknown): void {
  if (typeof event !== "object" || event === null) {
    throw new Error("Rejected IPC call without a trusted sender frame.");
  }

  const senderFrame = (event as { senderFrame?: { url?: unknown } | null }).senderFrame;
  if (!senderFrame || typeof senderFrame.url !== "string") {
    throw new Error("Rejected IPC call without a trusted sender frame.");
  }

  try {
    const senderUrl = new URL(senderFrame.url);
    if (senderUrl.protocol !== "file:") {
      throw new Error("Rejected IPC call from an untrusted renderer origin.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Rejected IPC")) {
      throw error;
    }
    throw new Error("Rejected IPC call from an invalid renderer origin.");
  }
}
