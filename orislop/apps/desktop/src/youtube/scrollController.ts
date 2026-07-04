export type SafeScrollTarget = {
  focus?: () => void;
  sendInputEvent?: (event: Record<string, unknown>) => void;
  executeJavaScript?: (script: string, userGesture?: boolean) => Promise<unknown>;
};

export type ScrollAttemptResult = {
  attempted: boolean;
  succeeded: boolean;
  method: "webview_arrow_down" | "dom_keyboard" | "none" | "debounced";
  reason: string | null;
};

export type ScrollControllerOptions = {
  debounceMs?: number;
  now?: () => number;
};

export function createScrollController(options: ScrollControllerOptions = {}) {
  const debounceMs = options.debounceMs ?? 900;
  const now = options.now ?? (() => Date.now());
  let lastAttemptAt = Number.NEGATIVE_INFINITY;

  return {
    async attemptNextShort(target: SafeScrollTarget | null): Promise<ScrollAttemptResult> {
      const currentTime = now();
      if (currentTime - lastAttemptAt < debounceMs) {
        return {
          attempted: false,
          succeeded: false,
          method: "debounced",
          reason: "Scroll attempt debounced."
        };
      }
      lastAttemptAt = currentTime;

      if (!target) {
        return failed("No scroll target is available.");
      }

      try {
        target.focus?.();

        if (target.sendInputEvent) {
          target.sendInputEvent({ type: "keyDown", keyCode: "ArrowDown" });
          target.sendInputEvent({ type: "keyUp", keyCode: "ArrowDown" });
          return {
            attempted: true,
            succeeded: true,
            method: "webview_arrow_down",
            reason: null
          };
        }

        if (target.executeJavaScript) {
          const result = await target.executeJavaScript(`
            (() => {
              window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true }));
              window.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown", code: "ArrowDown", bubbles: true }));
              window.scrollBy({ top: Math.max(window.innerHeight * 0.85, 480), behavior: "smooth" });
              return true;
            })();
          `, true);

          return {
            attempted: true,
            succeeded: result !== false,
            method: "dom_keyboard",
            reason: result === false ? "Page script declined scroll." : null
          };
        }
      } catch (error) {
        return failed(error instanceof Error ? error.message : "Scroll attempt failed.");
      }

      return failed("No safe scroll method is available.");
    },

    reset(): void {
      lastAttemptAt = Number.NEGATIVE_INFINITY;
    }
  };
}

function failed(reason: string): ScrollAttemptResult {
  return {
    attempted: true,
    succeeded: false,
    method: "none",
    reason
  };
}
