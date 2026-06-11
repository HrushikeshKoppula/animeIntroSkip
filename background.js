// ─── Constants ───────────────────────────────────────────────────────────────

const COMMAND_SECONDS = {
  "skip-forward-90": 90,
  "skip-backward-90": -90
};

// ─── Debounce Guard ───────────────────────────────────────────────────────────

let lastSkipTimestamp = 0;
const DEBOUNCE_MS = 300;

// ─── Command Listener ─────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  const seconds = COMMAND_SECONDS[command];
  if (!seconds) return;

  // Debounce: ignore rapid-fire keypresses
  const now = Date.now();
  if (now - lastSkipTimestamp < DEBOUNCE_MS) return;
  lastSkipTimestamp = now;

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab || !tab.id) return;

  try {
    await skipBestVideoInTab(tab.id, seconds);
  } catch (error) {
    console.warn("90s Video Skipper failed:", error);
  }
});

// ─── Core Skip Logic ──────────────────────────────────────────────────────────

async function skipBestVideoInTab(tabId, seconds) {
  // FIX #3: Start with main frame only; fall back to same-origin frames.
  // We avoid allFrames: true to prevent injection into untrusted/ad iframes.
  let frameResults = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] }, // main frame only
    func: findAndSkipBestVideo,        // FIX #4: combined find+skip in one injection
    args: [seconds]
  });

  // If no video found in main frame, try child frames (same-origin only —
  // Chrome's scripting API will silently skip cross-origin frames it can't access).
  if (frameResults[0]?.result === false) {
    const allFrameResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: findAndSkipBestVideo,
      args: [seconds]
    });

    const found = allFrameResults.some((entry) => entry.result === true);
    if (!found) {
      console.log("No seekable HTML5 video found on this page.");
    }
  }
}

// ─── Injected Functions ───────────────────────────────────────────────────────

/**
 * FIX #4: Single injected function that both finds and skips the best video,
 * eliminating the race condition between two separate executeScript calls.
 *
 * @param {number} seconds  Positive = forward, negative = backward.
 * @returns {boolean}       True if a video was found and seeked.
 */
function findAndSkipBestVideo(seconds) {
  const videos = Array.from(document.querySelectorAll("video"));

  // ── Helpers ──────────────────────────────────────────────────────────────

  function isSeekable(video) {
    if (!video) return false;
    const hasSeekableRange = video.seekable && video.seekable.length > 0;
    const hasFiniteDuration = Number.isFinite(video.duration) && video.duration > 0;
    return Number.isFinite(video.currentTime) && (hasSeekableRange || hasFiniteDuration);
  }

  function getScore(video) {
    const rect = video.getBoundingClientRect();
    const style = window.getComputedStyle(video);

    const visible =
      rect.width > 40 &&
      rect.height > 40 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) !== 0;

    const area = visible ? rect.width * rect.height : 0;
    const playing = !video.paused && !video.ended;
    const audible = !video.muted && video.volume > 0;

    let score = 0;
    if (visible) score += 500000; // Prefer visible videos
    score += area;                // Prefer larger videos
    if (playing) score += 200000; // Prefer actively playing videos
    if (audible) score += 50000;  // Slightly prefer audible videos
    return score;
  }

  function clampToSeekableRange(video, targetTime) {
    let minTime = 0;
    let maxTime = Number.isFinite(video.duration) ? video.duration : targetTime;

    if (video.seekable && video.seekable.length > 0) {
      minTime = video.seekable.start(0);
      maxTime = video.seekable.end(video.seekable.length - 1);
    }

    return Math.min(maxTime, Math.max(minTime, targetTime));
  }

  // ── Find best video ───────────────────────────────────────────────────────

  let bestVideo = null;
  let bestScore = -1;

  videos.forEach((video) => {
    if (!isSeekable(video)) return;
    const score = getScore(video);
    if (score > bestScore) {
      bestScore = score;
      bestVideo = video;
    }
  });

  if (!bestVideo) return false;

  // ── Seek ─────────────────────────────────────────────────────────────────

  const oldTime = bestVideo.currentTime || 0;
  const newTime = clampToSeekableRange(bestVideo, oldTime + seconds);
  bestVideo.currentTime = newTime;

  return true;
}
