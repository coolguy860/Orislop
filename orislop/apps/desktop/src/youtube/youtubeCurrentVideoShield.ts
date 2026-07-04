export function getYouTubeCurrentVideoShieldScript(reason: string): string {
  return `(${browserShieldCurrentVideo.toString()})(${JSON.stringify(reason)});`;
}

export function getYouTubeClearCurrentVideoShieldScript(): string {
  return `(${browserClearCurrentVideoShield.toString()})();`;
}

function browserShieldCurrentVideo(reason: string): boolean {
  try {
    const shieldId = "orislop-current-video-shield";
    const player = document.querySelector<HTMLElement>("#movie_player, ytd-player, #player");
    const video = document.querySelector<HTMLVideoElement>("video");
    const host = player ?? video?.parentElement ?? document.body;
    if (!host) {
      return false;
    }

    video?.pause();
    host.style.position = host.style.position || "relative";
    host.querySelector(`#${shieldId}`)?.remove();

    const shield = document.createElement("div");
    shield.id = shieldId;
    shield.setAttribute("role", "status");
    shield.setAttribute("aria-live", "polite");
    shield.textContent = reason || "Orislop hid this video based on your settings.";
    Object.assign(shield.style, {
      alignItems: "center",
      background: "rgba(12, 18, 24, 0.96)",
      color: "#fff",
      display: "flex",
      font: "600 18px system-ui, sans-serif",
      inset: "0",
      justifyContent: "center",
      lineHeight: "1.35",
      padding: "24px",
      position: "absolute",
      textAlign: "center",
      zIndex: "2147483647"
    });

    host.appendChild(shield);
    return true;
  } catch {
    return false;
  }
}

function browserClearCurrentVideoShield(): boolean {
  try {
    document.querySelector("#orislop-current-video-shield")?.remove();
    return true;
  } catch {
    return false;
  }
}
