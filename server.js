import cors from "cors";
import express from "express";

const HOST = String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";
const PORT = clampInteger(process.env.PORT, 3000, 1, 65535);
const REQUEST_TIMEOUT_MS = clampInteger(process.env.REQUEST_TIMEOUT_MS, 10000, 2000, 30000);
const WASTELAND_REMASTERED_STATUS_CACHE_TTL_MS = clampInteger(process.env.WASTELAND_REMASTERED_STATUS_CACHE_TTL_MS, 60000, 1000, 300000);

const WASTELAND_REMASTERED_STEAM_APP_ID = 875800;
const WASTELAND_REMASTERED_STEAM_URL = "https://store.steampowered.com/app/875800/Wasteland_Remastered/";
const WASTELAND_REMASTERED_GOG_URL = "https://www.gog.com/en/game/wasteland_remastered";
const WASTELAND_REMASTERED_DISCUSSIONS_URL = "https://steamcommunity.com/app/875800/discussions/";
const WASTELAND_REMASTERED_GUIDES_URL = "https://steamcommunity.com/app/875800/guides/";
const WASTELAND_REMASTERED_NEWS_URL = "https://store.steampowered.com/news/app/875800";
const WASTELAND_REMASTERED_WIKI_URL = "https://wasteland.fandom.com/wiki/Wasteland_Remastered";
const WASTELAND_REMASTERED_OFFICIAL_URL = "https://web-front.inxile.net/games/wasteland-remastered";

const app = express();
const responseCache = new Map();

app.disable("x-powered-by");
app.use(cors());
app.use(express.json());

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function normalizeOptionalInteger(value, min, max) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.min(max, Math.max(min, parsed));
}

function sanitizeDisplayText(value, maxLength = 240) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function getCachedPayload(key, ttlMs) {
  const cached = responseCache.get(key);

  if (!cached) {
    return null;
  }

  if (Date.now() - cached.createdAt > ttlMs) {
    responseCache.delete(key);
    return null;
  }

  return cached.payload;
}

