import { analyzeLocalVideoPrototype, type LocalVideoPrototypeResult } from "./lib/localVideoDemo";
import {
  FEED_SCAN_LIMIT,
  parseFeedCandidates,
  scanFeedCandidates,
  type FeedScanResult
} from "./lib/feedFilter";
import { scoreStaticSlop, type StaticScoreResult, type StaticStrictness } from "./lib/staticSlopScore";
import {
  clearFlaggedRecords,
  DEFAULT_WEB_SETTINGS,
  loadFlaggedRecords,
  loadFeedbackRecords,
  loadWebSettings,
  saveFeedbackRecord,
  saveFlaggedRecords,
  saveWebSettings,
  type WebFlaggedRecord,
  type WebFeedbackRecord
} from "./lib/storage";
import { parseYouTubeUrl } from "./lib/youtube";

type AnalyzerState = {
  url: string;
  title: string;
  description: string;
};

const DEFAULT_ANALYZER: AnalyzerState = {
  url: "https://www.youtube.com/shorts/abc123",
  title: "AI voice viral clips compilation",
  description: "No commentary, source unknown. Watch till the end."
};

const SAMPLE_FEED_INPUT = [
  "https://www.youtube.com/watch?v=abc123 | How rainfall forms in mountain regions | A calm explanation of evaporation and condensation.",
  "https://www.youtube.com/shorts/brain001 | AI voice viral clips compilation!!! | Watch till the end. Source unknown. Like and follow for part 2.",
  "https://youtu.be/cooking77 | 15 minute garlic noodles | Clear steps, ingredients, and useful cooking notes.",
  "https://www.youtube.com/shorts/hash999 | #viral #fyp #shorts #ai |",
  "https://www.youtube.com/watch?v=scam777 | This finance trick banks hate | Guaranteed passive income. Before they delete this.",
  "https://www.youtube.com/shorts/game555 | Reddit story with Minecraft parkour | Text to speech story over mobile game background.",
  "https://www.youtube.com/watch?v=music44 | Repeating chorus practice | Song demo with repeated lyrics and performance notes.",
  "https://youtu.be/history12 | Why ancient roads mattered | Educational context with specific examples.",
  "https://www.youtube.com/shorts/clone22 | Synthetic voice celebrity deepfake | AI generated voice clone compilation.",
  "https://www.youtube.com/watch?v=repair31 | Fixing a loose bike brake | Useful repair walkthrough.",
  "https://www.youtube.com/shorts/bonus11 | You won't believe this satisfying background | Follow for more.",
  "https://youtu.be/science88 | Basic telescope alignment | Practical science tutorial."
].join("\n");

