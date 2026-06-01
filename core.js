(function initCore(root, factory) {
  const api = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  root.CsdnAssistantCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createCore() {
  const LINK_STATUS = Object.freeze({
    PENDING: "pending",
    EXPORTED: "exported",
    IGNORED: "ignored"
  });

  const TASK_STATUS = Object.freeze({
    PENDING: "pending",
    SENDING: "sending",
    SUCCESS: "success",
    FAILED: "failed",
    SKIPPED: "skipped"
  });

  const CSDN_URL_RE = /https?:\/\/[^\s"'<>]+/gi;
  const TRACKING_PARAMS = [
    "spm",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "from",
    "ops_request_misc",
    "request_id",
    "biz_id"
  ];

  function nowIso() {
    return new Date().toISOString();
  }

  function decodeHtmlEntitiesForUrls(value) {
    return String(value || "")
      .replace(/&quot;/g, "\"")
      .replace(/&#34;/g, "\"")
      .replace(/&apos;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }

  function stripTrailingPunctuation(value) {
    return String(value || "").replace(/[),，。；;：:！!？?\]\}]+$/g, "");
  }

  function canonicalizeUrl(rawUrl) {
    if (!rawUrl) return null;

    const cleaned = stripTrailingPunctuation(decodeHtmlEntitiesForUrls(rawUrl).trim());

    try {
      const url = new URL(cleaned);
      const host = url.hostname.toLowerCase();

      if (host === "link.csdn.net") {
        const target = url.searchParams.get("target");
        if (target) return canonicalizeUrl(target);
      }

      url.hostname = host;
      url.hash = "";

      TRACKING_PARAMS.forEach((name) => url.searchParams.delete(name));

      if (isCsdnArticleUrl(url.toString())) {
        url.search = "";
      }

      if (url.pathname.length > 1) {
        url.pathname = url.pathname.replace(/\/+$/g, "");
      }

      return url.toString();
    } catch (_error) {
      return null;
    }
  }

  function isCsdnArticleUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.toLowerCase() === "blog.csdn.net"
        && /^\/[^/]+\/article\/details\/\d+/.test(parsed.pathname);
    } catch (_error) {
      return false;
    }
  }

  function getCsdnArticleAuthorId(url) {
    try {
      const parsed = new URL(url);
      if (!isCsdnArticleUrl(parsed.toString())) return null;
      const firstSegment = parsed.pathname.split("/").filter(Boolean)[0];
      return firstSegment ? decodeURIComponent(firstSegment) : null;
    } catch (_error) {
      return null;
    }
  }

  function normalizeAuthorId(rawValue) {
    if (!rawValue) return null;

    const value = stripTrailingPunctuation(decodeHtmlEntitiesForUrls(rawValue).trim())
      .replace(/^["'`\[\]\s]+|["'`\[\]\s]+$/g, "");

    if (!value) return null;

    try {
      const url = new URL(value);
      if (url.hostname.toLowerCase() === "blog.csdn.net") {
        const firstSegment = url.pathname.split("/").filter(Boolean)[0];
        return firstSegment ? decodeURIComponent(firstSegment) : null;
      }
    } catch (_error) {
      // Fall through to raw ID parsing.
    }

    return /^[A-Za-z0-9_-]{2,64}$/.test(value) ? value : null;
  }

  function parseOwnAuthorIds(input) {
    const values = Array.isArray(input) ? input : [];
    const text = Array.isArray(input) ? input.join("\n") : decodeHtmlEntitiesForUrls(input);
    const urls = text.match(CSDN_URL_RE) || [];
    const withoutUrls = urls.reduce((current, url) => current.replace(url, " "), text);
    const rawTokens = withoutUrls.match(/[A-Za-z0-9_][A-Za-z0-9_-]{1,63}/g) || [];
    const byKey = new Map();

    [...values, ...urls, ...rawTokens].forEach((rawValue) => {
      const authorId = normalizeAuthorId(rawValue);
      if (!authorId) return;
      byKey.set(authorId.toLowerCase(), authorId);
    });

    return Array.from(byKey.values());
  }

  function isOwnArticleUrl(url, ownAuthorIds) {
    const authorId = getCsdnArticleAuthorId(url);
    if (!authorId) return false;
    const ownIds = parseOwnAuthorIds(ownAuthorIds).map((id) => id.toLowerCase());
    return ownIds.includes(authorId.toLowerCase());
  }

  function applyOwnArticleIgnore(item, ownAuthorIds) {
    if (!item || !isOwnArticleUrl(item.url, ownAuthorIds)) {
      if (item && item.ignoreReason === "我的文章") {
        const { ignoreReason, ...rest } = item;
        return rest;
      }
      return item;
    }

    return {
      ...item,
      status: LINK_STATUS.IGNORED,
      ignoreReason: "我的文章"
    };
  }

  function applyOwnArticleIgnores(items, ownAuthorIds) {
    return (items || []).map((item) => applyOwnArticleIgnore(item, ownAuthorIds));
  }

  function extractCsdnArticleLinks(source) {
    const text = decodeHtmlEntitiesForUrls(source);
    const matches = text.match(CSDN_URL_RE) || [];
    const urls = matches
      .map(canonicalizeUrl)
      .filter(Boolean)
      .filter(isCsdnArticleUrl);

    return Array.from(new Set(urls));
  }

  function parseImportedLinks(input) {
    return extractCsdnArticleLinks(input);
  }

  function parseCsdnMessageTimeMs(text, now) {
    const value = String(text || "").trim();
    const current = now instanceof Date ? now : new Date(now || Date.now());
    const currentYear = current.getFullYear();
    const match = value.match(/\b(?:(\d{4})[-/])?(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})\b/);

    if (!match) return null;

    const explicitYear = match[1] ? Number(match[1]) : currentYear;
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);

    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
      return null;
    }

    const parsed = new Date(explicitYear, month - 1, day, hour, minute, 0, 0);
    if (Number.isNaN(parsed.getTime())) return null;

    if (!match[1] && parsed.getTime() > current.getTime()) {
      parsed.setFullYear(parsed.getFullYear() - 1);
    }

    return parsed.getTime();
  }

  function normalizeRecentDays(value, defaultDays) {
    const fallback = Number(defaultDays || 7);
    const days = value === undefined || value === null || value === "" ? fallback : Number(value);
    if (!Number.isFinite(days)) return Math.min(30, Math.max(1, fallback));
    return Math.min(30, Math.max(1, Math.floor(days)));
  }

  function mergeSourceUserFields(item, sourceUserId) {
    if (!sourceUserId) return item;

    const sourceUsers = Array.isArray(item.sourceUsers)
      ? item.sourceUsers.slice()
      : [];

    if (item.sourceUserId) {
      sourceUsers.push(item.sourceUserId);
    }

    sourceUsers.push(sourceUserId);

    const uniqueSourceUsers = Array.from(new Set(sourceUsers.filter(Boolean)));

    return {
      ...item,
      sourceUserId: item.sourceUserId || sourceUserId,
      sourceUsers: uniqueSourceUsers
    };
  }

  function mergeScannedLinks(existingItems, scannedUrls, context) {
    const items = Array.isArray(existingItems) ? existingItems.slice() : [];
    const byUrl = new Map(items.map((item) => [item.url, { ...item }]));
    const timestamp = context && context.now ? context.now : nowIso();
    const senderName = context && context.senderName ? context.senderName : undefined;
    const ownAuthorIds = context && context.ownAuthorIds ? context.ownAuthorIds : [];
    const sourceUserId = context && context.sourceUserId ? context.sourceUserId : undefined;

    scannedUrls.forEach((rawUrl) => {
      const url = canonicalizeUrl(rawUrl);
      if (!url || !isCsdnArticleUrl(url)) return;

      const current = byUrl.get(url);
      if (current) {
        byUrl.set(url, applyOwnArticleIgnore(mergeSourceUserFields({
          ...current,
          seenCount: Number(current.seenCount || 1) + 1,
          senderName: current.senderName || senderName
        }, sourceUserId), ownAuthorIds));
        return;
      }

      byUrl.set(url, applyOwnArticleIgnore(mergeSourceUserFields({
        url,
        source: "csdn_message",
        senderName,
        firstSeenAt: timestamp,
        seenCount: 1,
        status: LINK_STATUS.PENDING
      }, sourceUserId), ownAuthorIds));
    });

    return Array.from(byUrl.values()).sort((a, b) => {
      return String(b.firstSeenAt || "").localeCompare(String(a.firstSeenAt || ""));
    });
  }

  function getExportableLinkUrls(items, options) {
    const selectedStatuses = options && Array.isArray(options.statuses) && options.statuses.length
      ? options.statuses
      : [LINK_STATUS.PENDING];
    const ownAuthorIds = options && options.ownAuthorIds ? options.ownAuthorIds : [];

    return (items || [])
      .filter((item) => selectedStatuses.includes(item.status))
      .filter((item) => !isOwnArticleUrl(item.url, ownAuthorIds))
      .map((item) => item.url);
  }

  function formatLinksForExport(items, format, options) {
    const urls = getExportableLinkUrls(items, options);

    if (format === "json") {
      return JSON.stringify(urls, null, 2);
    }

    return `const csdnLinks = ${JSON.stringify(urls, null, 2)};`;
  }

  function markPendingLinksExported(items, options) {
    const ownAuthorIds = options && options.ownAuthorIds ? options.ownAuthorIds : [];
    const selectedStatuses = options && Array.isArray(options.statuses) && options.statuses.length
      ? options.statuses
      : [LINK_STATUS.PENDING];

    return (items || []).map((item) => {
      if (item.status !== LINK_STATUS.PENDING) return item;
      if (!selectedStatuses.includes(LINK_STATUS.PENDING)) return item;
      if (isOwnArticleUrl(item.url, ownAuthorIds)) return applyOwnArticleIgnore(item, ownAuthorIds);
      return { ...item, status: LINK_STATUS.EXPORTED };
    });
  }

  function updateLinkStatus(items, url, status, options) {
    const normalizedUrl = canonicalizeUrl(url);
    const ownAuthorIds = options && options.ownAuthorIds ? options.ownAuthorIds : [];

    return (items || []).map((item) => {
      if (item.url !== normalizedUrl) return item;
      const nextItem = {
        ...item,
        status,
        ...(status === LINK_STATUS.IGNORED ? { ignoreReason: item.ignoreReason } : {})
      };
      return applyOwnArticleIgnore(nextItem, ownAuthorIds);
    });
  }

  function removeLink(items, url) {
    const normalizedUrl = canonicalizeUrl(url);
    return (items || []).filter((item) => item.url !== normalizedUrl);
  }

  function clearExportedLinks(items) {
    return (items || []).filter((item) => item.status !== LINK_STATUS.EXPORTED);
  }

  function normalizeHomepageUrl(rawValue) {
    if (!rawValue) return null;

    const value = stripTrailingPunctuation(decodeHtmlEntitiesForUrls(rawValue).trim());
    const candidate = /^https?:\/\//i.test(value)
      ? value
      : `https://blog.csdn.net/${value}`;

    try {
      const url = new URL(candidate);
      if (url.hostname.toLowerCase() !== "blog.csdn.net") return null;

      const firstSegment = url.pathname.split("/").filter(Boolean)[0];
      if (!firstSegment || firstSegment === "article") return null;

      return `https://blog.csdn.net/${firstSegment}`;
    } catch (_error) {
      return null;
    }
  }

  function normalizeUserId(rawValue) {
    if (!rawValue) return null;

    const value = stripTrailingPunctuation(decodeHtmlEntitiesForUrls(rawValue).trim())
      .replace(/^["'`\[\]\s]+|["'`\[\]\s]+$/g, "");

    if (!value) return null;

    try {
      const url = new URL(/^https?:\/\//i.test(value) ? value : `https://placeholder.local/${value}`);
      const host = url.hostname.toLowerCase();

      if (host === "i.csdn.net") {
        const match = url.hash.match(/#\/msg\/chat\/([^/?#&]+)/);
        return match ? decodeURIComponent(match[1]) : null;
      }

      if (host === "im.csdn.net") {
        const match = url.pathname.match(/\/ichat\/([^/?#&]+)/);
        return match ? decodeURIComponent(match[1]).toLowerCase() : null;
      }

      if (host === "blog.csdn.net") {
        const firstSegment = url.pathname.split("/").filter(Boolean)[0];
        if (!firstSegment || firstSegment === "article") return null;
        return decodeURIComponent(firstSegment);
      }

      if (url.pathname.includes("/msg/chat/")) {
        const match = url.pathname.match(/\/msg\/chat\/([^/?#&]+)/);
        return match ? decodeURIComponent(match[1]) : null;
      }
    } catch (_error) {
      // Fall through to raw ID parsing.
    }

    if (/^[A-Za-z0-9_-]{2,64}$/.test(value)) {
      return value;
    }

    return null;
  }

  function buildChatUrl(userId) {
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) return null;
    return `https://i.csdn.net/#/msg/chat/${encodeURIComponent(normalizedUserId)}`;
  }

  function buildChatFrameUrl(userId) {
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) return null;

    const match = normalizedUserId.match(/^t(\d+)$/i);
    if (!match) return null;

    return `https://im.csdn.net/ichat/T${match[1]}?mode=frame`;
  }

  function normalizeChatFrameUrl(rawValue) {
    if (!rawValue) return null;

    const value = stripTrailingPunctuation(decodeHtmlEntitiesForUrls(rawValue).trim());

    try {
      const url = new URL(value);
      if (url.hostname.toLowerCase() !== "im.csdn.net") return null;
      const match = url.pathname.match(/^\/ichat\/([^/?#]+)/);
      if (!match) return null;

      const chatId = decodeURIComponent(match[1]);
      const normalizedChatId = /^t\d+$/i.test(chatId)
        ? `T${chatId.slice(1)}`
        : chatId;

      url.pathname = `/ichat/${encodeURIComponent(normalizedChatId)}`;
      url.searchParams.set("mode", "frame");
      return url.toString();
    } catch (_error) {
      return null;
    }
  }

  function extractTargetUserReferences(input) {
    const text = decodeHtmlEntitiesForUrls(input);
    const urls = text.match(CSDN_URL_RE) || [];
    const withoutUrls = urls.reduce((current, url) => current.replace(url, " "), text);
    const quoted = Array.from(withoutUrls.matchAll(/["'`]([^"'`]+)["'`]/g)).map((match) => match[1]);
    const rawTokens = withoutUrls.match(/[A-Za-z0-9_][A-Za-z0-9_-]{1,63}/g) || [];
    const references = [...urls, ...quoted, ...rawTokens]
      .map((rawValue) => {
        const userId = normalizeUserId(rawValue);
        if (!userId) return null;

        return {
          userId,
          frameChatUrl: normalizeChatFrameUrl(rawValue) || undefined
        };
      })
      .filter(Boolean);

    const byId = new Map();
    references.forEach((reference) => {
      const current = byId.get(reference.userId);
      byId.set(reference.userId, {
        ...current,
        ...reference,
        frameChatUrl: reference.frameChatUrl || (current && current.frameChatUrl)
      });
    });

    return Array.from(byId.values());
  }

  function extractTargetUserIds(input) {
    return extractTargetUserReferences(input).map((reference) => reference.userId);
  }

  function parseTargetUserEntries(input, groupName) {
    const group = String(groupName || "默认分组").trim() || "默认分组";

    return extractTargetUserReferences(input).map((reference) => {
      const userId = reference.userId;
      const frameChatUrl = reference.frameChatUrl || buildChatFrameUrl(userId);

      return {
        userId,
        chatUrl: buildChatUrl(userId),
        homepageUrl: normalizeHomepageUrl(userId),
        groupName: group,
        enabled: true,
        ...(frameChatUrl ? { frameChatUrl } : {})
      };
    });
  }

  function parseHomepageEntries(input, groupName) {
    return parseTargetUserEntries(input, groupName);
  }

  function mergeTargetUsers(existingUsers, newUsers) {
    const byId = new Map();

    (existingUsers || []).forEach((user) => {
      const userId = normalizeUserId(user.userId || user.chatUrl || user.homepageUrl);
      if (!userId) return;

      byId.set(userId, {
        ...user,
        userId,
        chatUrl: user.chatUrl || buildChatUrl(userId),
        frameChatUrl: user.frameChatUrl || buildChatFrameUrl(userId),
        homepageUrl: user.homepageUrl || normalizeHomepageUrl(userId),
        enabled: user.enabled !== false
      });
    });

    (newUsers || []).forEach((user) => {
      const userId = normalizeUserId(user.userId || user.chatUrl || user.homepageUrl);
      if (!userId) return;

      const current = byId.get(userId);
      byId.set(userId, {
        ...current,
        ...user,
        userId,
        chatUrl: user.chatUrl || (current && current.chatUrl) || buildChatUrl(userId),
        frameChatUrl: user.frameChatUrl || (current && current.frameChatUrl) || buildChatFrameUrl(userId),
        homepageUrl: user.homepageUrl || (current && current.homepageUrl) || normalizeHomepageUrl(userId),
        enabled: current ? current.enabled !== false : user.enabled !== false,
        lastSentAt: current && current.lastSentAt ? current.lastSentAt : user.lastSentAt
      });
    });

    return Array.from(byId.values()).sort((a, b) => {
      return String(a.groupName || "").localeCompare(String(b.groupName || ""))
        || String(a.userId).localeCompare(String(b.userId));
    });
  }

  function getGroups(users) {
    return Array.from(new Set((users || []).map((user) => user.groupName || "默认分组"))).sort();
  }

  function getUsersForGroup(users, groupName, includeDisabled) {
    return (users || []).filter((user) => {
      if ((user.groupName || "默认分组") !== groupName) return false;
      return includeDisabled ? true : user.enabled !== false;
    });
  }

  function createSendTasks(users, message) {
    const text = String(message || "").trim();

    return (users || [])
      .filter((user) => user.enabled !== false)
      .map((user) => {
        const userId = user.userId || normalizeUserId(user.chatUrl || user.homepageUrl);
        const frameChatUrl = user.frameChatUrl || buildChatFrameUrl(userId);

        return {
          userId,
          userHomepageUrl: user.homepageUrl,
          chatUrl: user.chatUrl || buildChatUrl(userId || user.homepageUrl),
          ...(frameChatUrl ? { frameChatUrl } : {}),
          message: text,
          status: TASK_STATUS.PENDING
        };
      });
  }

  function createLogEntry(task, status, errorMessage, timestamp) {
    return {
      userId: task.userId,
      userHomepageUrl: task.userHomepageUrl,
      chatUrl: task.chatUrl,
      frameChatUrl: task.frameChatUrl,
      message: task.message,
      status,
      errorMessage: errorMessage || undefined,
      createdAt: timestamp || nowIso()
    };
  }

  return {
    LINK_STATUS,
    TASK_STATUS,
    applyOwnArticleIgnores,
    buildChatFrameUrl,
    buildChatUrl,
    canonicalizeUrl,
    clearExportedLinks,
    createLogEntry,
    createSendTasks,
    extractCsdnArticleLinks,
    extractTargetUserReferences,
    extractTargetUserIds,
    formatLinksForExport,
    getCsdnArticleAuthorId,
    getExportableLinkUrls,
    getGroups,
    getUsersForGroup,
    isCsdnArticleUrl,
    isOwnArticleUrl,
    markPendingLinksExported,
    mergeScannedLinks,
    mergeTargetUsers,
    normalizeHomepageUrl,
    normalizeChatFrameUrl,
    normalizeUserId,
    nowIso,
    normalizeRecentDays,
    parseCsdnMessageTimeMs,
    parseImportedLinks,
    parseHomepageEntries,
    parseOwnAuthorIds,
    parseTargetUserEntries,
    removeLink,
    updateLinkStatus
  };
});
