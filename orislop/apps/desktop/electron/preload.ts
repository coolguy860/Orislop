const { contextBridge, ipcRenderer } = require("electron");

const api = {
  listFixtures: () => ipcRenderer.invoke("orislop:listFixtures"),
  scoreShort: (payload: unknown) => ipcRenderer.invoke("orislop:scoreShort", payload),
  scoreExtractedShort: (short: unknown) => ipcRenderer.invoke("orislop:scoreShort", { short }),
  getSettings: () => ipcRenderer.invoke("orislop:getSettings"),
  updateSettings: (payload: unknown) => ipcRenderer.invoke("orislop:updateSettings", payload),
  resetSettings: () => ipcRenderer.invoke("orislop:resetSettings"),
  saveFeedback: (payload: unknown) => ipcRenderer.invoke("orislop:saveFeedback", payload),
  saveCalibrationLabel: (payload: unknown) => ipcRenderer.invoke("orislop:saveCalibrationLabel", payload),
  listCalibrationLabels: () => ipcRenderer.invoke("orislop:listCalibrationLabels"),
  exportCalibrationLabels: () => ipcRenderer.invoke("orislop:exportCalibrationLabels"),
  importCalibrationLabels: (payload: unknown) => ipcRenderer.invoke("orislop:importCalibrationLabels", payload),
  getCachedScore: (payload: unknown) => ipcRenderer.invoke("orislop:getCachedScore", payload),
  getCachedExtractedShort: (short: unknown) => ipcRenderer.invoke("orislop:getCachedScore", { short }),
  scoreLookaheadCandidates: (payload: unknown) => ipcRenderer.invoke("orislop:scoreLookaheadCandidates", payload),
  clearCache: () => ipcRenderer.invoke("orislop:clearCache"),
  forceRescan: (payload: unknown) => ipcRenderer.invoke("orislop:forceRescan", payload),
  forceRescanExtractedShort: (short: unknown) => ipcRenderer.invoke("orislop:forceRescan", { short }),
  getSkipHistory: () => ipcRenderer.invoke("orislop:getSkipHistory"),
  markScrolledBack: (payload: unknown) => ipcRenderer.invoke("orislop:markScrolledBack", payload),
  markWatchedAnyway: (payload: unknown) => ipcRenderer.invoke("orislop:markWatchedAnyway", payload)
};

contextBridge.exposeInMainWorld("orislop", api);
