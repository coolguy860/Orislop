import { analyzeLocalVideoPrototype, type LocalVideoPrototypeResult } from "./lib/localVideoDemo";
import {
  FEED_SCAN_LIMIT,
  parseFeedCandidates,
  scanFeedCandidates,
  type FeedScanResult
} from "./lib/feedFilter";
import { scoreWithAiClassifier, type CombinedScoreResult } from "./lib/combinedScore";
import { scoreStaticSlop, type StaticStrictness } from "./lib/staticSlopScore";
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
import {
  analyzeWithCloudAi,
  getCloudAiStatus,
  type CloudAiResult,
  type CloudAiStatus
} from "./lib/cloudAi";

type AnalyzerState = {
  url: string;
  title: string;
  description: string;
  channelName: string;
  transcript: string;
  durationSeconds: string;
};

const WEB_RELEASE_LABEL = "Orislop Shield 1.3";

function renderBrandMark(modifier = ""): string {
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

const DEFAULT_ANALYZER: AnalyzerState = {
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

export function mountApp(root: HTMLElement): void {
  let settings = loadWebSettings();
  let form: AnalyzerState = { ...DEFAULT_ANALYZER };
  let result: CombinedScoreResult | null = null;
  let hasAnalyzed = false;
  let feedback = loadFeedbackRecords();
  let feedInput = SAMPLE_FEED_INPUT;
  let feedResults: FeedScanResult[] = [];
  let flaggedLog = loadFlaggedRecords();
  let showHiddenFeed = false;
  let localVideoResult: LocalVideoPrototypeResult | null = null;
  let localVideoError: string | null = null;
  let analyzerError: string | null = null;
  let cloudStatus: CloudAiStatus = "checking";
  let cloudResult: CloudAiResult | null = null;
  let cloudError: string | null = null;
  let cloudAnalyzing = false;
  const revealedBlocks = new Set<string>();
  let revealObserver: IntersectionObserver | null = null;
  let experienceWired = false;
  let initialHashHandled = false;
  let viewportFrame = 0;

  render();
  void refreshCloudStatus();

  function scoreCurrentForm(): CombinedScoreResult {
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

  function render(): void {
    const analyzerDisabled = Boolean(messageForInvalidUrl(form.url));
    root.innerHTML = `
      <div class="page-progress" aria-hidden="true"><span></span></div>
      <div class="site-ambient" aria-hidden="true">
        <i class="site-ambient__orb site-ambient__orb--orange"></i>
        <i class="site-ambient__orb site-ambient__orb--blue"></i>
        <i class="site-ambient__grid"></i>
      </div>
      <main class="site-shell">
        <header class="site-nav" aria-label="Primary navigation">
          <a class="site-brand" href="#top" aria-label="Orislop home">
            <span class="site-brand__mark" aria-hidden="true">${renderBrandMark("brand-symbol--nav")}</span>
            <span class="site-brand__identity"><strong>ORISLOP</strong><small>Attention control</small></span>
          </a>
          <nav>
            <a href="#how-it-works">How it works</a>
            <a href="#intelligence">Technology</a>
            <a href="#analyzer">Analyzer</a>
            <a href="#privacy">Privacy</a>
          </nav>
          <div class="site-nav__status">
            <span class="release-chip">Private beta</span>
            <span class="model-pill model-pill--${cloudStatus}" id="cloudStatusPill"><i aria-hidden="true"></i> ${cloudStatusLabel(cloudStatus)}</span>
          </div>
        </header>

        <section class="hero" id="top">
          <div class="hero__copy is-revealed" data-reveal="hero-copy">
            <div class="hero-brand" aria-label="Orislop. Filter the slop. Reclaim your feed.">
              <span class="hero-brand__mark" aria-hidden="true">${renderBrandMark("brand-symbol--hero")}</span>
              <span class="hero-brand__copy">
                <strong>ORISLOP</strong>
                <small><b>A CALMER FEED.</b> ON YOUR TERMS.</small>
              </span>
            </div>
            <div class="hero__signal-line"><span></span>Built for people who are tired of the feed</div>
            <h1>Spend less time on videos <em>you never wanted.</em></h1>
            <p class="hero__subhead">
              Orislop checks what is coming next. Useful videos stay. Repetitive AI clips and bait get moved
              out of the way. You can see why, change the rules, and undo any decision.
            </p>
            <div class="hero__actions">
              <a class="primary-link primary-link--hero" href="#extension-download"><span>Get Orislop for Chrome</span><b aria-hidden="true">&rarr;</b></a>
              <a class="secondary-link" href="#analyzer">Try it on a video</a>
            </div>
            <div class="hero__trust-strip" aria-label="Product guarantees">
              <span><i aria-hidden="true"></i>Runs locally first</span>
              <span><i aria-hidden="true"></i>Does not scroll for you</span>
              <span><i aria-hidden="true"></i>Shows its reasons</span>
            </div>
            <div class="scope-banner" role="note">
              <span class="scope-banner__icon" aria-hidden="true">01</span>
              <span><strong>The quick check happens on your device.</strong> Heavy mode adds visual, motion, and
              audio checks when the video itself is available.</span>
            </div>
            <dl class="verdict-guide" aria-label="Orislop verdict definitions">
              <div><dt>Don't skip</dt><dd>Useful, original, ordinary, or uncertain content stays visible.</dd></div>
              <div><dt>Skip</dt><dd>Strong slop or synthetic-media evidence removes the item before view.</dd></div>
            </dl>
          </div>
          <div class="hero__product is-revealed" aria-label="Orislop clean feed product preview" data-reveal="hero-product">
            <span class="hero__product-glow" aria-hidden="true"></span>
            <div class="product-chrome">
              <div class="product-chrome__controls" aria-hidden="true"><span></span><span></span><span></span></div>
              <div class="product-chrome__address"><i aria-hidden="true"></i><strong>orislop.com / shield</strong></div>
              <span class="product-chrome__privacy">Private</span>
            </div>
            <div class="product-visual">
              <span class="product-scan-beam" aria-hidden="true"></span>
              <div class="product-visual__header">
                <div><small>ORISLOP SHIELD</small><span>Checking the next few videos</span></div>
                <strong><i aria-hidden="true"></i>On</strong>
              </div>
              <div class="product-summary-strip">
                <div><strong>18</strong><span>checked</span></div>
                <div><strong>03</strong><span>moved aside</span></div>
                <div><strong>15</strong><span>left alone</span></div>
              </div>
              <div class="product-feed-row product-feed-row--watch" style="--row-index: 0">
                <div class="product-thumb product-thumb--green"><span>24</span></div>
                <div><strong>Useful repair walkthrough</strong><span>Clear steps and original footage</span></div>
                <b class="product-verdict product-verdict--keep">Keep</b>
              </div>
              <div class="product-feed-row product-feed-row--hidden" style="--row-index: 1">
                <div class="product-thumb product-thumb--red"><span>96</span></div>
                <div><strong>AI voice clips compilation</strong><span>Repeated narration and repost signals</span></div>
                <b class="product-verdict product-verdict--skip">Skip</b>
              </div>
              <div class="product-feed-row product-feed-row--watch" style="--row-index: 2">
                <div class="product-thumb product-thumb--green"><span>11</span></div>
                <div><strong>Historian explains archival photos</strong><span>Useful educational context</span></div>
                <b class="product-verdict product-verdict--keep">Keep</b>
              </div>
              <div class="product-log-strip">
                <span><i aria-hidden="true"></i>Context, visuals, motion, and audio</span>
                <strong>Saved locally</strong>
              </div>
            </div>
            <span class="product-float-card product-float-card--privacy"><i aria-hidden="true"></i><b>Local first</b><small>Nothing sent by default</small></span>
            <span class="product-float-card product-float-card--signal"><b>4 checks agree</b><small>Reason shown before hiding</small></span>
          </div>
        </section>

        <section class="trust-rail" aria-label="What Orislop does" data-reveal="trust-rail">
          <div><strong>04</strong><span>Feed platforms</span></div>
          <div><strong>Local</strong><span>Quick check first</span></div>
          <div><strong>Heavy</strong><span>Video analysis when needed</span></div>
          <div><strong>Undo</strong><span>You stay in control</span></div>
        </section>

        <section class="download-section panel" id="extension-download" data-reveal="download">
          <div class="download-copy">
            <p class="eyebrow">The browser extension</p>
            <h2>Protection that stays out of your way.</h2>
            <p>
              Install it once, choose what you do not want to see, and keep browsing normally. Orislop works on
              YouTube, Instagram Reels, TikTok, and LinkedIn. It never scrolls the page for you.
            </p>
            <dl class="definition-list">
              <div>
                <dt>Slop</dt>
                <dd>Low-value videos that look repetitive, spammy, reposted, or bait-heavy.</dd>
              </div>
              <div>
                <dt>Don't skip</dt>
                <dd>Useful, original, ordinary, or uncertain content remains visible.</dd>
              </div>
              <div>
                <dt>Skip</dt>
                <dd>A strong match moves the item aside. You can reveal it and correct the decision.</dd>
              </div>
              <div>
                <dt>LinkedIn trust</dt>
                <dd>Checks claims, image text, and likely AI-written prose. Video detection begins only after you open or play a LinkedIn video.</dd>
              </div>
            </dl>
          </div>
          <div class="download-card">
            <div class="download-card__top">
              <span class="download-card__mark" aria-hidden="true">${renderBrandMark("brand-symbol--download")}</span>
              <span><small>Browser extension</small><strong>Orislop Shield</strong></span>
              <b>v1.3</b>
            </div>
            <a class="download-button" href="./downloads/orislop-browser-extension.zip" download>
              Download the private beta
            </a>
            <p class="download-card__availability">The Chrome Web Store listing is under review. The same tested build is available here for private testing.</p>
            <ol class="install-list">
              <li>Unzip the download.</li>
              <li>Open <code>chrome://extensions</code> or <code>edge://extensions</code>.</li>
              <li>Enable Developer mode.</li>
              <li>Choose Load unpacked and select the unzipped folder.</li>
            </ol>
            <p class="prototype-note">
              Developer mode is only needed during the private beta. Local mode keeps the first check on your
              device. Heavy mode can use the Orislop service for a closer look.
            </p>
            <div class="download-card__footer"><span>Manifest V3</span><span>Local-first</span><span>Clear controls</span></div>
          </div>
        </section>

        <section class="how-grid" id="how-it-works" aria-labelledby="howHeading" data-reveal="how">
          <div class="section-heading">
            <p class="eyebrow">How it works</p>
            <h2 id="howHeading">It watches the feed, not you.</h2>
            <p>Orislop checks a small group of upcoming posts. It acts only when the reason is strong. Everything else stays put.</p>
          </div>
          <div class="how-grid__cards">
            <article class="how-card" data-reveal="how-1"><span>01</span><h3>Looks a little ahead</h3><p>Checks the next few items without scrolling, clicking, or changing where you are.</p></article>
            <article class="how-card" data-reveal="how-2"><span>02</span><h3>Takes a closer look</h3><p>Uses the heavier video checks only when the quick result is not enough.</p></article>
            <article class="how-card" data-reveal="how-3"><span>03</span><h3>Leaves the final say to you</h3><p>Shows the reason, keeps uncertain posts visible, and gives you a simple undo.</p></article>
          </div>
        </section>

        <section class="intelligence-stage" id="intelligence" aria-labelledby="intelligenceHeading" data-reveal="intelligence">
          <div class="intelligence-stage__copy">
            <p class="eyebrow">What happens in Heavy mode</p>
            <h2 id="intelligenceHeading">One answer. Several independent checks.</h2>
            <p>
              A title can lie. One frame can be misleading. Orislop compares the words, the pictures, the motion,
              the voice, and available sources before it makes a strong call.
            </p>
            <p class="intelligence-stage__note">You do not need to understand the machinery. You still get the reason.</p>
          </div>
          <div class="signal-map" aria-label="Orislop checks context, frames, motion, audio, and sources">
            <span class="signal-map__line signal-map__line--one" aria-hidden="true"></span>
            <span class="signal-map__line signal-map__line--two" aria-hidden="true"></span>
            <span class="signal-map__line signal-map__line--three" aria-hidden="true"></span>
            <span class="signal-map__line signal-map__line--four" aria-hidden="true"></span>
            <span class="signal-map__line signal-map__line--five" aria-hidden="true"></span>
            <div class="signal-map__core">
              <span>${renderBrandMark("brand-symbol--core")}</span>
              <strong>Clear decision</strong>
              <small>with a reason</small>
            </div>
            <div class="signal-node signal-node--context"><i>01</i><strong>Words and context</strong><span>What the post is saying</span></div>
            <div class="signal-node signal-node--frames"><i>02</i><strong>Individual frames</strong><span>What the video looks like</span></div>
            <div class="signal-node signal-node--motion"><i>03</i><strong>Motion over time</strong><span>How the video behaves</span></div>
            <div class="signal-node signal-node--audio"><i>04</i><strong>Voice and lip sync</strong><span>Whether sound and face agree</span></div>
            <div class="signal-node signal-node--sources"><i>05</i><strong>Source checks</strong><span>What reliable pages report</span></div>
          </div>
        </section>

        <section id="analyzer" class="section-grid" data-reveal="analyzer">
          <div class="panel analyzer-panel">
            <div class="panel__header">
              <div>
                <p class="eyebrow">Try Orislop</p>
                <h2>Check a YouTube video</h2>
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
            <button class="primary-button" id="analyzeButton" type="button" ${analyzerDisabled || cloudAnalyzing ? "disabled" : ""}>${cloudAnalyzing ? "Checking the video..." : "Check this video"}</button>
            <p id="analyzerError" class="form-error" hidden></p>

            <div class="analyzer-assurance" role="note">
              <span><strong>Quick result</strong>The first check runs on your device</span>
              <span><strong>Closer look</strong>The live service joins when available</span>
              <span><strong>Clear reasons</strong>You can inspect what affected the result</span>
            </div>
          </div>

          <div class="panel preview-panel">
            <p class="eyebrow">Preview</p>
            <h2>Video preview</h2>
            <div id="previewHost"></div>
            <dl class="parse-grid">
              <div><dt>Video ID</dt><dd id="videoIdValue"></dd></div>
              <div><dt>Kind</dt><dd id="videoKindValue"></dd></div>
            </dl>
            <div class="model-status-card">
              <i aria-hidden="true"></i>
              <div>
                <strong>Instant protection is ready</strong>
                <span>Runs privately in this tab. A live second check joins when available.</span>
              </div>
            </div>
          </div>

          <section id="scoreHost"></section>
        </section>

        <section id="clean-feed" class="feed-layout" data-reveal="clean-feed">
          <div class="panel feed-panel">
            <div class="panel__header">
              <div>
                <p class="eyebrow">Try a sample feed</p>
                <h2>See what Orislop would keep</h2>
              </div>
              <label class="toggle-field">
                <input id="showHiddenToggle" type="checkbox" />
                <span>Show hidden</span>
              </label>
            </div>
            <p>
              Use the sample list or paste your own rows as URL | title | caption. Orislop checks the first
              ${FEED_SCAN_LIMIT}. Turn on Show hidden to inspect what moved and why.
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

        <section class="faq-section" aria-labelledby="faqHeading" data-reveal="faq">
          <div class="section-heading">
            <p class="eyebrow">Good to know</p>
            <h2 id="faqHeading">Built to help. Not take over.</h2>
          </div>
          <div class="faq-list">
            <details><summary>What happens when Orislop is unsure?</summary><p>The item stays visible. Orislop is intentionally conservative, and every hidden item has a reveal or undo path.</p></details>
            <details><summary>Does it upload my whole browsing history?</summary><p>No. Local activity stays in your browser. Optional cloud checks send only the disclosed item context and supported public media reference after you enable them.</p></details>
            <details><summary>Can I choose what gets filtered?</summary><p>Yes. Use a normal sentence or pick exact categories, then pause protection or clear activity whenever you want.</p></details>
          </div>
        </section>

        <section class="info-grid" data-reveal="details">
          <article class="panel" data-reveal="details-heavy">
            <p class="eyebrow">When a quick check is not enough</p>
            <h2>It can look at the actual video</h2>
            <p>
              Heavy mode looks beyond the title and thumbnail. It compares frame sequences, pacing, motion,
              audio alignment, and visual artifacts when a closer check is useful.
            </p>
            <p>
              This page gives you a quick local result. Full video analysis happens through the extension, where
              Orislop can safely inspect the available media.
            </p>
          </article>

          <article class="panel" data-reveal="details-local">
            <p class="eyebrow">Try a file from your computer</p>
            <h2>A small motion check that stays here</h2>
            <p>
              Choose a video and this page will sample a few frames in your browser. It estimates repetition,
              frame changes, and pacing. The file never leaves this tab.
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

          <article class="panel" id="privacy" data-reveal="details-privacy">
            <p class="eyebrow">Privacy</p>
            <h2>Clear boundaries by default</h2>
            <p>
              Instant analysis runs locally in your browser. No account is required. When the live service is
              available, only the YouTube link and text you entered are sent for that second opinion. A local file is never sent.
              Feedback, settings, and decision-lab logs stay in local browser storage on your device.
            </p>
            <ul class="privacy-list">
              <li>No YouTube API key is embedded in this site.</li>
              <li>No uploaded local video is sent to a server by the browser demo.</li>
              <li>The extension stores flagged/skipped logs in browser extension storage.</li>
              <li>Optional cloud mode sends only the disclosed feed text and supported public media references to the authenticated Orislop API.</li>
            </ul>
          </article>
        </section>

        <footer class="footer" data-reveal="footer">
          <div class="footer__brand">
            <span aria-hidden="true">${renderBrandMark("brand-symbol--footer")}</span>
            <div><strong>ORISLOP</strong><p>A calmer feed, built by Aarush Shah.</p></div>
          </div>
          <div class="footer__links">
            <span>Product</span>
            <a href="#how-it-works">How it works</a>
            <a href="#analyzer">Try the analyzer</a>
            <a href="#extension-download">Get the extension</a>
          </div>
          <div class="footer__links">
            <span>Company</span>
            <a href="./privacy.html">Privacy policy</a>
            <a href="https://github.com/coolguy860/orislop" target="_blank" rel="noreferrer">Open source</a>
            <a href="https://github.com/coolguy860/orislop/issues" target="_blank" rel="noreferrer">Support</a>
          </div>
          <div class="footer__meta">
            <span><i aria-hidden="true"></i>${WEB_RELEASE_LABEL}</span>
            <span id="feedbackCount"></span>
            <a href="#top">Back to top</a>
          </div>
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
    enhanceExperience();
    restoreInitialAnchor();
  }

  function bindForm(): void {
    const strictnessSelect = getElement<HTMLSelectElement>("strictnessSelect");
    const urlInput = getElement<HTMLInputElement>("urlInput");
    const titleInput = getElement<HTMLInputElement>("titleInput");
    const channelInput = getElement<HTMLInputElement>("channelInput");
    const durationInput = getElement<HTMLInputElement>("durationInput");
    const descriptionInput = getElement<HTMLTextAreaElement>("descriptionInput");
    const transcriptInput = getElement<HTMLTextAreaElement>("transcriptInput");
    const analyzeButton = getElement<HTMLButtonElement>("analyzeButton");
    const feedInputElement = getElement<HTMLTextAreaElement>("feedInput");
    const scanFeedButton = getElement<HTMLButtonElement>("scanFeedButton");
    const showHiddenToggle = getElement<HTMLInputElement>("showHiddenToggle");
    const clearFlaggedLogButton = getElement<HTMLButtonElement>("clearFlaggedLogButton");
    const localVideoInput = getElement<HTMLInputElement>("localVideoInput");

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
      settings = { ...DEFAULT_WEB_SETTINGS, strictness: strictnessSelect.value as StaticStrictness };
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
      cloudResult = null;
      cloudError = null;
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
      void analyzeCurrentForm();
    });

    async function analyzeCurrentForm(): Promise<void> {
      if (!validateAnalyzerForm()) {
        result = null;
        cloudResult = null;
        cloudError = null;
        hasAnalyzed = false;
        renderScore();
        renderAnalyzerError();
        return;
      }
      analyzerError = null;
      result = scoreCurrentForm();
      hasAnalyzed = true;
      cloudResult = null;
      cloudError = null;
      cloudAnalyzing = true;
      renderAnalyzerError();
      renderScore();
      syncAnalyzerControlState();
      try {
        cloudResult = await analyzeWithCloudAi(form);
        cloudStatus = "online";
      } catch (error) {
        cloudError = error instanceof Error
          ? error.message
          : "The live checker could not be reached. Your instant on-device result is still ready.";
        cloudStatus = "offline";
      } finally {
        cloudAnalyzing = false;
        renderCloudStatusPill();
        renderScore();
        syncAnalyzerControlState();
      }
    }

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

  function updateFormField(field: keyof AnalyzerState, value: string): void {
    form = { ...form, [field]: value };
    cloudResult = null;
    cloudError = null;
    if (hasAnalyzed && !messageForInvalidUrl(form.url)) {
      result = scoreCurrentForm();
    } else if (!parseYouTubeUrl(form.url).videoId) {
      result = null;
      hasAnalyzed = false;
    }
    renderScore();
  }

  function validateAnalyzerForm(): boolean {
    const message = messageForInvalidUrl(form.url);
    if (message) {
      analyzerError = message;
      return false;
    }
    analyzerError = null;
    return true;
  }

  function messageForInvalidUrl(value: string): string | null {
    if (!value.trim()) {
      return "Enter a YouTube URL before analyzing.";
    }
    const parsed = parseYouTubeUrl(value);
    if (!parsed.isYouTubeUrl || !parsed.videoId) {
      return "Use a valid YouTube watch, youtu.be, or Shorts URL.";
    }
    return null;
  }

  function syncAnalyzerControlState(): void {
    const button = root.querySelector("#analyzeButton");
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    const disabled = Boolean(messageForInvalidUrl(form.url)) || cloudAnalyzing;
    button.disabled = disabled;
    button.textContent = cloudAnalyzing ? "Checking the video..." : "Check this video";
    button.title = cloudAnalyzing
      ? "Orislop is checking the context"
      : disabled ? "Enter a valid YouTube URL first" : "Analyze this YouTube item";
  }

  function renderAnalyzerError(): void {
    const error = root.querySelector("#analyzerError");
    if (!(error instanceof HTMLElement)) {
      return;
    }
    error.textContent = analyzerError ?? "";
    error.hidden = !analyzerError;
  }

  function renderPreview(): void {
    const parsed = parseYouTubeUrl(form.url);
    const previewHost = getElement<HTMLDivElement>("previewHost");
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
    sourceGrid.append(
      createSourceMeter("Heuristic rules", result.sourceScores.heuristic, "Explainable pattern score"),
      createSourceMeter("Local AI model", result.sourceScores.aiClassifier, result.aiClassifierUsed ? result.aiClassifier.predictedLabel.replace(/_/g, " ") : "Unavailable"),
      createSourceMeter("Transcript", result.sourceScores.transcript, result.sourceScores.transcript === null ? "Not provided" : "Separate text evidence"),
      createSourceMeter("Video detector", result.sourceScores.spatiotemporal, result.spatiotemporalUsed ? "Used" : "Not run in static web")
    );

    const cloudCard = createCloudAiCard();

    const savedFeedback = feedback.find((record) => (
      record.videoId === result?.videoId
      && record.recommendation === result?.recommendation
    ));
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
    breakdown.append(
      scoreBreakdownItem("Base points", String(result.baseScore)),
      scoreBreakdownItem("Stacked bonus", String(result.stackedSignalBoost)),
      scoreBreakdownItem("Heuristic", `${result.sourceScores.heuristic}/100`),
      scoreBreakdownItem("AI classifier", result.sourceScores.aiClassifier === null ? "Unavailable" : `${result.sourceScores.aiClassifier}/100`),
      scoreBreakdownItem("Transcript", result.sourceScores.transcript === null ? "Not provided" : `${result.sourceScores.transcript}/100`),
      scoreBreakdownItem("Spatiotemporal", result.sourceScores.spatiotemporal === null ? "Not used" : `${result.sourceScores.spatiotemporal}/100`)
    );

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

    host.append(summary, cloudCard, sourceGrid, feedbackBox, technicalDetails);
  }

  function createCloudAiCard(): HTMLElement {
    const card = document.createElement("section");
    card.className = "cloud-insight";
    card.setAttribute("aria-live", "polite");

    const icon = document.createElement("span");
    icon.className = "cloud-insight__icon";
    icon.textContent = cloudAnalyzing ? "···" : cloudResult?.available ? "AI" : "↗";

    const copy = document.createElement("div");
    const heading = document.createElement("h3");
    const detail = document.createElement("p");
    if (cloudAnalyzing) {
      card.classList.add("cloud-insight--loading");
      heading.textContent = "Taking a closer look";
      detail.textContent = "The quick result is already above. This usually takes a few seconds.";
    } else if (cloudResult?.available && cloudResult.verdict) {
      card.classList.add(cloudResult.verdict === "skip" ? "cloud-insight--skip" : "cloud-insight--safe");
      const agrees = cloudResult.verdict === "skip" ? result?.recommendation === "skip" : result?.recommendation !== "skip";
      heading.textContent = `${agrees ? "The closer check agrees" : "The closer check sees this differently"}: ${cloudResult.verdict === "skip" ? "Skip" : "Don't skip"}`;
      const confidence = cloudResult.confidence === null ? "" : ` · ${Math.round(cloudResult.confidence * 100)}% confidence`;
      const category = cloudResult.category ? ` · ${humanizeCategory(cloudResult.category)}` : "";
      detail.textContent = `${cloudResult.reason}${confidence}${category}`;
    } else {
      card.classList.add("cloud-insight--offline");
      heading.textContent = "Quick check complete";
      detail.textContent = cloudError || "The live second check is optional. The result above was completed privately on this device.";
    }
    copy.append(heading, detail);
    card.append(icon, copy);
    return card;
  }

  async function refreshCloudStatus(): Promise<void> {
    cloudStatus = await getCloudAiStatus();
    renderCloudStatusPill();
  }

  function renderCloudStatusPill(): void {
    const pill = root.querySelector("#cloudStatusPill");
    if (!(pill instanceof HTMLElement)) {
      return;
    }
    pill.className = `model-pill model-pill--${cloudStatus}`;
    pill.innerHTML = `<i aria-hidden="true"></i> ${cloudStatusLabel(cloudStatus)}`;
  }

  function scoreBreakdownItem(label: string, value: string): HTMLElement {
    const wrapper = document.createElement("div");
    const term = document.createElement("dt");
    const definition = document.createElement("dd");
    term.textContent = label;
    definition.textContent = value;
    wrapper.append(term, definition);
    return wrapper;
  }

  function createSourceMeter(label: string, score: number | null, detail: string): HTMLElement {
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

    const editor = root.querySelector(".queue-editor");
    if (editor instanceof HTMLDetailsElement) {
      editor.open = false;
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
    } else {
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
    renderScore();
    setText("feedbackCount", `Saved feedback: ${feedback.length}`);
  }

  async function analyzeLocalVideo(file: File | null): Promise<void> {
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
    } catch (error) {
      localVideoError = error instanceof Error ? error.message : "Unable to analyze local video.";
    }
    renderLocalVideoResult();
  }

  function isSupportedVideoFile(file: File): boolean {
    if (file.type.startsWith("video/")) {
      return true;
    }
    return /\.(mp4|mov|m4v|webm|ogv)$/i.test(file.name);
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

  function enhanceExperience(): void {
    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const revealTargets = [...root.querySelectorAll<HTMLElement>("[data-reveal]")];
    revealObserver?.disconnect();

    if (prefersReducedMotion || typeof IntersectionObserver === "undefined") {
      for (const target of revealTargets) target.classList.add("is-revealed");
    } else {
      revealObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const target = entry.target as HTMLElement;
          const key = target.dataset.reveal ?? "section";
          revealedBlocks.add(key);
          target.classList.add("is-revealed");
          revealObserver?.unobserve(target);
        }
      }, { threshold: 0.14, rootMargin: "0px 0px -8%" });

      for (const target of revealTargets) {
        const key = target.dataset.reveal ?? "section";
        if (revealedBlocks.has(key)) target.classList.add("is-revealed");
        else revealObserver.observe(target);
      }
    }

    if (!experienceWired) {
      experienceWired = true;
      window.addEventListener("scroll", scheduleViewportEffects, { passive: true });
      window.addEventListener("resize", scheduleViewportEffects, { passive: true });
      window.addEventListener("pointermove", (event) => {
        document.documentElement.style.setProperty("--pointer-x", `${event.clientX}px`);
        document.documentElement.style.setProperty("--pointer-y", `${event.clientY}px`);
      }, { passive: true });
      window.setTimeout(() => {
        for (const target of root.querySelectorAll<HTMLElement>("[data-reveal]")) {
          target.classList.add("is-revealed");
        }
      }, 2400);
    }
    scheduleViewportEffects();
  }

  function scheduleViewportEffects(): void {
    if (viewportFrame) return;
    viewportFrame = window.requestAnimationFrame(() => {
      viewportFrame = 0;
      const maximum = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      const progress = Math.min(1, Math.max(0, window.scrollY / maximum));
      const progressBar = root.querySelector<HTMLElement>(".page-progress span");
      progressBar?.style.setProperty("transform", `scaleX(${progress})`);
      root.querySelector(".site-nav")?.classList.toggle("is-scrolled", window.scrollY > 20);
    });
  }

  function restoreInitialAnchor(): void {
    if (initialHashHandled || !window.location.hash) return;
    initialHashHandled = true;
    const targetId = decodeURIComponent(window.location.hash.slice(1));
    window.requestAnimationFrame(() => {
      document.getElementById(targetId)?.scrollIntoView({ block: "start" });
    });
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

function labelForRecommendation(recommendation: CombinedScoreResult["recommendation"]): string {
  switch (recommendation) {
    case "skip":
      return "Skip";
    case "questionable":
      return "Don't skip";
    default:
      return "Don't skip";
  }
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function cloudStatusLabel(status: CloudAiStatus): string {
  switch (status) {
    case "online":
      return "Live check online";
    case "offline":
      return "Quick check ready";
    case "not_configured":
      return "Quick check ready";
    default:
      return "Checking service";
  }
}

function humanizeCategory(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function parseOptionalNumber(value: string): number | null {
  if (!value.trim()) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isPlausibleYouTubeVideoId(value: string | null): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{11}$/.test(value);
}
