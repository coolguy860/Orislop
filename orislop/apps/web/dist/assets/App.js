import { analyzeLocalVideoPrototype } from "./lib/localVideoDemo.js";
import { FEED_SCAN_LIMIT, parseFeedCandidates, scanFeedCandidates } from "./lib/feedFilter.js";
import { scoreWithAiClassifier } from "./lib/combinedScore.js";
import { scoreStaticSlop } from "./lib/staticSlopScore.js";
import { clearFlaggedRecords, DEFAULT_WEB_SETTINGS, loadFlaggedRecords, loadFeedbackRecords, loadWebSettings, saveFeedbackRecord, saveFlaggedRecords, saveWebSettings } from "./lib/storage.js";
import { parseYouTubeUrl } from "./lib/youtube.js";
import { AI_CLASSIFIER_MODEL } from "./lib/aiClassifierModel.generated.js";
const WEB_RELEASE_LABEL = "Orislop Shield 1.1";
function renderBrandMark(modifier = "") {
    return `
    <svg class="brand-symbol ${modifier}" viewBox="0 0 512 512" role="img" aria-label="Orislop" focusable="false">
      <path class="brand-piece brand-piece--orange brand-piece--row-1" d="M90 82h241l-36 70H90a24 24 0 0 1-24-24v-22a24 24 0 0 1 24-24Z" />
      <path class="brand-piece brand-piece--blue brand-piece--row-1" d="M361 82h45a24 24 0 0 1 24 24v22a24 24 0 0 1-24 24h-81l36-70Z" />
      <path class="brand-piece brand-piece--orange brand-piece--row-2" d="M90 202h185l-36 70H90a24 24 0 0 1-24-24v-22a24 24 0 0 1 24-24Z" />
      <path class="brand-piece brand-piece--blue brand-piece--row-2" d="M305 202h65a24 24 0 0 1 24 24v22a24 24 0 0 1-24 24H269l36-70Z" />
      <path class="brand-piece brand-piece--orange brand-piece--row-3" d="M90 322h129l-36 70H90a24 24 0 0 1-24-24v-22a24 24 0 0 1 24-24Z" />
      <path class="brand-piece brand-piece--blue brand-piece--row-3" d="M249 322h85a24 24 0 0 1 24 24v22a24 24 0 0 1-24 24H213l36-70Z" />
    </svg>
  `;
}
const DEFAULT_ANALYZER = {
    url: "",
    title: "",
    description: "",
    channelName: "",
    transcript: "",
    durationSeconds: ""
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
export function mountApp(root) {
    let settings = loadWebSettings();
    let form = { ...DEFAULT_ANALYZER };
    let result = null;
    let hasAnalyzed = false;
    let feedback = loadFeedbackRecords();
    let feedInput = SAMPLE_FEED_INPUT;
    let feedResults = [];
    let flaggedLog = loadFlaggedRecords();
    let showHiddenFeed = false;
    let localVideoResult = null;
    let localVideoError = null;
    let analyzerError = null;
    render();
    function scoreCurrentForm() {
        const heuristic = scoreStaticSlop({
            url: form.url,
            title: form.title,
            description: form.description,
            strictness: settings.strictness
        });
        return scoreWithAiClassifier({
            heuristic,
            url: form.url,
            title: form.title,
            description: form.description,
            channelName: form.channelName,
            transcript: form.transcript,
            durationSeconds: parseOptionalNumber(form.durationSeconds),
            isShort: heuristic.videoKind === "short",
            spatiotemporalScore: {
                available: false,
                score: null,
                reason: "Static web analyzer does not run the spatiotemporal detector."
            }
        });
    }
    function render() {
        const analyzerDisabled = Boolean(messageForInvalidUrl(form.url));
        root.innerHTML = `
      <main class="site-shell">
        <header class="site-nav" aria-label="Primary navigation">
          <a class="site-brand" href="#top" aria-label="Orislop home">
            <span class="site-brand__mark" aria-hidden="true">${renderBrandMark("brand-symbol--nav")}</span>
            <span class="site-brand__wordmark">ORISLOP</span>
          </a>
          <nav>
            <a href="#analyzer">Analyzer</a>
            <a href="#clean-feed">Clean feed</a>
            <a href="#extension-download">Extension</a>
          </nav>
          <span class="model-pill"><i aria-hidden="true"></i> Local AI ready</span>
        </header>

        <section class="hero" id="top">
          <div class="hero__copy">
            <div class="hero-brand" aria-label="Orislop. Filter the slop. Reclaim your feed.">
              <span class="hero-brand__mark" aria-hidden="true">${renderBrandMark("brand-symbol--hero")}</span>
              <span class="hero-brand__copy">
                <strong>ORISLOP</strong>
                <small><b>FILTER THE SLOP.</b> RECLAIM YOUR FEED.</small>
              </span>
            </div>
            <p class="eyebrow">Private clean-feed intelligence</p>
            <h1>Your attention deserves a firewall.</h1>
            <p class="hero__subhead">
              Orislop Shield reads context, verifies visual authenticity, and removes repetitive AI clips,
              repost farms, engagement bait, and empty content before they take over your feed.
            </p>
            <div class="hero__actions">
              <a class="primary-link" href="#analyzer">Analyze a YouTube link</a>
              <a class="secondary-link" href="#clean-feed">View clean feed</a>
              <a class="secondary-link" href="./downloads/orislop-browser-extension.zip" download>Download extension</a>
            </div>
            <div class="hero__trust-strip" aria-label="Product guarantees">
              <span>Local or cloud AI</span>
              <span>Private by default</span>
              <span>No auto-scroll</span>
              <span>${WEB_RELEASE_LABEL}</span>
            </div>
            <div class="scope-banner" role="note">
              <strong>Transparent by design.</strong>
              The website analyzer uses explainable metadata scoring. The extension adds language intelligence
              plus lightweight, spatial, and temporal verification through local companion or protected cloud mode.
            </div>
            <dl class="verdict-guide" aria-label="Orislop verdict definitions">
              <div><dt>Don't skip</dt><dd>Useful, original, ordinary, or uncertain content stays visible.</dd></div>
              <div><dt>Skip</dt><dd>Strong slop or synthetic-media evidence removes the item before view.</dd></div>
            </dl>
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
                <span>Live clean-feed scan</span>
                <strong>AI model active</strong>
              </div>
              <div class="product-feed-row product-feed-row--watch">
                <div class="product-thumb product-thumb--green"></div>
                <div>
                  <strong>Useful repair walkthrough</strong>
                  <span>Don't skip · useful and original</span>
                </div>
              </div>
              <div class="product-feed-row product-feed-row--hidden">
                <div class="product-thumb product-thumb--red"></div>
                <div>
                  <strong>AI voice viral clips compilation</strong>
                  <span>Hidden - repeated AI/repost signals</span>
                </div>
              </div>
              <div class="product-feed-row product-feed-row--watch">
                <div class="product-thumb product-thumb--green"></div>
                <div>
                  <strong>Historian explains archival photos</strong>
                  <span>Don't skip · educational context</span>
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
            <h2>Protect every feed—including LinkedIn.</h2>
            <p>
              The browser extension protects YouTube, Instagram Reels, TikTok, and LinkedIn directly. It scans
              ahead without scrolling, removes Skip-rated short-form items, annotates LinkedIn posts and profiles,
              and keeps a private activity history in your browser.
            </p>
            <dl class="definition-list">
              <div>
                <dt>Slop</dt>
                <dd>Low-value videos that look repetitive, spammy, reposted, or engagement-bait heavy.</dd>
              </div>
              <div>
                <dt>Don't skip</dt>
                <dd>Useful, original, ordinary, or uncertain content remains visible.</dd>
              </div>
              <div>
                <dt>Skip</dt>
                <dd>Strong local slop or synthetic-media evidence hides the item without auto-scrolling.</dd>
              </div>
              <div>
                <dt>LinkedIn trust</dt>
                <dd>Checks claims, image text, and likely AI-written prose. Video detection begins only after you open or play a LinkedIn video.</dd>
              </div>
            </dl>
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
              Local mode keeps model inference on your device. Cloud mode sends supported page/media URLs and
              extracted feed text to the authenticated Orislop API for inference. Developer mode is needed only
              for an unpacked build before store publication.
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
                <small class="field-help">Relaxed lowers scores, Balanced uses default thresholds, Strict raises scores for borderline signals.</small>
              </label>
            </div>

            <div class="strictness-guide" aria-label="Strictness and verdict guide">
              <div><strong>Don't skip</strong><span>Useful, ordinary, and uncertain content remains visible.</span></div>
              <div><strong>Skip</strong><span>60-100: hide/skip recommendation from stacked slop signals.</span></div>
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
              <textarea id="descriptionInput" rows="4" placeholder="Paste visible caption or description text for a stronger result"></textarea>
            </label>
            <details class="advanced-fields">
              <summary>
                <span>More signals</span>
                <small>Channel, duration, and transcript</small>
              </summary>
              <div class="advanced-fields__body">
                <label class="field">
                  <span>Optional channel name</span>
                  <input id="channelInput" placeholder="Paste the channel name if visible" />
                </label>
                <label class="field compact-field">
                  <span>Optional duration seconds</span>
                  <input id="durationInput" inputmode="numeric" placeholder="Example: 58" />
                  <small class="field-help">Used only as lightweight metadata. Leave blank if unknown.</small>
                </label>
                <label class="field advanced-fields__wide">
                  <span>Optional transcript</span>
                  <textarea id="transcriptInput" rows="4" placeholder="Paste transcript text if available. It is scored as a separate evidence source."></textarea>
                </label>
              </div>
            </details>
            <button class="primary-button" id="analyzeButton" type="button" ${analyzerDisabled ? "disabled" : ""}>Analyze video</button>
            <p id="analyzerError" class="form-error" hidden></p>

            <div class="analyzer-assurance" role="note">
              <span><strong>Runs locally</strong>No account, API key, or upload</span>
              <span><strong>Fails closed</strong>Invalid URLs never produce scores</span>
              <span><strong>Explainable</strong>Every result shows its evidence</span>
            </div>
          </div>

          <div class="panel preview-panel">
            <p class="eyebrow">Preview</p>
            <h2>Official YouTube embed</h2>
            <div id="previewHost"></div>
            <dl class="parse-grid">
              <div><dt>Video ID</dt><dd id="videoIdValue"></dd></div>
              <div><dt>Kind</dt><dd id="videoKindValue"></dd></div>
            </dl>
            <div class="model-status-card">
              <i aria-hidden="true"></i>
              <div>
                <strong>Orislop AI Classifier v1</strong>
                <span>${AI_CLASSIFIER_MODEL.trainingExamples}-example seed model, ${AI_CLASSIFIER_MODEL.features.length} weighted features, local inference</span>
              </div>
            </div>
          </div>

          <section id="scoreHost"></section>
        </section>

        <section id="clean-feed" class="feed-layout">
          <div class="panel feed-panel">
            <div class="panel__header">
              <div>
                <p class="eyebrow">Decision lab</p>
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
              inside this decision lab. Expand "Show hidden" to inspect every rule that triggered.
            </p>
            <details class="queue-editor">
              <summary>Edit the 10-video sample queue</summary>
              <textarea id="feedInput" class="feed-input" rows="9"></textarea>
            </details>
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
              Orislop's full temporal detector concept analyzes behavior over time, not just title text
              or a single thumbnail. The larger pipeline can compare frame sequences, pacing, motion,
              and temporal artifacts to detect synthetic or low-value video patterns.
            </p>
            <p>
              This static web build currently uses lightweight client-side scoring. It does not claim
              to run the full PyTorch temporal detector on Namecheap shared hosting.
            </p>
          </article>

          <article class="panel">
            <p class="eyebrow">Local frame lab</p>
            <h2>Browser-only motion and repetition analysis</h2>
            <p>
              Optional local upload mode samples frames with a browser video element and canvas. It
              estimates visual repetition, frame change intensity, and pacing. This is not the full ML model.
            </p>
            <label class="file-drop">
              <span>Choose local video</span>
              <small>Supported: MP4, WebM, MOV, M4V, or OGV. Non-video files are rejected before analysis.</small>
              <input id="localVideoInput" type="file" accept="video/mp4,video/webm,video/quicktime,video/ogg,.mp4,.webm,.mov,.m4v,.ogv" />
            </label>
            <p class="metric-guide">
              Frame change estimates how much motion changes between samples. Repetition above 70% means many
              sampled frames looked similar; rapid pacing means the visual content changes aggressively.
            </p>
            <div id="localVideoResultHost"></div>
          </article>

          <article class="panel" id="privacy">
            <p class="eyebrow">Privacy</p>
            <h2>Privacy and inference policy</h2>
            <p>
              Analysis runs locally in your browser. No account is required.
              Feedback, settings, and decision-lab logs are saved in local browser storage on your device.
              Use the clear buttons to delete local logs. The hosted static site does not receive those records.
            </p>
            <ul class="privacy-list">
              <li>No YouTube API key is embedded in this site.</li>
              <li>No uploaded local video is sent to a server by the browser demo.</li>
              <li>The extension stores flagged/skipped logs in browser extension storage.</li>
              <li>Optional cloud mode sends only the disclosed feed text and supported public media references to the authenticated Orislop API.</li>
            </ul>
          </article>
        </section>

        <footer class="footer">
          <span>Built by Aarush Shah</span>
          <a href="./privacy.html">Privacy policy</a>
          <span>Static MVP. Full detector pipeline not included in this hosted build.</span>
          <span id="feedbackCount"></span>
        </footer>
      </main>
    `;
        bindForm();
        renderPreview();
        renderAnalyzerError();
        renderScore();
        renderFeed();
        renderFlaggedLog();
        renderLocalVideoResult();
        setText("feedbackCount", `Saved feedback: ${feedback.length}`);
    }
    function bindForm() {
        const strictnessSelect = getElement("strictnessSelect");
        const urlInput = getElement("urlInput");
        const titleInput = getElement("titleInput");
        const channelInput = getElement("channelInput");
        const durationInput = getElement("durationInput");
        const descriptionInput = getElement("descriptionInput");
        const transcriptInput = getElement("transcriptInput");
        const analyzeButton = getElement("analyzeButton");
        const feedInputElement = getElement("feedInput");
        const scanFeedButton = getElement("scanFeedButton");
        const showHiddenToggle = getElement("showHiddenToggle");
        const clearFlaggedLogButton = getElement("clearFlaggedLogButton");
        const localVideoInput = getElement("localVideoInput");
        strictnessSelect.value = settings.strictness;
        urlInput.value = form.url;
        titleInput.value = form.title;
        channelInput.value = form.channelName;
        durationInput.value = form.durationSeconds;
        descriptionInput.value = form.description;
        transcriptInput.value = form.transcript;
        feedInputElement.value = feedInput;
        showHiddenToggle.checked = showHiddenFeed;
        syncAnalyzerControlState();
        strictnessSelect.addEventListener("change", () => {
            settings = { ...DEFAULT_WEB_SETTINGS, strictness: strictnessSelect.value };
            saveWebSettings(settings);
            analyzerError = null;
            result = hasAnalyzed && validateAnalyzerForm() ? scoreCurrentForm() : null;
            if (feedResults.length > 0) {
                feedResults = scanFeedCandidates(parseFeedCandidates(feedInput), settings.strictness, FEED_SCAN_LIMIT);
            }
            render();
        });
        urlInput.addEventListener("input", () => {
            form = { ...form, url: urlInput.value };
            result = null;
            hasAnalyzed = false;
            analyzerError = messageForInvalidUrl(form.url);
            renderPreview();
            renderScore();
            renderAnalyzerError();
            syncAnalyzerControlState();
        });
        titleInput.addEventListener("input", () => {
            updateFormField("title", titleInput.value);
        });
        channelInput.addEventListener("input", () => {
            updateFormField("channelName", channelInput.value);
        });
        durationInput.addEventListener("input", () => {
            updateFormField("durationSeconds", durationInput.value);
        });
        descriptionInput.addEventListener("input", () => {
            updateFormField("description", descriptionInput.value);
        });
        transcriptInput.addEventListener("input", () => {
            updateFormField("transcript", transcriptInput.value);
        });
        analyzeButton.addEventListener("click", () => {
            if (!validateAnalyzerForm()) {
                result = null;
                hasAnalyzed = false;
                renderScore();
                renderAnalyzerError();
                return;
            }
            analyzerError = null;
            result = scoreCurrentForm();
            hasAnalyzed = true;
            renderAnalyzerError();
            renderScore();
        });
        feedInputElement.addEventListener("input", () => {
            feedInput = feedInputElement.value;
            feedResults = [];
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
    function updateFormField(field, value) {
        form = { ...form, [field]: value };
        if (hasAnalyzed && !messageForInvalidUrl(form.url)) {
            result = scoreCurrentForm();
        }
        else if (!parseYouTubeUrl(form.url).videoId) {
            result = null;
            hasAnalyzed = false;
        }
        renderScore();
    }
    function validateAnalyzerForm() {
        const message = messageForInvalidUrl(form.url);
        if (message) {
            analyzerError = message;
            return false;
        }
        analyzerError = null;
        return true;
    }
    function messageForInvalidUrl(value) {
        if (!value.trim()) {
            return "Enter a YouTube URL before analyzing.";
        }
        const parsed = parseYouTubeUrl(value);
        if (!parsed.isYouTubeUrl || !parsed.videoId) {
            return "Use a valid YouTube watch, youtu.be, or Shorts URL.";
        }
        return null;
    }
    function syncAnalyzerControlState() {
        const button = root.querySelector("#analyzeButton");
        if (!(button instanceof HTMLButtonElement)) {
            return;
        }
        const disabled = Boolean(messageForInvalidUrl(form.url));
        button.disabled = disabled;
        button.title = disabled ? "Enter a valid YouTube URL first" : "Analyze this YouTube item";
    }
    function renderAnalyzerError() {
        const error = root.querySelector("#analyzerError");
        if (!(error instanceof HTMLElement)) {
            return;
        }
        error.textContent = analyzerError ?? "";
        error.hidden = !analyzerError;
    }
    function renderPreview() {
        const parsed = parseYouTubeUrl(form.url);
        const previewHost = getElement("previewHost");
        previewHost.innerHTML = "";
        if (parsed.embedUrl && isPlausibleYouTubeVideoId(parsed.videoId)) {
            const iframe = document.createElement("iframe");
            iframe.className = "video-embed";
            iframe.src = parsed.embedUrl;
            iframe.title = "YouTube preview";
            iframe.loading = "lazy";
            iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
            iframe.allowFullscreen = true;
            previewHost.append(iframe);
        }
        else {
            const empty = document.createElement("div");
            empty.className = "empty-preview";
            empty.textContent = "Enter a supported YouTube URL.";
            previewHost.append(empty);
        }
        setText("videoIdValue", parsed.videoId ?? "Not detected");
        setText("videoKindValue", parsed.videoKind);
    }
    function renderScore() {
        const host = getElement("scoreHost");
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
        const summary = document.createElement("div");
        summary.className = "score-summary";
        const ring = document.createElement("div");
        ring.className = "score-ring";
        ring.setAttribute("aria-label", `Combined slop score ${result.score} out of 100`);
        ring.innerHTML = `<span>${result.score}</span><small>/100</small>`;
        const content = document.createElement("div");
        content.className = "score-summary__content";
        const eyebrow = document.createElement("p");
        eyebrow.className = "eyebrow";
        eyebrow.textContent = "Recommendation";
        const heading = document.createElement("h2");
        heading.textContent = labelForRecommendation(result.recommendation);
        const confidence = document.createElement("p");
        confidence.className = "result-meta";
        confidence.textContent = `${capitalize(result.confidence)} confidence - ${capitalize(settings.strictness)} mode`;
        const reasons = document.createElement("ul");
        reasons.className = "reason-list";
        const primaryReasons = result.reasons.filter((reason) => !/unavailable|does not run|not run/i.test(reason)).slice(0, 4);
        for (const reason of primaryReasons) {
            const item = document.createElement("li");
            item.textContent = reason;
            reasons.append(item);
        }
        content.append(eyebrow, heading, confidence, reasons);
        summary.append(ring, content);
        const sourceGrid = document.createElement("div");
        sourceGrid.className = "source-grid";
        sourceGrid.append(createSourceMeter("Heuristic rules", result.sourceScores.heuristic, "Explainable pattern score"), createSourceMeter("Local AI model", result.sourceScores.aiClassifier, result.aiClassifierUsed ? result.aiClassifier.predictedLabel.replace(/_/g, " ") : "Unavailable"), createSourceMeter("Transcript", result.sourceScores.transcript, result.sourceScores.transcript === null ? "Not provided" : "Separate text evidence"), createSourceMeter("Video detector", result.sourceScores.spatiotemporal, result.spatiotemporalUsed ? "Used" : "Not run in static web"));
        const savedFeedback = feedback.find((record) => (record.videoId === result?.videoId
            && record.recommendation === result?.recommendation));
        const feedbackBox = document.createElement("section");
        feedbackBox.className = "feedback-box";
        feedbackBox.setAttribute("aria-label", "Result feedback");
        const feedbackCopy = document.createElement("div");
        const feedbackHeading = document.createElement("h3");
        feedbackHeading.textContent = "Does this result feel right?";
        const feedbackStatus = document.createElement("p");
        feedbackStatus.className = "feedback-status";
        feedbackStatus.setAttribute("aria-live", "polite");
        feedbackStatus.textContent = savedFeedback
            ? `${savedFeedback.label === "accurate" ? "Marked accurate" : "Marked wrong"}. Saved only in this browser.`
            : "Your answer stays on this device and helps you track calibration.";
        feedbackCopy.append(feedbackHeading, feedbackStatus);
        const feedbackRow = document.createElement("div");
        feedbackRow.className = "feedback-row";
        const accurateButton = document.createElement("button");
        accurateButton.type = "button";
        accurateButton.textContent = "Accurate";
        accurateButton.setAttribute("aria-pressed", String(savedFeedback?.label === "accurate"));
        accurateButton.classList.toggle("is-selected", savedFeedback?.label === "accurate");
        accurateButton.addEventListener("click", () => saveFeedback("accurate"));
        const wrongButton = document.createElement("button");
        wrongButton.type = "button";
        wrongButton.textContent = "Wrong";
        wrongButton.setAttribute("aria-pressed", String(savedFeedback?.label === "wrong"));
        wrongButton.classList.toggle("is-selected", savedFeedback?.label === "wrong");
        wrongButton.addEventListener("click", () => saveFeedback("wrong"));
        feedbackRow.append(accurateButton, wrongButton);
        feedbackBox.append(feedbackCopy, feedbackRow);
        const technicalDetails = document.createElement("details");
        technicalDetails.className = "score-details";
        const technicalSummary = document.createElement("summary");
        technicalSummary.textContent = "How Orislop made this score";
        const technicalBody = document.createElement("div");
        technicalBody.className = "score-details__body";
        const scoringNote = document.createElement("p");
        scoringNote.className = "score-note";
        scoringNote.textContent = `Final score combines heuristic ${result.sourceScores.heuristic}/100`
            + (result.sourceScores.aiClassifier !== null ? ` + AI classifier ${result.sourceScores.aiClassifier}/100` : " + no AI classifier")
            + (result.sourceScores.transcript !== null ? ` + transcript ${result.sourceScores.transcript}/100` : " + no transcript score")
            + ` + channel risk ${result.sourceScores.channelRisk}/100. `
            + `Heuristic math: ${result.baseScore} base signal points`
            + (result.stackedSignalBoost > 0 ? ` + ${result.stackedSignalBoost} stacked-signal bonus` : "")
            + ` x ${result.strictnessMultiplier} ${settings.strictness} multiplier. `
            + `Skip starts at ${result.thresholds.skip}; lower and uncertain scores stay visible.`;
        const breakdown = document.createElement("dl");
        breakdown.className = "score-breakdown";
        breakdown.append(scoreBreakdownItem("Base points", String(result.baseScore)), scoreBreakdownItem("Stacked bonus", String(result.stackedSignalBoost)), scoreBreakdownItem("Heuristic", `${result.sourceScores.heuristic}/100`), scoreBreakdownItem("AI classifier", result.sourceScores.aiClassifier === null ? "Unavailable" : `${result.sourceScores.aiClassifier}/100`), scoreBreakdownItem("Transcript", result.sourceScores.transcript === null ? "Not provided" : `${result.sourceScores.transcript}/100`), scoreBreakdownItem("Spatiotemporal", result.sourceScores.spatiotemporal === null ? "Not used" : `${result.sourceScores.spatiotemporal}/100`));
        const sourceDetails = document.createElement("ul");
        sourceDetails.className = "signal-breakdown";
        for (const source of result.explanationBreakdown) {
            const item = document.createElement("li");
            item.textContent = `${source.source}: ${source.used ? `${source.score}/100 at ${Math.round(source.weight * 100)}% weight` : source.reason}`;
            sourceDetails.append(item);
        }
        const aiDetails = document.createElement("ul");
        aiDetails.className = "signal-breakdown";
        const aiSummary = document.createElement("li");
        aiSummary.textContent = result.aiClassifierUsed
            ? `AI classifier predicted ${result.aiClassifier.predictedLabel} with ${Math.round(result.aiClassifier.slopProbability * 100)}% slop probability.`
            : `AI classifier unavailable: ${result.aiClassifier.reason}`;
        aiDetails.append(aiSummary);
        for (const feature of result.aiClassifier.topFeatures) {
            const item = document.createElement("li");
            item.textContent = `AI feature ${feature.term}: ${feature.contribution >= 0 ? "+" : ""}${feature.contribution}`;
            aiDetails.append(item);
        }
        const signalDetails = document.createElement("ul");
        signalDetails.className = "signal-breakdown";
        for (const signal of result.signalBreakdown) {
            const item = document.createElement("li");
            item.textContent = `${signal.label}: +${signal.points}`;
            signalDetails.append(item);
        }
        if (result.signalBreakdown.length === 0) {
            const item = document.createElement("li");
            item.textContent = "No positive slop-signal points were applied.";
            signalDetails.append(item);
        }
        technicalBody.append(scoringNote, breakdown, sourceDetails, aiDetails, signalDetails);
        technicalDetails.append(technicalSummary, technicalBody);
        host.append(summary, sourceGrid, feedbackBox, technicalDetails);
    }
    function scoreBreakdownItem(label, value) {
        const wrapper = document.createElement("div");
        const term = document.createElement("dt");
        const definition = document.createElement("dd");
        term.textContent = label;
        definition.textContent = value;
        wrapper.append(term, definition);
        return wrapper;
    }
    function createSourceMeter(label, score, detail) {
        const card = document.createElement("article");
        card.className = `source-meter${score === null ? " source-meter--unavailable" : ""}`;
        const header = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = label;
        const value = document.createElement("span");
        value.textContent = score === null ? "--" : String(score);
        header.append(title, value);
        const meter = document.createElement("progress");
        meter.max = 100;
        meter.value = score ?? 0;
        meter.setAttribute("aria-label", `${label}: ${score === null ? "unavailable" : `${score} out of 100`}`);
        const description = document.createElement("small");
        description.textContent = detail;
        card.append(header, meter, description);
        return card;
    }
    function scanFeed() {
        const candidates = parseFeedCandidates(feedInput);
        feedResults = scanFeedCandidates(candidates, settings.strictness, FEED_SCAN_LIMIT);
        const createdAt = new Date().toISOString();
        const newFlaggedRecords = feedResults
            .map((feedResult) => toFlaggedRecord(feedResult, createdAt))
            .filter((record) => record !== null);
        if (newFlaggedRecords.length > 0) {
            flaggedLog = saveFlaggedRecords([...newFlaggedRecords, ...flaggedLog]);
        }
        const editor = root.querySelector(".queue-editor");
        if (editor instanceof HTMLDetailsElement) {
            editor.open = false;
        }
        renderFeed();
        renderFlaggedLog();
    }
    function renderFeed() {
        const candidates = parseFeedCandidates(feedInput);
        const summary = getElement("feedSummary");
        const host = getElement("cleanFeedHost");
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
    function summaryMarkup(items) {
        return items
            .map(([label, value]) => `<span class="summary-pill"><small>${label}</small><strong>${value}</strong></span>`)
            .join("");
    }
    function createFeedCard(feedResult) {
        const card = document.createElement("article");
        card.className = `feed-card feed-card--${feedResult.score.recommendation}${feedResult.hidden ? " feed-card--hidden" : ""}`;
        const thumbnail = document.createElement("div");
        thumbnail.className = "feed-card__thumb";
        if (isPlausibleYouTubeVideoId(feedResult.score.videoId)) {
            const image = document.createElement("img");
            image.src = `https://i.ytimg.com/vi/${encodeURIComponent(feedResult.score.videoId)}/hqdefault.jpg`;
            image.alt = "";
            image.loading = "lazy";
            image.addEventListener("error", () => {
                image.remove();
                thumbnail.classList.add("feed-card__thumb--placeholder");
            });
            thumbnail.append(image);
        }
        else {
            thumbnail.classList.add("feed-card__thumb--placeholder");
            thumbnail.setAttribute("aria-label", "Metadata-only preview");
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
    function renderFlaggedLog() {
        const host = getElement("flaggedLogHost");
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
    function toFlaggedRecord(feedResult, createdAt) {
        if (feedResult.score.recommendation !== "skip") {
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
    function saveFeedback(label) {
        if (!result) {
            return;
        }
        feedback = saveFeedbackRecord({
            videoId: result.videoId,
            recommendation: result.recommendation,
            label,
            createdAt: new Date().toISOString()
        });
        renderScore();
        setText("feedbackCount", `Saved feedback: ${feedback.length}`);
    }
    async function analyzeLocalVideo(file) {
        if (!file) {
            return;
        }
        localVideoError = null;
        localVideoResult = null;
        if (!isSupportedVideoFile(file)) {
            localVideoError = "Choose a supported local video file. Images, documents, and audio-only files cannot be sampled.";
            renderLocalVideoResult();
            return;
        }
        renderLocalVideoResult("Analyzing local video in this browser...");
        try {
            localVideoResult = await analyzeLocalVideoPrototype(file);
        }
        catch (error) {
            localVideoError = error instanceof Error ? error.message : "Unable to analyze local video.";
        }
        renderLocalVideoResult();
    }
    function isSupportedVideoFile(file) {
        if (file.type.startsWith("video/")) {
            return true;
        }
        return /\.(mp4|mov|m4v|webm|ogv)$/i.test(file.name);
    }
    function renderLocalVideoResult(statusText) {
        const host = getElement("localVideoResultHost");
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
    function setText(id, value) {
        getElement(id).textContent = value;
    }
    function getElement(id) {
        const element = root.querySelector(`#${id}`);
        if (!(element instanceof HTMLElement)) {
            throw new Error(`Missing expected element: ${id}`);
        }
        return element;
    }
}
function labelForRecommendation(recommendation) {
    switch (recommendation) {
        case "skip":
            return "Skip";
        case "questionable":
            return "Don't skip";
        default:
            return "Don't skip";
    }
}
function capitalize(value) {
    return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}
function parseOptionalNumber(value) {
    if (!value.trim()) {
        return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function isPlausibleYouTubeVideoId(value) {
    return typeof value === "string" && /^[a-zA-Z0-9_-]{11}$/.test(value);
}
