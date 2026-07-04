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
  ipcMain.handle("orislop:listFixtures", () => service.listFixtures());
  ipcMain.handle("orislop:scoreShort", (_event, payload) => service.scoreShort(readScorePayload(payload)));
  ipcMain.handle("orislop:getSettings", () => service.getSettings());
  ipcMain.handle("orislop:updateSettings", (_event, payload) => service.updateSettings(readSettingsPatch(payload)));
  ipcMain.handle("orislop:resetSettings", () => service.resetSettings());
  ipcMain.handle("orislop:saveFeedback", (_event, payload) => service.saveFeedback(readFeedbackPayload(payload)));
  ipcMain.handle("orislop:saveCalibrationLabel", (_event, payload) => service.saveCalibrationLabel(readCalibrationLabelPayload(payload)));
  ipcMain.handle("orislop:listCalibrationLabels", () => service.listCalibrationLabels());
  ipcMain.handle("orislop:exportCalibrationLabels", () => service.exportCalibrationLabels());
  ipcMain.handle("orislop:importCalibrationLabels", (_event, payload) => service.importCalibrationLabels(readCalibrationImportPayload(payload)));
  ipcMain.handle("orislop:getCachedScore", (_event, payload) => service.getCachedScore(readScorePayload(payload)));
  ipcMain.handle("orislop:scoreLookaheadCandidates", (_event, payload) => service.scoreLookaheadCandidates(readScoreLookaheadPayload(payload)));
  ipcMain.handle("orislop:clearCache", () => service.clearCache());
  ipcMain.handle("orislop:forceRescan", (_event, payload) => service.forceRescan(readScorePayload(payload)));
  ipcMain.handle("orislop:getSkipHistory", () => service.getSkipHistory());
  ipcMain.handle("orislop:markScrolledBack", (_event, payload) => service.markScrolledBack(readScorePayload(payload)));
  ipcMain.handle("orislop:markWatchedAnyway", (_event, payload) => service.markWatchedAnyway(readScorePayload(payload)));
}