export function mountApp(root: HTMLElement): void {
  let settings = loadWebSettings();
  let form: AnalyzerState = { ...DEFAULT_ANALYZER };
  let result: StaticScoreResult | null = scoreCurrentForm();
  let feedback = loadFeedbackRecords();
  let feedInput = SAMPLE_FEED_INPUT;
  let feedResults: FeedScanResult[] = scanFeedCandidates(parseFeedCandidates(feedInput), settings.strictness, FEED_SCAN_LIMIT);
  let flaggedLog = loadFlaggedRecords();
  let showHiddenFeed = false;
  let localVideoResult: LocalVideoPrototypeResult | null = null;
  let localVideoError: string | null = null;

  render();

  function scoreCurrentForm(): StaticScoreResult {
    return scoreStaticSlop({
      url: form.url,
      title: form.title,
      description: form.description,
      strictness: settings.strictness
    });
  }

  function render(): void {
    root.innerHTML = `
      <main class="site-shell">
        <section class="hero">
          <div class="hero__copy">
            <p class="eyebrow">Orislop clean feed prototype</p>
            <h1>Detect online slop before it wastes your time.</h1>
            <p class="hero__subhead">
              Orislop is an early browser prototype that flags brainrot, spammy AI clips,
              engagement bait, and low-value videos before users get stuck scrolling.
            </p>
            <div class="hero__actions">
              <a class="primary-link" href="#analyzer">Analyze a YouTube link</a>
              <a class="secondary-link" href="#clean-feed">View clean feed</a>
              <a class="secondary-link" href="./downloads/orislop-browser-extension.zip" download>Download extension</a>
            </div>
            <div class="hero__trust-strip" aria-label="Prototype guarantees">
              <span>Static hosting</span>
              <span>No account</span>
              <span>No secret API keys</span>
            </div>
          </div>
          <div class="hero__product" aria-label="Orislop clean feed product preview">
            <div class="product-chrome">
              <span></span>
              <span></span>
              <span></span>
              <strong>orislop.com</strong>
            </div>
            <div class="product-visual">
              <div class="product-visual__header">
                <span>Next 10 scan</span>
                <strong>4 hidden</strong>
              </div>
              <div class="product-feed-row product-feed-row--watch">
                <div class="product-thumb product-thumb--green"></div>
                <div>
                  <strong>Useful repair walkthrough</strong>
                  <span>Watch - 12/100</span>
                </div>
              </div>
              <div class="product-feed-row product-feed-row--hidden">
                <div class="product-thumb product-thumb--red"></div>
                <div>
                  <strong>AI voice viral clips compilation</strong>
                  <span>Hidden - slop pattern stack</span>
                </div>
              </div>
              <div class="product-feed-row product-feed-row--questionable">
                <div class="product-thumb product-thumb--amber"></div>
                <div>
                  <strong>This finance trick banks hate</strong>
                  <span>Questionable - claim risk</span>
                </div>
              </div>
              <div class="product-log-strip">
                <span>Flagged log</span>
                <strong>Saved locally</strong>
              </div>
            </div>
          </div>
        </section>

        <section class="download-section panel" id="extension-download">
          <div class="download-copy">
            <p class="eyebrow">Browser extension</p>
            <h2>Make Orislop work directly on YouTube.</h2>
            <p>
              The static website is the public demo. The browser extension is what can run on YouTube,
              inspect visible video cards, hide Skip-scored videos, outline Questionable videos, and
              keep a local flagged log in your browser.
            </p>
          </div>
          <div class="download-card">
            <a class="download-button" href="./downloads/orislop-browser-extension.zip" download>
              Download Orislop extension
            </a>
            <ol class="install-list">
              <li>Unzip the download.</li>
              <li>Open <code>chrome://extensions</code> or <code>edge://extensions</code>.</li>
              <li>Enable Developer mode.</li>
              <li>Choose Load unpacked and select the unzipped folder.</li>
            </ol>
            <p class="prototype-note">
              No API key, no video downloads, no server. This extension uses lightweight local scoring.
            </p>
          </div>
        </section>

        <section id="analyzer" class="section-grid">
          <div class="panel analyzer-panel">
            <div class="panel__header">
              <div>
                <p class="eyebrow">Analyzer</p>
                <h2>YouTube URL analyzer</h2>
              </div>
              <label class="field compact-field">
                <span>Strictness</span>
                <select id="strictnessSelect">
                  <option value="relaxed">Relaxed</option>
                  <option value="balanced">Balanced</option>
                  <option value="strict">Strict</option>
                </select>
              </label>
            </div>

            <label class="field">
              <span>YouTube URL</span>
              <input id="urlInput" placeholder="https://www.youtube.com/watch?v=..." />
            </label>
            <label class="field">
              <span>Optional title</span>
              <input id="titleInput" placeholder="Paste the visible title if YouTube does not expose it" />
            </label>
            <label class="field">
              <span>Optional description or caption</span>
              <textarea id="descriptionInput" rows="5" placeholder="Paste caption/description text for better static scoring"></textarea>
            </label>
            <button class="primary-button" id="analyzeButton" type="button">Analyze</button>

            <p class="prototype-note">
              This static MVP scores URL/title/caption signals in your browser. It does not scrape YouTube,
              download videos, use a secret API key, or run the full PyTorch temporal detector.
            </p>
          </div>

          <div class="panel preview-panel">
            <p class="eyebrow">Preview</p>
            <h2>Official YouTube embed</h2>
            <div id="previewHost"></div>
            <dl class="parse-grid">
              <div><dt>Video ID</dt><dd id="videoIdValue"></dd></div>
              <div><dt>Kind</dt><dd id="videoKindValue"></dd></div>
            </dl>
          </div>

          <section id="scoreHost"></section>
        </section>

        <section id="clean-feed" class="feed-layout">
          <div class="panel feed-panel">
            <div class="panel__header">
              <div>
                <p class="eyebrow">Clean feed demo</p>
                <h2>Scan the next 10 videos before they reach your attention</h2>
              </div>
              <label class="toggle-field">
                <input id="showHiddenToggle" type="checkbox" />
                <span>Show hidden</span>
              </label>
            </div>
            <p>
              Paste one candidate per line using: URL | title | caption. Or use the sample queue below.
              Orislop checks the next ${FEED_SCAN_LIMIT}, keeps useful videos visible, and hides Skip items
              inside this static website demo.
            </p>
            <textarea id="feedInput" class="feed-input" rows="9"></textarea>
            <button id="scanFeedButton" class="primary-button" type="button">Scan next 10</button>
            <div id="feedSummary" class="feed-summary"></div>
            <div id="cleanFeedHost" class="clean-feed"></div>
          </div>

          <aside class="panel flagged-log-panel">
            <div class="panel__header">
              <div>
                <p class="eyebrow">Flagged log</p>
                <h2>What Orislop removed or questioned</h2>
              </div>
              <button id="clearFlaggedLogButton" class="ghost-button" type="button">Clear</button>
            </div>
            <div id="flaggedLogHost" class="flagged-log"></div>
          </aside>
        </section>

        <section class="info-grid">
          <article class="panel">
            <p class="eyebrow">Temporal detector</p>
            <h2>What the larger Orislop pipeline is designed to do</h2>
            <p>
              Orislop's full temporal detector concept analyzes behavior over time, not just a single
              frame. The larger pipeline can compare frame sequences, pacing, motion, and temporal
              artifacts to detect synthetic or low-value video patterns.
            </p>
            <p>
              This static web build currently uses lightweight client-side scoring. It does not claim
              to run the full PyTorch temporal detector on Namecheap shared hosting.
            </p>
          </article>

          <article class="panel">
            <p class="eyebrow">Local video demo</p>
            <h2>Browser-only frame sampling prototype</h2>
            <p>
              Optional local upload mode samples frames with a browser video element and canvas. It
              estimates visual repetition, frame change intensity, and pacing. This is not the full ML model.
            </p>
            <label class="file-drop">
              <span>Choose local video</span>
              <input id="localVideoInput" type="file" accept="video/*" />
            </label>
            <div id="localVideoResultHost"></div>
          </article>

          <article class="panel">
            <p class="eyebrow">Privacy</p>
            <h2>Static prototype privacy note</h2>
            <p>
              Analysis runs locally in your browser for this static prototype. No account is required.
              Feedback and settings are saved in local browser storage on your device.
            </p>
          </article>
        </section>

        <footer class="footer">
          <span>Built by Aarush Shah</span>
          <span>Static MVP. Full detector pipeline not included in this hosted build.</span>
          <span id="feedbackCount"></span>
        </footer>
      </main>
    `;

    bindForm();
    renderPreview();
    renderScore();
    renderFeed();
    renderFlaggedLog();
    renderLocalVideoResult();
    setText("feedbackCount", `Saved feedback: ${feedback.length}`);
  }

  function bindForm(): void {
    const strictnessSelect = getElement<HTMLSelectElement>("strictnessSelect");
    const urlInput = getElement<HTMLInputElement>("urlInput");
    const titleInput = getElement<HTMLInputElement>("titleInput");
    const descriptionInput = getElement<HTMLTextAreaElement>("descriptionInput");
    const analyzeButton = getElement<HTMLButtonElement>("analyzeButton");
    const feedInputElement = getElement<HTMLTextAreaElement>("feedInput");
    const scanFeedButton = getElement<HTMLButtonElement>("scanFeedButton");
    const showHiddenToggle = getElement<HTMLInputElement>("showHiddenToggle");
    const clearFlaggedLogButton = getElement<HTMLButtonElement>("clearFlaggedLogButton");
    const localVideoInput = getElement<HTMLInputElement>("localVideoInput");

    strictnessSelect.value = settings.strictness;
    urlInput.value = form.url;
    titleInput.value = form.title;
    descriptionInput.value = form.description;
    feedInputElement.value = feedInput;
    showHiddenToggle.checked = showHiddenFeed;

    strictnessSelect.addEventListener("change", () => {
      settings = { ...DEFAULT_WEB_SETTINGS, strictness: strictnessSelect.value as StaticStrictness };
      saveWebSettings(settings);
      result = scoreCurrentForm();
      if (feedResults.length > 0) {
        feedResults = scanFeedCandidates(parseFeedCandidates(feedInput), settings.strictness, FEED_SCAN_LIMIT);
      }
      render();
    });

    urlInput.addEventListener("input", () => {
      form = { ...form, url: urlInput.value };
      renderPreview();
    });
    titleInput.addEventListener("input", () => {
      form = { ...form, title: titleInput.value };
    });
    descriptionInput.addEventListener("input", () => {
      form = { ...form, description: descriptionInput.value };
    });

    analyzeButton.addEventListener("click", () => {
      result = scoreCurrentForm();
      renderScore();
    });

    feedInputElement.addEventListener("input", () => {
      feedInput = feedInputElement.value;
      feedResults = scanFeedCandidates(parseFeedCandidates(feedInput), settings.strictness, FEED_SCAN_LIMIT);
      renderFeed();
    });
    scanFeedButton.addEventListener("click", scanFeed);
    showHiddenToggle.addEventListener("change", () => {
      showHiddenFeed = showHiddenToggle.checked;
      renderFeed();
    });
    clearFlaggedLogButton.addEventListener("click", () => {
      flaggedLog = clearFlaggedRecords();
      renderFlaggedLog();
    });

    localVideoInput.addEventListener("change", () => {
      void analyzeLocalVideo(localVideoInput.files?.[0] ?? null);
    });
  }

  function renderPreview(): void {
    const parsed = parseYouTubeUrl(form.url);
    const previewHost = getElement<HTMLDivElement>("previewHost");
    previewHost.innerHTML = "";

    if (parsed.embedUrl) {
      const iframe = document.createElement("iframe");
      iframe.className = "video-embed";
      iframe.src = parsed.embedUrl;
      iframe.title = "YouTube preview";
      iframe.loading = "lazy";
      iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
      iframe.allowFullscreen = true;
      previewHost.append(iframe);
    } else {
      const empty = document.createElement("div");
      empty.className = "empty-preview";
      empty.textContent = "Enter a supported YouTube URL.";
      previewHost.append(empty);
    }

    setText("videoIdValue", parsed.videoId ?? "Not detected");
    setText("videoKindValue", parsed.videoKind);
  }

  function renderScore(): void {
    const host = getElement<HTMLElement>("scoreHost");
    host.className = result ? `panel score-panel score-panel--${result.recommendation}` : "panel score-panel";
    host.innerHTML = "";

    if (!result) {
      const heading = document.createElement("h2");
      heading.textContent = "No score yet";
      const body = document.createElement("p");
      body.textContent = "Run the analyzer to see a recommendation.";
      host.append(heading, body);
      return;
    }

    const ring = document.createElement("div");
    ring.className = "score-ring";
    ring.setAttribute("aria-label", `Slop score ${result.score} out of 100`);
    ring.innerHTML = `<span>${result.score}</span><small>/100</small>`;

    const content = document.createElement("div");
    const eyebrow = document.createElement("p");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "Recommendation";
    const heading = document.createElement("h2");
    heading.textContent = labelForRecommendation(result.recommendation);
    const confidence = document.createElement("p");
    confidence.textContent = `Confidence: ${result.confidence}`;
    const reasons = document.createElement("ul");
    reasons.className = "reason-list";
    for (const reason of result.reasons) {
      const item = document.createElement("li");
      item.textContent = reason;
      reasons.append(item);
    }

    const feedbackRow = document.createElement("div");
    feedbackRow.className = "feedback-row";
    const accurateButton = document.createElement("button");
    accurateButton.type = "button";
    accurateButton.textContent = "Accurate";
    accurateButton.addEventListener("click", () => saveFeedback("accurate"));
    const wrongButton = document.createElement("button");
    wrongButton.type = "button";
    wrongButton.textContent = "Wrong";
    wrongButton.addEventListener("click", () => saveFeedback("wrong"));
    feedbackRow.append(accurateButton, wrongButton);

    content.append(eyebrow, heading, confidence, reasons, feedbackRow);
    host.append(ring, content);
  }

  function scanFeed(): void {
    const candidates = parseFeedCandidates(feedInput);
    feedResults = scanFeedCandidates(candidates, settings.strictness, FEED_SCAN_LIMIT);
    const createdAt = new Date().toISOString();
    const newFlaggedRecords = feedResults
      .map((feedResult) => toFlaggedRecord(feedResult, createdAt))
      .filter((record): record is WebFlaggedRecord => record !== null);

    if (newFlaggedRecords.length > 0) {
      flaggedLog = saveFlaggedRecords([...newFlaggedRecords, ...flaggedLog]);
    }

    renderFeed();
    renderFlaggedLog();
  }

  function renderFeed(): void {
    const candidates = parseFeedCandidates(feedInput);
    const summary = getElement<HTMLDivElement>("feedSummary");
    const host = getElement<HTMLDivElement>("cleanFeedHost");
    host.innerHTML = "";

    if (feedResults.length === 0) {
      summary.innerHTML = summaryMarkup([
        ["Ready", `${Math.min(candidates.length, FEED_SCAN_LIMIT)} queued`],
        ["Total", String(candidates.length)],
        ["Hidden", "0"]
      ]);
      const empty = document.createElement("div");
      empty.className = "feed-empty";
      empty.textContent = "Run Scan next 10 to generate a cleaned feed.";
      host.append(empty);
      return;
    }

    const hiddenCount = feedResults.filter((feedResult) => feedResult.hidden).length;
    const flaggedCount = feedResults.filter((feedResult) => feedResult.flagged).length;
    const visibleResults = showHiddenFeed ? feedResults : feedResults.filter((feedResult) => !feedResult.hidden);
    summary.innerHTML = summaryMarkup([
      ["Scanned", `${feedResults.length}/${candidates.length}`],
      ["Hidden", String(hiddenCount)],
      ["Flagged", String(flaggedCount)],
      ["Visible", String(visibleResults.length)]
    ]);

    if (visibleResults.length === 0) {
      const empty = document.createElement("div");
      empty.className = "feed-empty";
      empty.textContent = "Every scanned candidate was hidden by your current settings.";
      host.append(empty);
      return;
    }

    for (const feedResult of visibleResults) {
      host.append(createFeedCard(feedResult));
    }
  }

  function summaryMarkup(items: Array<[string, string]>): string {
    return items
      .map(([label, value]) => `<span class="summary-pill"><small>${label}</small><strong>${value}</strong></span>`)
      .join("");
  }

  function createFeedCard(feedResult: FeedScanResult): HTMLElement {
    const card = document.createElement("article");
    card.className = `feed-card feed-card--${feedResult.score.recommendation}${feedResult.hidden ? " feed-card--hidden" : ""}`;

    const thumbnail = document.createElement("div");
    thumbnail.className = "feed-card__thumb";
    if (feedResult.score.videoId) {
      const image = document.createElement("img");
      image.src = `https://i.ytimg.com/vi/${encodeURIComponent(feedResult.score.videoId)}/hqdefault.jpg`;
      image.alt = "";
      image.loading = "lazy";
      thumbnail.append(image);
    } else {
      thumbnail.textContent = "No preview";
    }

    const body = document.createElement("div");
    body.className = "feed-card__body";

    const status = document.createElement("span");
    status.className = "feed-status";
    status.textContent = feedResult.hidden ? "Hidden by Orislop" : labelForRecommendation(feedResult.score.recommendation);

    const title = document.createElement("h3");
    title.textContent = feedResult.candidate.title;

    const meta = document.createElement("p");
    meta.textContent = `Score ${feedResult.score.score}/100 - ${feedResult.score.confidence} confidence`;

    const reasons = document.createElement("ul");
    reasons.className = "reason-list compact-reasons";
    for (const reason of feedResult.score.reasons.slice(0, 3)) {
      const item = document.createElement("li");
      item.textContent = reason;
      reasons.append(item);
    }

    const link = document.createElement("a");
    link.href = feedResult.candidate.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "Open video";

    body.append(status, title, meta, reasons, link);
    card.append(thumbnail, body);
    return card;
  }

  function renderFlaggedLog(): void {
    const host = getElement<HTMLDivElement>("flaggedLogHost");
    host.innerHTML = "";

    if (flaggedLog.length === 0) {
      const empty = document.createElement("div");
      empty.className = "feed-empty";
      empty.textContent = "No flagged videos saved yet.";
      host.append(empty);
      return;
    }

    for (const record of flaggedLog.slice(0, 40)) {
      const entry = document.createElement("article");
      entry.className = `flagged-entry flagged-entry--${record.recommendation}`;

      const header = document.createElement("div");
      header.className = "flagged-entry__header";
      const label = document.createElement("strong");
      label.textContent = `${labelForRecommendation(record.recommendation)} - ${record.score}/100`;
      const time = document.createElement("span");
      time.textContent = new Date(record.createdAt).toLocaleString();
      header.append(label, time);

      const title = document.createElement("p");
      title.textContent = record.title;

      const reason = document.createElement("small");
      reason.textContent = record.reasons.slice(0, 2).join(", ");

      entry.append(header, title, reason);
      host.append(entry);
    }
  }

  function toFlaggedRecord(feedResult: FeedScanResult, createdAt: string): WebFlaggedRecord | null {
    if (feedResult.score.recommendation === "watch") {
      return null;
    }

    return {
      id: `${feedResult.candidate.id}:${feedResult.score.recommendation}`,
      videoId: feedResult.score.videoId,
      url: feedResult.candidate.url,
      title: feedResult.candidate.title,
      recommendation: feedResult.score.recommendation,
      score: feedResult.score.score,
      reasons: feedResult.score.reasons,
      createdAt
    };
  }

  function saveFeedback(label: "accurate" | "wrong"): void {
    if (!result) {
      return;
    }

    feedback = saveFeedbackRecord({
      videoId: result.videoId,
      recommendation: result.recommendation,
      label,
      createdAt: new Date().toISOString()
    });
    setText("feedbackCount", `Saved feedback: ${feedback.length}`);
  }

  async function analyzeLocalVideo(file: File | null): Promise<void> {
    if (!file) {
      return;
    }

    localVideoError = null;
    localVideoResult = null;
    renderLocalVideoResult("Analyzing local video in this browser...");
    try {
      localVideoResult = await analyzeLocalVideoPrototype(file);
    } catch (error) {
      localVideoError = error instanceof Error ? error.message : "Unable to analyze local video.";
    }
    renderLocalVideoResult();
  }

  function renderLocalVideoResult(statusText?: string): void {
    const host = getElement<HTMLDivElement>("localVideoResultHost");
    host.innerHTML = "";

    if (statusText) {
      const status = document.createElement("p");
      status.textContent = statusText;
      host.append(status);
      return;
    }

    if (localVideoResult) {
      host.innerHTML = `
        <dl class="parse-grid">
          <div><dt>Frames</dt><dd>${localVideoResult.sampledFrames}</dd></div>
          <div><dt>Frame change</dt><dd>${Math.round(localVideoResult.averageFrameChange * 100)}%</dd></div>
          <div><dt>Repetition</dt><dd>${Math.round(localVideoResult.visualRepetition * 100)}%</dd></div>
          <div><dt>Pacing</dt><dd>${localVideoResult.pacing}</dd></div>
        </dl>
      `;
      return;
    }

    if (localVideoError) {
      const error = document.createElement("p");
      error.className = "error-text";
      error.textContent = localVideoError;
      host.append(error);
    }
  }

  function setText(id: string, value: string): void {
    getElement<HTMLElement>(id).textContent = value;
  }

  function getElement<T extends HTMLElement>(id: string): T {
    const element = root.querySelector(`#${id}`);
    if (!(element instanceof HTMLElement)) {
      throw new Error(`Missing expected element: ${id}`);
    }
    return element as T;
  }
}

function labelForRecommendation(recommendation: StaticScoreResult["recommendation"]): string {
  switch (recommendation) {
    case "skip":
      return "Skip";
    case "questionable":
      return "Questionable";
    default:
      return "Watch";
  }
}
