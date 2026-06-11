const COMMAND_SECONDS = {
  "skip-forward-90": 90,
  "skip-backward-90": -90
};

chrome.commands.onCommand.addListener(async (command) => {
  const seconds = COMMAND_SECONDS[command];
  if (!seconds) return;

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

async function skipBestVideoInTab(tabId, seconds) {
  const frameResults = await chrome.scripting.executeScript({
    target: {
      tabId,
      allFrames: true
    },
    func: findBestVideoInFrame
  });

  const candidates = frameResults
    .filter((entry) => entry.result && entry.result.found)
    .map((entry) => ({
      frameId: entry.frameId,
      ...entry.result
    }))
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    console.log("No seekable HTML5 video found on this page.");
    return;
  }

  const best = candidates[0];

  await chrome.scripting.executeScript({
    target: {
      tabId,
      frameIds: [best.frameId]
    },
    func: skipVideoAtIndex,
    args: [best.index, seconds]
  });
}

function findBestVideoInFrame() {
  const videos = Array.from(document.querySelectorAll("video"));

  function isSeekable(video) {
    if (!video) return false;

    const hasSeekableRange =
      video.seekable && video.seekable.length > 0;

    const hasFiniteDuration =
      Number.isFinite(video.duration) && video.duration > 0;

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

    // Prefer visible videos.
    if (visible) score += 500000;

    // Prefer larger videos.
    score += area;

    // Prefer actively playing videos.
    if (playing) score += 200000;

    // Slightly prefer audible videos.
    if (audible) score += 50000;

    return score;
  }

  let bestVideo = null;
  let bestScore = -1;
  let bestIndex = -1;

  videos.forEach((video, index) => {
    if (!isSeekable(video)) return;

    const score = getScore(video);

    if (score > bestScore) {
      bestScore = score;
      bestVideo = video;
      bestIndex = index;
    }
  });

  if (!bestVideo) {
    return {
      found: false
    };
  }

  return {
    found: true,
    index: bestIndex,
    score: bestScore
  };
}

function skipVideoAtIndex(index, seconds) {
  const videos = Array.from(document.querySelectorAll("video"));
  const video = videos[index];

  if (!video) return;

  function clampToSeekableRange(video, targetTime) {
    let minTime = 0;
    let maxTime = Number.isFinite(video.duration)
      ? video.duration
      : targetTime;

    if (video.seekable && video.seekable.length > 0) {
      minTime = video.seekable.start(0);
      maxTime = video.seekable.end(video.seekable.length - 1);
    }

    return Math.min(maxTime, Math.max(minTime, targetTime));
  }

  const oldTime = video.currentTime || 0;
  const newTime = clampToSeekableRange(video, oldTime + seconds);

  video.currentTime = newTime;

  showSkipToast(seconds, newTime);
}

function showSkipToast(seconds, newTime) {
  const existing = document.getElementById("__video_90s_skipper_toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "__video_90s_skipper_toast";

  const sign = seconds > 0 ? "+" : "-";
  toast.textContent = `${sign}${Math.abs(seconds)}s → ${formatTime(newTime)}`;

  Object.assign(toast.style, {
    position: "fixed",
    zIndex: "2147483647",
    left: "50%",
    bottom: "12%",
    transform: "translateX(-50%)",
    padding: "10px 16px",
    borderRadius: "999px",
    background: "rgba(0, 0, 0, 0.82)",
    color: "white",
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    fontSize: "15px",
    fontWeight: "600",
    boxShadow: "0 4px 18px rgba(0, 0, 0, 0.35)",
    pointerEvents: "none"
  });

  document.documentElement.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 850);

  function formatTime(totalSeconds) {
    totalSeconds = Math.max(0, Math.floor(totalSeconds));

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }
}
