const playdl = require("play-dl");
const GuildQueue = require("./GuildQueue");
const Track = require("./Track");

const INVALID_URL_PLACEHOLDERS = new Set(["undefined", "null", "about:blank", "data:"]);

function normalizeHttpUrl(value) {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const normalized = trimmed.toLowerCase();
  if (INVALID_URL_PLACEHOLDERS.has(normalized)) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString();
  } catch (error) {
    return null;
  }
}

function isValidHttpUrl(value) {
  return normalizeHttpUrl(value) !== null;
}

function extractDuration(video) {
  if (!video) return 0;

  if (typeof video.durationInSec === "number") {
    return video.durationInSec * 1000;
  }

  if (typeof video.durationInMs === "number") {
    return video.durationInMs;
  }

  if (typeof video.lengthSeconds === "string") {
    const parsed = Number.parseInt(video.lengthSeconds, 10);
    if (!Number.isNaN(parsed)) {
      return parsed * 1000;
    }
  }

  if (typeof video.durationRaw === "string") {
    const segments = video.durationRaw.split(":").map(Number);
    if (segments.every(num => !Number.isNaN(num))) {
      return segments.reduce((acc, cur) => acc * 60 + cur, 0) * 1000;
    }
  }

  return 0;
}

function extractThumbnail(video) {
  const thumbnails = video.thumbnails || video.thumbnail?.thumbnails || video.thumbnail;
  if (Array.isArray(thumbnails) && thumbnails.length > 0) {
    const sorted = thumbnails.slice().sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
    return sorted[0].url;
  }

  if (typeof video.thumbnail === "string") {
    return video.thumbnail;
  }

  if (video.bestThumbnail?.url) {
    return video.bestThumbnail.url;
  }

  return null;
}

function extractChannelName(video) {
  return (
    video.channel?.name ||
    video.channel?.title ||
    video.author?.name ||
    video.uploader?.name ||
    video.ownerChannelName ||
    null
  );
}

const YOUTUBE_VIDEO_ID_REGEX = /^[\w-]{11}$/;
const INVALID_VIDEO_ID_PLACEHOLDERS = new Set([
  "undefined",
  "deleted video",
  "private video"
]);

const UNAVAILABLE_TITLE_KEYWORDS = [
  "deleted video",
  "private video",
  "video unavailable",
  "removed video",
  "비공개 동영상",
  "삭제된 동영상",
  "재생할 수 없는 동영상"
];

function sanitizeCandidateString(value) {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const normalized = trimmed.toLowerCase();
  if (INVALID_URL_PLACEHOLDERS.has(normalized)) {
    return null;
  }

  return trimmed;
}

function normalizeVideoId(candidate) {
  if (typeof candidate !== "string") return null;

  const trimmed = candidate.trim();
  if (trimmed.length === 0) return null;

  const normalized = trimmed.toLowerCase();
  if (INVALID_VIDEO_ID_PLACEHOLDERS.has(normalized)) {
    return null;
  }

  if (!YOUTUBE_VIDEO_ID_REGEX.test(trimmed)) {
    return null;
  }

  return trimmed;
}

function extractVideoIdFromUrl(url) {
  const normalizedUrl = normalizeHttpUrl(url);
  if (!normalizedUrl) {
    return { videoId: null, isYoutube: false };
  }

  const parsed = new URL(normalizedUrl);
  const hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
  const isYoutube =
    hostname === "youtu.be" ||
    hostname.endsWith("youtube.com") ||
    hostname.endsWith("youtube-nocookie.com");

  if (!isYoutube) {
    return { videoId: null, isYoutube: false };
  }

  if (hostname === "youtu.be") {
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length === 0) return { videoId: null, isYoutube: true };
    return { videoId: normalizeVideoId(segments[0]), isYoutube: true };
  }

  const directId = normalizeVideoId(parsed.searchParams.get("v"));
  if (directId) {
    return { videoId: directId, isYoutube: true };
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length >= 2) {
    const [first, second] = segments;
    if (["embed", "shorts", "live", "v"].includes(first)) {
      return { videoId: normalizeVideoId(second), isYoutube: true };
    }
  }

  return { videoId: null, isYoutube: true };
}

