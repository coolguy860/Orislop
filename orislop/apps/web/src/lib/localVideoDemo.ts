export type LocalVideoPrototypeResult = {
  sampledFrames: number;
  averageFrameChange: number;
  visualRepetition: number;
  pacing: "slow" | "normal" | "rapid";
};

export async function analyzeLocalVideoPrototype(file: File): Promise<LocalVideoPrototypeResult> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) {
    URL.revokeObjectURL(url);
    throw new Error("Canvas analysis is unavailable in this browser.");
  }

  try {
    video.muted = true;
    video.preload = "metadata";
    video.src = url;
    await once(video, "loadedmetadata");
    if (video.readyState < 2) {
      await once(video, "loadeddata");
    }

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
    const samples = Math.min(12, Math.max(4, Math.floor(duration)));
    canvas.width = 96;
    canvas.height = 54;

    let previous: Uint8ClampedArray | null = null;
    const changes: number[] = [];

    for (let index = 0; index < samples; index += 1) {
      const latestSafeTime = Math.max(0, duration - 0.05);
      await seekTo(video, Math.min(latestSafeTime, (duration * index) / samples));
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      if (previous) {
        changes.push(frameDifference(previous, data));
      }
      previous = new Uint8ClampedArray(data);
    }

    const averageFrameChange = changes.length > 0
      ? changes.reduce((sum, value) => sum + value, 0) / changes.length
      : 0;
    const visualRepetition = Math.max(0, Math.min(1, 1 - averageFrameChange * 2.8));
    const pacing = averageFrameChange > 0.18 ? "rapid" : averageFrameChange < 0.04 ? "slow" : "normal";

    return {
      sampledFrames: samples,
      averageFrameChange: Number(averageFrameChange.toFixed(3)),
      visualRepetition: Number(visualRepetition.toFixed(3)),
      pacing
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function frameDifference(left: Uint8ClampedArray, right: Uint8ClampedArray): number {
  const length = Math.min(left.length, right.length);
  let total = 0;
  for (let index = 0; index < length; index += 4) {
    total += Math.abs(left[index] - right[index]) / 255;
    total += Math.abs(left[index + 1] - right[index + 1]) / 255;
    total += Math.abs(left[index + 2] - right[index + 2]) / 255;
  }

  return total / ((length / 4) * 3);
}

function once(target: HTMLMediaElement, eventName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      target.removeEventListener(eventName, onEvent);
      target.removeEventListener("error", onError);
    };
    const onEvent = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("Unable to read local video file."));
    };
    target.addEventListener(eventName, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(video.currentTime - time) < 0.01 && video.readyState >= 2) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    const onSeeked = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("Unable to seek local video file."));
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = time;
  });
}