function setCachedPayload(key, payload) {
  responseCache.set(key, {
    payload,
    createdAt: Date.now()
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, sourceLabel) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "wasteland-remastered-api/1.0",
        Accept: "application/json"
      },
      redirect: "follow",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`${sourceLabel} returned HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${sourceLabel} request timed out`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchPageStatus(url, sourceLabel) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "wasteland-remastered-api/1.0",
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
      },
      redirect: "follow",
      signal: controller.signal
    });

    return {
      ok: response.ok,
      status: response.status,
      url: response.url || url
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${sourceLabel} request timed out`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchSteamCurrentPlayers(appId = WASTELAND_REMASTERED_STEAM_APP_ID) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let payload;

      try {
        const response = await fetch(
          `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appId}`,
          {
            redirect: "follow",
            signal: controller.signal
          }
        );

        if (!response.ok) {
          throw new Error(`Steam current players API returned HTTP ${response.status}`);
        }

        payload = await response.json();
      } finally {
        clearTimeout(timeoutId);
      }

      return normalizeOptionalInteger(payload?.response?.player_count, 0, 50000000);
    } catch (error) {
      lastError = error;

      if (attempt < 1) {
        await sleep(350);
      }
    }
  }

  throw lastError || new Error("Steam current players API request failed.");
}

function getStateFromStatus(ok, hasValue = true) {
  if (ok === true && hasValue) {
    return "online";
  }

  if (ok === false) {
    return "offline";
  }

  return "unknown";
}

function toHttpValueLabel(statusCode) {
  return statusCode ? `HTTP ${statusCode}` : "—";
}

async function getWastelandRemasteredStatusPayload() {
  const cacheKey = "wasteland-remastered:status";
  const cached = getCachedPayload(cacheKey, WASTELAND_REMASTERED_STATUS_CACHE_TTL_MS);

  if (cached?.items && Array.isArray(cached.items)) {
    return {
      ...cached,
      cached: true
    };
  }

  const [
    steamPlayersResult,
    discussionsPageResult,
    gogPageResult,
    guidesPageResult,
    newsPageResult,
    wikiPageResult,
    falloutWikiResult
  ] = await Promise.allSettled([
    fetchSteamCurrentPlayers(),
    fetchPageStatus(WASTELAND_REMASTERED_DISCUSSIONS_URL, "Wasteland Remastered Steam discussions page"),
    fetchPageStatus(WASTELAND_REMASTERED_GOG_URL, "Wasteland Remastered GOG page"),
    fetchPageStatus(WASTELAND_REMASTERED_GUIDES_URL, "Wasteland Remastered guides page"),
    fetchPageStatus(WASTELAND_REMASTERED_NEWS_URL, "Wasteland Remastered news page"),
    fetchPageStatus(WASTELAND_REMASTERED_WIKI_URL, "Wasteland Remastered wiki page"),
    fetchPageStatus(WASTELAND_REMASTERED_OFFICIAL_URL, "Wasteland Remastered official page")
  ]);

  const steamPlayers = steamPlayersResult.status === "fulfilled" ? steamPlayersResult.value : null;
  const steamPlayersError = steamPlayersResult.status === "rejected"
    ? sanitizeDisplayText(steamPlayersResult.reason?.message || "Steam players request failed.", 180)
    : "";

  const discussionsPage = discussionsPageResult.status === "fulfilled" ? discussionsPageResult.value : null;
  const discussionsPageError = discussionsPageResult.status === "rejected"
    ? sanitizeDisplayText(discussionsPageResult.reason?.message || "Steam discussions request failed.", 180)
    : "";

  const gogPage = gogPageResult.status === "fulfilled" ? gogPageResult.value : null;
  const gogPageError = gogPageResult.status === "rejected"
    ? sanitizeDisplayText(gogPageResult.reason?.message || "GOG page request failed.", 180)
    : "";

  const guidesPage = guidesPageResult.status === "fulfilled" ? guidesPageResult.value : null;
  const guidesPageError = guidesPageResult.status === "rejected"
    ? sanitizeDisplayText(guidesPageResult.reason?.message || "Guides page request failed.", 180)
    : "";

  const newsPage = newsPageResult.status === "fulfilled" ? newsPageResult.value : null;
  const newsPageError = newsPageResult.status === "rejected"
    ? sanitizeDisplayText(newsPageResult.reason?.message || "News page request failed.", 180)
    : "";

  const wikiPage = wikiPageResult.status === "fulfilled" ? wikiPageResult.value : null;
  const wikiPageError = wikiPageResult.status === "rejected"
    ? sanitizeDisplayText(wikiPageResult.reason?.message || "Wiki page request failed.", 180)
    : "";

  const officialPage = falloutWikiResult.status === "fulfilled" ? falloutWikiResult.value : null;
  const officialPageError = falloutWikiResult.status === "rejected"
    ? sanitizeDisplayText(falloutWikiResult.reason?.message || "Official page request failed.", 180)
    : "";

  const items = [
    {
      key: "steam-players",
      kind: "players",
      name: "Steam онлайн",
      sourceLabel: "Steam",
      status: getStateFromStatus(steamPlayers !== null, steamPlayers !== null),
      value: steamPlayers,
      valueLabel: steamPlayers !== null ? String(steamPlayers) : "—",
      httpStatus: null,
      url: WASTELAND_REMASTERED_STEAM_URL,
      title: "Wasteland Remastered on Steam",
      description: "Текущий онлайн Wasteland Remastered в Steam. Это число игроков в PC Steam, а не какой-либо общий серверный онлайн.",
      note: steamPlayersError ? "Steam временно не отдал число игроков." : "Число игроков получено из официального Steam current players API."
    },
    {
      key: "steam-discussions",
      kind: "community",
      name: "Обсуждения Steam",
      sourceLabel: "Steam Discussions",
      status: getStateFromStatus(Boolean(discussionsPage?.ok)),
      value: discussionsPage?.status ?? null,
      valueLabel: toHttpValueLabel(discussionsPage?.status ?? null),
      httpStatus: discussionsPage?.status ?? null,
      url: discussionsPage?.url || WASTELAND_REMASTERED_DISCUSSIONS_URL,
      title: "Steam Community :: Wasteland Remastered Discussions",
      description: "Раздел обсуждений Wasteland Remastered в Steam Community с вопросами, ответами и полезными темами игроков.",
      note: discussionsPageError ? "Раздел обсуждений временно не ответил." : (discussionsPage?.ok ? "Раздел обсуждений доступен." : "Раздел обсуждений сейчас не подтвердил корректный ответ.")
    },
    {
      key: "gog-page",
      kind: "store",
      name: "Страница GOG",
      sourceLabel: "GOG",
      status: getStateFromStatus(Boolean(gogPage?.ok)),
      value: gogPage?.status ?? null,
      valueLabel: toHttpValueLabel(gogPage?.status ?? null),
      httpStatus: gogPage?.status ?? null,
      url: gogPage?.url || WASTELAND_REMASTERED_GOG_URL,
      title: "Wasteland Remastered on GOG",
      description: "Страница Wasteland Remastered в магазине GOG с DRM-free версией ремастера.",
      note: gogPageError ? "Страница GOG временно не ответила." : (gogPage?.ok ? "Страница GOG доступна." : "Страница GOG сейчас не подтвердила корректный ответ.")
    },
    {
      key: "guides-page",
      kind: "guide",
      name: "Гайды сообщества",
      sourceLabel: "Steam Guides",
      status: getStateFromStatus(Boolean(guidesPage?.ok)),
      value: guidesPage?.status ?? null,
      valueLabel: toHttpValueLabel(guidesPage?.status ?? null),
      httpStatus: guidesPage?.status ?? null,
      url: guidesPage?.url || WASTELAND_REMASTERED_GUIDES_URL,
      title: "Steam Community :: Wasteland Remastered Guides",
      description: "Подборка пользовательских гайдов и советов по Wasteland Remastered в Steam Community.",
      note: guidesPageError ? "Раздел гайдов временно не ответил." : (guidesPage?.ok ? "Раздел гайдов доступен." : "Раздел гайдов сейчас не подтвердил корректный ответ.")
    },
    {
      key: "news-page",
      kind: "news",
      name: "Новости игры",
      sourceLabel: "Steam News",
      status: getStateFromStatus(Boolean(newsPage?.ok)),
      value: newsPage?.status ?? null,
      valueLabel: toHttpValueLabel(newsPage?.status ?? null),
      httpStatus: newsPage?.status ?? null,
      url: newsPage?.url || WASTELAND_REMASTERED_NEWS_URL,
      title: "Wasteland Remastered - Steam News Hub",
      description: "Лента новостей и обновлений Wasteland Remastered в Steam.",
      note: newsPageError ? "Раздел новостей временно не ответил." : (newsPage?.ok ? "Раздел новостей доступен." : "Раздел новостей сейчас не подтвердил корректный ответ.")
    },
    {
      key: "wiki-page",
      kind: "wiki",
      name: "Wiki",
      sourceLabel: "Wasteland Wiki",
      status: getStateFromStatus(Boolean(wikiPage?.ok)),
      value: wikiPage?.status ?? null,
      valueLabel: toHttpValueLabel(wikiPage?.status ?? null),
      httpStatus: wikiPage?.status ?? null,
      url: wikiPage?.url || WASTELAND_REMASTERED_WIKI_URL,
      title: "Wasteland Remastered Wiki",
      description: "Энциклопедическая страница Wasteland Remastered с базовой информацией, фактами и справкой по игре.",
      note: wikiPageError ? "Wiki-страница временно не ответила." : (wikiPage?.ok ? "Wiki-страница доступна." : "Wiki-страница сейчас не подтвердила корректный ответ.")
    },
    {
      key: "official-page",
      kind: "official",
      name: "Официальный сайт",
      sourceLabel: "inXile",
      status: getStateFromStatus(Boolean(officialPage?.ok)),
      value: officialPage?.status ?? null,
      valueLabel: toHttpValueLabel(officialPage?.status ?? null),
      httpStatus: officialPage?.status ?? null,
      url: officialPage?.url || WASTELAND_REMASTERED_OFFICIAL_URL,
      title: "Wasteland Remastered | inXile Entertainment",
      description: "Официальная страница Wasteland Remastered от inXile Entertainment.",
      note: officialPageError ? "Официальная страница временно не ответила." : (officialPage?.ok ? "Официальная страница доступна." : "Официальная страница сейчас не подтвердила корректный ответ.")
    }
  ];

  const availableCount = items.filter((item) => item.status === "online").length;
  const offlineCount = items.filter((item) => item.status === "offline").length;
  const unknownCount = items.length - availableCount - offlineCount;
  const overallStatus = offlineCount > 0 ? "degraded" : availableCount > 0 ? "online" : "unknown";

  const payload = {
    service: "wasteland-remastered-api",
    source: "public-pages-and-steam",
    fetchedAt: new Date().toISOString(),
    cached: false,
    summary: {
      signalCount: items.length,
      availableCount,
      offlineCount,
      unknownCount,
      steamPlayers,
      overallStatus
    },
    disclaimer: "Wasteland Remastered не имеет публичного списка серверов. Эта страница показывает реальный Steam онлайн и доступность ключевых публичных страниц по игре.",
    items
  };

  setCachedPayload(cacheKey, payload);
  return payload;
}

app.get("/", (_req, res) => {
  res.type("text/plain").send("Wasteland Remastered API is running.");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "wasteland-remastered-api",
    fetchedAt: new Date().toISOString()
  });
});

app.get("/api/wasteland-remastered-status", async (_req, res) => {
  try {
    const payload = await getWastelandRemasteredStatusPayload();
    res.json(payload);
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: "WASTELAND_REMASTERED_STATUS_FETCH_FAILED",
      message: error?.message || "Unable to build Wasteland Remastered status payload.",
      fetchedAt: new Date().toISOString()
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: "NOT_FOUND"
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Wasteland Remastered API listening on http://${HOST}:${PORT}`);
});