function extractVideoId(video) {
  if (!video) return null;

  const candidates = [
    video.id,
    video.videoId,
    video.video_id,
    video.identifier,
    video.id?.videoId,
    video.id?.video_id,
    video.id?.id,
    video.videoDetails?.videoId,
    video.video_details?.videoId
  ];

  for (const candidate of candidates) {
    const normalized = normalizeVideoId(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function resolveVideoUrl(video, fallbackUrl) {
  const candidates = [
    video?.url,
    video?.shortUrl,
    video?.short_url,
    video?.link,
    video?.permalink,
    video?.webpage_url,
    fallbackUrl
  ];

  for (const candidate of candidates) {
    const sanitizedCandidate = sanitizeCandidateString(candidate);
    if (!sanitizedCandidate) {
      continue;
    }

    const { videoId: candidateVideoId, isYoutube } = extractVideoIdFromUrl(sanitizedCandidate);
    if (candidateVideoId) {
      return `https://www.youtube.com/watch?v=${candidateVideoId}`;
    }

    if (!isYoutube) {
      const normalizedUrl = normalizeHttpUrl(sanitizedCandidate);
      if (normalizedUrl) {
        return normalizedUrl;
      }
    }
  }

  const videoId = extractVideoId(video);
  if (videoId) {
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  return null;
}

function isUnavailableVideo(video) {
  const titleCandidates = [
    video?.title,
    video?.name,
    video?.video_title,
    video?.videoTitle
  ];

  for (const candidate of titleCandidates) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim().toLowerCase();
    if (!normalized) continue;
    if (UNAVAILABLE_TITLE_KEYWORDS.some(keyword => normalized.includes(keyword))) {
      return true;
    }
  }

  if (video?.isPrivate === true || video?.is_private === true) {
    return true;
  }

  if (video?.isLive === false && video?.status === "unavailable") {
    return true;
  }

  return false;
}

function createTrackFromVideo(video, requestedBy, { fallbackUrl = null, fallbackTitle = null } = {}) {
  if (isUnavailableVideo(video)) {
    return null;
  }

  const url = resolveVideoUrl(video, fallbackUrl);
  if (!url || !isValidHttpUrl(url)) {
    return null;
  }

  return new Track({
    title: video?.title ?? fallbackTitle ?? "제목 없음",
    url,
    durationMS: extractDuration(video),
    thumbnail: extractThumbnail(video),
    author: extractChannelName(video),
    requestedBy,
    raw: video
  });
}

class MusicService {
  constructor() {
    this.queues = new Map();
  }

  getQueue(guild) {
    const guildId = typeof guild === "string" ? guild : guild.id;
    if (!this.queues.has(guildId)) {
      if (typeof guild === "string") {
        throw new Error("길드 객체가 필요합니다.");
      }
      const queue = new GuildQueue(guild, this);
      this.queues.set(guildId, queue);
    }
    return this.queues.get(guildId);
  }

  getExistingQueue(guild) {
    const guildId = typeof guild === "string" ? guild : guild.id;
    return this.queues.get(guildId) ?? null;
  }

  removeQueue(guildId) {
    this.queues.delete(guildId);
  }

  async shutdown() {
    for (const queue of this.queues.values()) {
      try {
        queue.destroy();
      } catch (error) {
        console.error("대기열 정리 실패", error);
      }
    }
    this.queues.clear();
  }

  async resolveTracks(query, requestedBy) {
    const tracks = [];

    const validation = playdl.yt_validate(query);
    if (validation === "video") {
      const info = await playdl.video_basic_info(query);
      const details = info.video_details;
      const track = createTrackFromVideo(details, requestedBy, {
        fallbackUrl: query,
        fallbackTitle: details?.title
      });
      if (track) {
        tracks.push(track);
      }
      return tracks;
    }

    if (validation === "playlist") {
      const playlist = await playdl.playlist_info(query, { incomplete: true });
      const videos = await playlist.all_videos();
      for (const [index, video] of videos.entries()) {
        if (index >= 100) break;
        const track = createTrackFromVideo(video, requestedBy, {
          fallbackTitle: video?.title
        });
        if (track) {
          tracks.push(track);
        }
      }
      return tracks;
    }

    const results = await playdl.search(query, { source: { youtube: "video" }, limit: 1 });
    if (results.length === 0) {
      return tracks;
    }

    const video = results[0];
    const track = createTrackFromVideo(video, requestedBy, {
      fallbackTitle: video?.title
    });
    if (track) {
      tracks.push(track);
    }

    return tracks;
  }

  async createStream(track) {
    if (!track?.url || !isValidHttpUrl(track.url)) {
      throw new Error("유효한 트랙 URL을 확인할 수 없습니다.");
    }

    return playdl.stream(track.url, { discordPlayerCompatibility: true });
  }
}

module.exports = MusicService;
