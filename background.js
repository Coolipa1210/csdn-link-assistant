importScripts("core.js");

const Core = globalThis.CsdnAssistantCore;
const SEND_RUN_KEY = "sendRun";
const SEND_LOGS_KEY = "sendLogs";
const TARGET_USERS_KEY = "targetUsers";
const CHAT_FRAME_MAP_KEY = "chatFrameMap";

let processing = false;
let pauseRequested = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

function storageSet(value) {
  return chrome.storage.local.set(value);
}

async function getSendRun() {
  const result = await storageGet([SEND_RUN_KEY]);
  return result[SEND_RUN_KEY] || null;
}

async function saveSendRun(run) {
  await storageSet({ [SEND_RUN_KEY]: run });
}

async function appendLog(entry) {
  const result = await storageGet([SEND_LOGS_KEY]);
  const logs = Array.isArray(result[SEND_LOGS_KEY]) ? result[SEND_LOGS_KEY] : [];
  logs.unshift(entry);
  await storageSet({ [SEND_LOGS_KEY]: logs.slice(0, 300) });
}

function getChatFrameCacheKey(task) {
  const userId = task.userId || Core.normalizeUserId(task.chatUrl || task.userHomepageUrl);
  return userId ? String(userId).toLowerCase() : null;
}

function normalizeChatFrameUrl(frameUrl) {
  return Core.normalizeChatFrameUrl(frameUrl);
}

async function getCachedChatFrameUrl(task) {
  const directFrameUrl = normalizeChatFrameUrl(task.frameChatUrl || Core.buildChatFrameUrl(task.userId));
  if (directFrameUrl) return directFrameUrl;

  const key = getChatFrameCacheKey(task);
  if (!key) return null;

  const result = await storageGet([CHAT_FRAME_MAP_KEY]);
  const map = result[CHAT_FRAME_MAP_KEY] || {};
  return normalizeChatFrameUrl(map[key]);
}

async function cacheChatFrameUrl(task, frameUrl) {
  const key = getChatFrameCacheKey(task);
  const normalizedFrameUrl = normalizeChatFrameUrl(frameUrl);
  if (!key || !normalizedFrameUrl) return;

  const result = await storageGet([CHAT_FRAME_MAP_KEY]);
  const map = result[CHAT_FRAME_MAP_KEY] || {};
  map[key] = normalizedFrameUrl;
  await storageSet({ [CHAT_FRAME_MAP_KEY]: map });
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => finish(false), timeoutMs);

    function finish(success) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(success);
    }

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish(true);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["core.js", "content.js"]
  });
}

async function prepareMessageInFrames(tabId, task, autoSend) {
  const results = await chrome.scripting.executeScript({
    target: {
      tabId,
      allFrames: true
    },
    args: [task.message, autoSend],
    func: async (message, shouldSend) => {
      function sleepInPage(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      function isPrivateMessageContext() {
        return location.hostname === "im.csdn.net"
          && /^\/ichat\/[^/]+/.test(location.pathname);
      }

      function isVisible(element) {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity) !== 0
          && rect.width > 0
          && rect.height > 0;
      }

      function findMessageInput() {
        const selectors = [
          "textarea",
          "[contenteditable='true']",
          ".ql-editor",
          "[role='textbox']",
          "input[type='text']",
          "input:not([type])"
        ];

        return selectors
          .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
          .find((element) => {
            if (!isVisible(element)) return false;
            if (!(element instanceof HTMLInputElement)) return true;
            const hint = `${element.placeholder || ""} ${element.id || ""} ${element.className || ""}`;
            return !/search|搜索/i.test(hint);
          }) || null;
      }

      function setInputValue(input, value) {
        input.focus();

        if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
          const proto = input instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          setter.call(input, value);
        } else {
          input.textContent = "";
          document.execCommand("insertText", false, value);
          if (!input.textContent || !input.textContent.includes(value)) {
            input.textContent = value;
          }
        }

        input.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: value
        }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }

      function isEnabledButton(element) {
        if (!element) return false;
        if (element.disabled) return false;
        if (element.getAttribute("aria-disabled") === "true") return false;
        const className = String(element.className || "");
        return !/\bis-disabled\b|disabled/.test(className);
      }

      function findSendButton() {
        const primary = Array.from(document.querySelectorAll("button")).find((element) => {
          if (!isVisible(element) || !isEnabledButton(element)) return false;
          const text = (element.textContent || "").replace(/\s+/g, "");
          return text === "发送";
        });

        if (primary) return primary;

        const candidates = Array.from(document.querySelectorAll("[role='button'], a, div, span"));
        return candidates.find((element) => {
          if (!isVisible(element) || !isEnabledButton(element)) return false;
          const text = (element.textContent || "").replace(/\s+/g, "");
          const className = String(element.className || "");
          return text === "发送" || /send|submit/i.test(className);
        }) || null;
      }

      async function waitForSendButton() {
        for (let index = 0; index < 10; index += 1) {
          const button = findSendButton();
          if (button) return button;
          await sleepInPage(300);
        }
        return null;
      }

      function clickLikeUser(element) {
        element.scrollIntoView({ block: "center", inline: "center" });
        element.focus && element.focus();

        const eventInit = {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0,
          buttons: 1
        };

        ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) => {
          const EventCtor = type.startsWith("pointer") && window.PointerEvent
            ? PointerEvent
            : MouseEvent;
          element.dispatchEvent(new EventCtor(type, eventInit));
        });
      }

      if (!isPrivateMessageContext()) {
        return {
          success: false,
          ignored: true,
          frameUrl: location.href,
          errorMessage: "不是私信 iframe，已跳过"
        };
      }

      for (let index = 0; index < 6; index += 1) {
        const input = findMessageInput();
        if (input) {
          setInputValue(input, message);

          if (!shouldSend) {
            return {
              success: true,
              preparedOnly: true,
              frameUrl: location.href,
              message: "已填入消息，等待手动审核发送"
            };
          }

          await sleepInPage(500);
          const sendButton = await waitForSendButton();
          if (!sendButton) {
            return {
              success: false,
              frameUrl: location.href,
              errorMessage: "已填入消息，但没有找到发送按钮"
            };
          }

          clickLikeUser(sendButton);
          return {
            success: true,
            preparedOnly: false,
            frameUrl: location.href,
            message: "已点击发送按钮"
          };
        }

        await sleepInPage(700);
      }

      return {
        success: false,
        frameUrl: location.href,
        errorMessage: "没有找到可填写的私信输入框"
      };
    }
  });

  const responses = results.map((item) => item.result).filter(Boolean);
  const actionableResponses = responses.filter((item) => !item.ignored);
  return actionableResponses.find((item) => item.success)
    || actionableResponses.find((item) => item.errorMessage && !item.errorMessage.includes("没有找到"))
    || actionableResponses[0]
    || {
      success: false,
      errorMessage: "没有在私信 iframe 中找到可处理页面"
    };
}

async function getPrivateFrameInfo(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const frame = document.querySelector('iframe[name="private"]');
      const directFrameSrc = /^https:\/\/im\.csdn\.net\/ichat\//.test(location.href)
        ? location.href
        : "";
      const frameSrc = frame && frame.src ? frame.src : directFrameSrc;

      return {
        success: Boolean(frameSrc),
        href: location.href,
        frameSrc,
        title: document.title
      };
    }
  });

  return results && results[0] ? results[0].result : null;
}

async function waitForPrivateFrameInfo(tabId) {
  let lastInfo = null;

  for (let index = 0; index < 20; index += 1) {
    lastInfo = await getPrivateFrameInfo(tabId).catch((error) => ({
      success: false,
      frameSrc: "",
      errorMessage: error && error.message ? error.message : "读取私信 iframe 失败"
    }));

    if (lastInfo && lastInfo.frameSrc) return lastInfo;
    await sleep(500);
  }

  return lastInfo;
}

async function switchPrivateFrame(tabId, frameUrl, displayUrl) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [frameUrl, displayUrl],
    func: async (targetFrameUrl, targetDisplayUrl) => {
      const frame = document.querySelector('iframe[name="private"]');

      if (!frame) {
        return {
          success: false,
          errorMessage: "当前页面没有私信 iframe"
        };
      }

      let displayChanged = false;
      try {
        if (targetDisplayUrl && new URL(targetDisplayUrl).origin === location.origin) {
          history.replaceState({}, "", targetDisplayUrl);
          displayChanged = true;
        }
      } catch (_error) {
        displayChanged = false;
      }

      const loaded = await new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => finish(false), 6000);

        function finish(value) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          frame.removeEventListener("load", onLoad);
          resolve(value);
        }

        function onLoad() {
          finish(true);
        }

        frame.addEventListener("load", onLoad, { once: true });
        frame.src = targetFrameUrl;
      });

      return {
        success: true,
        loaded,
        displayChanged,
        frameSrc: frame.src
      };
    }
  });

  return results && results[0] ? results[0].result : null;
}

async function navigateTargetTab(tabId, targetUrl) {
  const previousTab = await chrome.tabs.get(tabId).catch(() => null);
  if (!previousTab) {
    throw new Error("找不到启动任务时的当前标签页");
  }

  await chrome.tabs.update(tabId, {
    url: targetUrl,
    active: true
  });

  await sleep(300);
  await chrome.tabs.reload(tabId, { bypassCache: true });
  await waitForTabComplete(tabId, 15000);
  await sleep(1200);
  return waitForPrivateFrameInfo(tabId);
}

async function sendPrepareMessage(tabId, task, autoSend) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: "PREPARE_PRIVATE_MESSAGE",
      message: task.message,
      autoSend
    });
  } catch (_error) {
    await ensureContentScript(tabId);
    return chrome.tabs.sendMessage(tabId, {
      type: "PREPARE_PRIVATE_MESSAGE",
      message: task.message,
      autoSend
    });
  }
}

function getResultActionText(response) {
  return response && response.preparedOnly ? "已填入成功" : "已发送成功";
}

function buildSendResultText(targetUrl, response, usedFrame, retriedWithUrl) {
  if (response && response.success) {
    const actionText = getResultActionText(response);
    if (usedFrame && retriedWithUrl) return `iframe 发送失败 · ${targetUrl} ${actionText}`;
    if (usedFrame) return `iframe ${actionText}`;
    return `${targetUrl} ${actionText}`;
  }

  if (usedFrame) return "iframe 发送失败";
  return `${targetUrl} 发送失败`;
}

async function openAndPrepare(task, run) {
  const autoSend = run.autoSend === true;
  const targetUrl = task.chatUrl || Core.buildChatUrl(task.userId || task.userHomepageUrl) || task.userHomepageUrl;
  const tabId = run.targetTabId;

  if (!tabId) {
    return {
      success: false,
      errorMessage: "没有可复用的当前标签页"
    };
  }

  const cachedFrameUrl = await getCachedChatFrameUrl(task);
  let usedCachedFrame = false;
  let retriedWithUrl = false;

  if (cachedFrameUrl) {
    const frameInfo = await getPrivateFrameInfo(tabId).catch(() => null);

    if (frameInfo && frameInfo.success) {
      const switchResult = await switchPrivateFrame(tabId, cachedFrameUrl, targetUrl).catch((error) => ({
        success: false,
        errorMessage: error && error.message ? error.message : "切换私信 iframe 失败"
      }));

      usedCachedFrame = Boolean(switchResult && switchResult.success);
    }
  }

  if (!usedCachedFrame) {
    const frameInfo = await navigateTargetTab(tabId, targetUrl);
    if (frameInfo && frameInfo.frameSrc) {
      await cacheChatFrameUrl(task, frameInfo.frameSrc);
    }
  }

  await ensureContentScript(tabId);

  let response = await prepareMessageInFrames(tabId, task, autoSend);

  if (usedCachedFrame && response && !response.success) {
    retriedWithUrl = true;
    const frameInfo = await navigateTargetTab(tabId, targetUrl);
    if (frameInfo && frameInfo.frameSrc) {
      await cacheChatFrameUrl(task, frameInfo.frameSrc);
    }
    await ensureContentScript(tabId);
    response = await prepareMessageInFrames(tabId, task, autoSend);
  }

  if (response && response.needsNavigation && response.nextUrl) {
    await navigateTargetTab(tabId, response.nextUrl);
    await sleep(1200);
    await ensureContentScript(tabId);
    response = await sendPrepareMessage(tabId, task, autoSend);
  }

  const finalResponse = response || {
    success: false,
    errorMessage: "页面没有返回处理结果"
  };

  return {
    ...finalResponse,
    resultText: buildSendResultText(targetUrl, finalResponse, usedCachedFrame, retriedWithUrl)
  };
}

async function openChatForScan(task, tabId) {
  const targetUrl = task.chatUrl || Core.buildChatUrl(task.userId || task.userHomepageUrl) || task.userHomepageUrl;

  if (!tabId) {
    throw new Error("没有可复用的当前标签页");
  }

  const cachedFrameUrl = await getCachedChatFrameUrl(task);
  let usedCachedFrame = false;
  let frameChatUrl = cachedFrameUrl || "";

  if (cachedFrameUrl) {
    const frameInfo = await getPrivateFrameInfo(tabId).catch(() => null);

    if (frameInfo && frameInfo.success) {
      const switchResult = await switchPrivateFrame(tabId, cachedFrameUrl, targetUrl).catch((error) => ({
        success: false,
        errorMessage: error && error.message ? error.message : "切换私信 iframe 失败"
      }));

      usedCachedFrame = Boolean(switchResult && switchResult.success);
      frameChatUrl = normalizeChatFrameUrl(switchResult && switchResult.frameSrc) || frameChatUrl;
      await sleep(800);
    }
  }

  if (!usedCachedFrame) {
    const frameInfo = await navigateTargetTab(tabId, targetUrl);
    frameChatUrl = normalizeChatFrameUrl(frameInfo && frameInfo.frameSrc) || "";
    if (frameChatUrl) {
      await cacheChatFrameUrl(task, frameChatUrl);
    }
  }

  return {
    targetUrl,
    usedCachedFrame,
    frameChatUrl
  };
}

async function scanChatLinksInFrames(tabId, days) {
  const scanDays = Core.normalizeRecentDays(days, 7);

  await chrome.scripting.executeScript({
    target: {
      tabId,
      allFrames: true
    },
    files: ["core.js"]
  });

  const results = await chrome.scripting.executeScript({
    target: {
      tabId,
      allFrames: true
    },
    args: [scanDays],
    func: async (recentDays) => {
      const CoreInFrame = globalThis.CsdnAssistantCore;

      function sleepInPage(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      function isPrivateMessageContext() {
        return location.hostname === "im.csdn.net"
          && /^\/ichat\/[^/]+/.test(location.pathname);
      }

      function getUniqueLinks(source) {
        return CoreInFrame ? CoreInFrame.extractCsdnArticleLinks(source) : [];
      }

      function parseMessageTimeMs(text) {
        if (CoreInFrame && CoreInFrame.parseCsdnMessageTimeMs) {
          return CoreInFrame.parseCsdnMessageTimeMs(text, new Date());
        }

        const match = String(text || "").match(/\b(?:(\d{4})[-/])?(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})\b/);
        if (!match) return null;

        const now = new Date();
        const parsed = new Date(
          match[1] ? Number(match[1]) : now.getFullYear(),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5])
        );

        if (!match[1] && parsed.getTime() > now.getTime()) {
          parsed.setFullYear(parsed.getFullYear() - 1);
        }

        return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
      }

      function compareDocumentOrder(a, b) {
        if (a === b) return 0;
        const position = a.compareDocumentPosition(b);
        if (position & Node.DOCUMENT_POSITION_FOLLOWING || position & Node.DOCUMENT_POSITION_CONTAINED_BY) return -1;
        if (position & Node.DOCUMENT_POSITION_PRECEDING || position & Node.DOCUMENT_POSITION_CONTAINS) return 1;
        return 0;
      }

      function getTimeNodes() {
        return Array.from(document.querySelectorAll(".pure-text"))
          .filter((node) => parseMessageTimeMs(node.textContent) !== null)
          .sort(compareDocumentOrder);
      }

      function getLinkTextNodes() {
        const root = document.body || document.documentElement;
        if (!root) return [];

        const nodes = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            const text = node.nodeValue || "";
            const parent = node.parentElement;
            if (!parent || parent.closest("script, style, noscript")) {
              return NodeFilter.FILTER_REJECT;
            }

            const timeParent = parent.closest(".pure-text");
            if (timeParent && parseMessageTimeMs(timeParent.textContent) !== null) {
              return NodeFilter.FILTER_REJECT;
            }

            return /https?:\/\/|blog\.csdn\.net|link\.csdn\.net/i.test(text)
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT;
          }
        });

        let current = walker.nextNode();
        while (current) {
          nodes.push(current);
          current = walker.nextNode();
        }

        return nodes;
      }

      function getOrderedScanEvents(timeNodes) {
        return [
          ...timeNodes.map((node) => ({ type: "time", node })),
          ...Array.from(document.querySelectorAll("a[href]")).map((node) => ({ type: "anchor", node })),
          ...getLinkTextNodes().map((node) => ({ type: "text", node }))
        ].sort((a, b) => compareDocumentOrder(a.node, b.node));
      }

      function collectLinksWithTimes(cutoffMs) {
        const links = new Set();
        const timeNodes = getTimeNodes();

        if (!timeNodes.length) {
          const parts = [];
          document.querySelectorAll("a[href]").forEach((anchor) => {
            parts.push(anchor.href);
            parts.push(anchor.textContent || "");
          });

          if (document.body) {
            parts.push(document.body.innerText || "");
            parts.push(document.body.textContent || "");
          }

          getUniqueLinks(parts.join("\n")).forEach((link) => links.add(link));

          return {
            links: Array.from(links),
            recognizedTime: false,
            oldestTimeMs: null
          };
        }

        const orderedEvents = getOrderedScanEvents(timeNodes);
        let currentTimeMs = null;
        let oldestTimeMs = null;

        orderedEvents.forEach((event) => {
          if (event.type === "time") {
            const parsedTime = parseMessageTimeMs(event.node.textContent);
            if (parsedTime !== null) {
              currentTimeMs = parsedTime;
              oldestTimeMs = oldestTimeMs === null ? parsedTime : Math.min(oldestTimeMs, parsedTime);
            }
            return;
          }

          if (currentTimeMs === null || currentTimeMs >= cutoffMs) {
            const source = event.type === "anchor"
              ? `${event.node.href}\n${event.node.textContent || ""}`
              : event.node.nodeValue || "";
            getUniqueLinks(source).forEach((link) => links.add(link));
          }
        });

        return {
          links: Array.from(links),
          recognizedTime: true,
          oldestTimeMs
        };
      }

      function findScrollContainer() {
        const candidates = [
          document.scrollingElement,
          document.documentElement,
          document.body,
          ...Array.from(document.querySelectorAll("main, section, div"))
        ].filter(Boolean);

        return candidates
          .filter((element) => element.scrollHeight > element.clientHeight + 80)
          .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0]
          || null;
      }

      function getContentSignature() {
        const bodyText = document.body ? document.body.innerText || "" : "";
        return `${bodyText.length}:${document.querySelectorAll("a[href]").length}:${document.querySelectorAll(".pure-text").length}`;
      }

      function hasRenderedChatContent() {
        const bodyText = document.body ? document.body.innerText || "" : "";
        const hasMessageTime = Boolean(document.querySelector(".pure-text"));
        const hasMessageInput = Boolean(document.querySelector("textarea, [contenteditable='true'], [role='textbox']"));
        const hasArticleLinkText = /https?:\/\/|blog\.csdn\.net|link\.csdn\.net/i.test(bodyText);
        return hasMessageTime || hasMessageInput || hasArticleLinkText;
      }

      async function waitForChatRender() {
        let lastSignature = "";
        let stableCount = 0;

        for (let index = 0; index < 12; index += 1) {
          const signature = getContentSignature();

          if (hasRenderedChatContent() && signature === lastSignature) {
            stableCount += 1;
          } else {
            stableCount = 0;
          }

          if (stableCount >= 2) return true;

          lastSignature = signature;
          await sleepInPage(500);
        }

        return hasRenderedChatContent();
      }

      async function scrollToOlderMessages() {
        const container = findScrollContainer();
        if (!container) return false;

        if (container === document.scrollingElement || container === document.documentElement || container === document.body) {
          window.scrollTo(0, 0);
          window.dispatchEvent(new Event("scroll", { bubbles: true }));
        } else {
          container.scrollTop = 0;
          container.dispatchEvent(new Event("scroll", { bubbles: true }));
        }

        await sleepInPage(900);
        return true;
      }

      if (!isPrivateMessageContext()) {
        return {
          ignored: true,
          frameUrl: location.href,
          errorMessage: "不是私信 iframe，已跳过"
        };
      }

      await waitForChatRender();

      const cutoffMs = Date.now() - Number(recentDays) * 24 * 60 * 60 * 1000;
      const links = new Set();
      let recognizedTime = false;
      let hitOlderMessage = false;
      let failedToGrowCount = 0;
      let lastSignature = "";

      for (let attempt = 0; attempt < 30; attempt += 1) {
        const collected = collectLinksWithTimes(cutoffMs);
        collected.links.forEach((link) => links.add(link));
        recognizedTime = recognizedTime || collected.recognizedTime;

        if (!collected.recognizedTime) {
          break;
        }

        if (collected.oldestTimeMs !== null && collected.oldestTimeMs < cutoffMs) {
          hitOlderMessage = true;
          break;
        }

        const beforeSignature = getContentSignature();
        const scrolled = await scrollToOlderMessages();
        const afterSignature = getContentSignature();

        if (!scrolled || afterSignature === beforeSignature || afterSignature === lastSignature) {
          failedToGrowCount += 1;
        } else {
          failedToGrowCount = 0;
        }

        lastSignature = afterSignature;

        if (failedToGrowCount >= 3) {
          break;
        }
      }

      return {
        success: true,
        links: Array.from(links),
        frameUrl: location.href,
        recognizedTime,
        hitOlderMessage
      };
    }
  });

  const responses = results.map((item) => item.result).filter(Boolean);
  const actionableResponses = responses.filter((item) => !item.ignored);

  if (!actionableResponses.length) {
    return {
      success: false,
      links: [],
      errorMessage: "没有在私信 iframe 中找到聊天页面"
    };
  }

  const links = Array.from(new Set(actionableResponses.flatMap((item) => item.links || [])));
  const primary = actionableResponses.find((item) => item.success) || actionableResponses[0];

  return {
    ...primary,
    success: Boolean(primary && primary.success),
    links
  };
}

async function scanOneWhitelistChat(payload) {
  const user = payload.user || {};
  const tabId = payload.targetTabId;
  const userId = user.userId || Core.normalizeUserId(user.chatUrl || user.homepageUrl);
  const task = {
    userId,
    userHomepageUrl: user.homepageUrl,
    chatUrl: user.chatUrl || Core.buildChatUrl(userId || user.homepageUrl),
    frameChatUrl: user.frameChatUrl
  };

  const openResult = await openChatForScan(task, tabId);
  let scanResult = await scanChatLinksInFrames(tabId, payload.days);
  let retriedWithUrl = false;

  if (openResult.usedCachedFrame && scanResult && !scanResult.success) {
    retriedWithUrl = true;
    const frameInfo = await navigateTargetTab(tabId, openResult.targetUrl);
    const frameChatUrl = normalizeChatFrameUrl(frameInfo && frameInfo.frameSrc);
    if (frameChatUrl) {
      task.frameChatUrl = frameChatUrl;
      await cacheChatFrameUrl(task, frameChatUrl);
    }
    scanResult = await scanChatLinksInFrames(tabId, payload.days);
  }

  const frameChatUrl = normalizeChatFrameUrl(scanResult && scanResult.frameUrl)
    || openResult.frameChatUrl
    || task.frameChatUrl
    || "";

  if (frameChatUrl) {
    await cacheChatFrameUrl(task, frameChatUrl);
  }

  return {
    ...scanResult,
    userId,
    chatUrl: task.chatUrl,
    frameChatUrl,
    retriedWithUrl
  };
}

async function resolveFrameUrl(payload) {
  const task = payload.task || {};
  const tabId = payload.targetTabId;
  const allowCurrentFrame = payload.allowCurrentFrame === true;
  const targetUrl = task.chatUrl || Core.buildChatUrl(task.userId || task.userHomepageUrl) || task.userHomepageUrl;

  if (!tabId) {
    throw new Error("没有可复用的当前标签页");
  }

  const currentFrameInfo = await waitForPrivateFrameInfo(tabId).catch(() => null);
  if (currentFrameInfo && currentFrameInfo.frameSrc) {
    const currentUserId = Core.normalizeUserId(currentFrameInfo.href);
    const taskUserId = task.userId || Core.normalizeUserId(task.chatUrl || task.userHomepageUrl);
    const currentFrameUrl = normalizeChatFrameUrl(currentFrameInfo.frameSrc);

    if (currentFrameUrl && (allowCurrentFrame || !taskUserId || !currentUserId || String(currentUserId).toLowerCase() === String(taskUserId).toLowerCase())) {
      await cacheChatFrameUrl(task, currentFrameUrl);
      return {
        frameChatUrl: currentFrameUrl,
        source: "current-page"
      };
    }
  }

  const cachedFrameUrl = await getCachedChatFrameUrl(task);
  if (cachedFrameUrl) {
    await cacheChatFrameUrl(task, cachedFrameUrl);
    return {
      frameChatUrl: cachedFrameUrl,
      source: "cache"
    };
  }

  const frameInfo = await navigateTargetTab(tabId, targetUrl);
  if (!frameInfo || !frameInfo.frameSrc) {
    throw new Error("没有从页面中找到私信 iframe");
  }

  const resolvedFrameUrl = normalizeChatFrameUrl(frameInfo.frameSrc);
  if (!resolvedFrameUrl) {
    throw new Error("页面返回的 iframe 地址不是 CSDN 私信 iframe");
  }

  await cacheChatFrameUrl(task, resolvedFrameUrl);

  return {
    frameChatUrl: resolvedFrameUrl,
    source: "resolved"
  };
}

async function updateTargetUserLastSent(task) {
  const result = await storageGet([TARGET_USERS_KEY]);
  const users = Array.isArray(result[TARGET_USERS_KEY]) ? result[TARGET_USERS_KEY] : [];
  const updated = users.map((user) => {
    const sameUser = user.userId === task.userId
      || user.chatUrl === task.chatUrl
      || user.frameChatUrl === task.frameChatUrl
      || user.homepageUrl === task.userHomepageUrl;

    if (!sameUser) return user;

    return {
      ...user,
      lastSentAt: Core.nowIso()
    };
  });
  await storageSet({ [TARGET_USERS_KEY]: updated });
}

async function processQueue() {
  if (processing) return;
  processing = true;

  try {
    let run = await getSendRun();
    if (!run || run.status !== "running") return;

    while (run.currentIndex < run.tasks.length) {
      if (pauseRequested || run.status !== "running") {
        run.status = "paused";
        await saveSendRun(run);
        return;
      }

      const task = {
        ...run.tasks[run.currentIndex],
        status: Core.TASK_STATUS.SENDING
      };

      run.tasks[run.currentIndex] = task;
      await saveSendRun(run);

      const result = await openAndPrepare(task, run);
      const status = result.success ? Core.TASK_STATUS.SUCCESS : Core.TASK_STATUS.FAILED;
      const errorMessage = result.resultText || (result.success ? result.message : result.errorMessage);

      run.tasks[run.currentIndex] = {
        ...task,
        status,
        errorMessage
      };
      run.currentIndex += 1;
      run.updatedAt = Core.nowIso();

      await appendLog(Core.createLogEntry(task, status, errorMessage));

      if (result.success) {
        await updateTargetUserLastSent(task);
      }

      if (!run.autoSend) {
        run.status = "paused";
        await saveSendRun(run);
        return;
      }

      await saveSendRun(run);
      await sleep(Number(run.delayMs || 5000));
      run = await getSendRun();
      if (!run) return;
    }

    run.status = "completed";
    run.completedAt = Core.nowIso();
    await saveSendRun(run);
  } finally {
    processing = false;
  }
}

async function startSendRun(payload) {
  const tasks = Array.isArray(payload.tasks)
    ? payload.tasks.map((task) => ({ ...task, status: Core.TASK_STATUS.PENDING }))
    : [];

  const run = {
    id: String(Date.now()),
    status: "running",
    tasks,
    currentIndex: 0,
    message: String(payload.message || ""),
    autoSend: payload.autoSend === true,
    reviewMode: payload.reviewMode === true,
    targetTabId: payload.targetTabId,
    delayMs: Math.max(3000, Number(payload.delayMs || 5000)),
    startedAt: Core.nowIso(),
    updatedAt: Core.nowIso()
  };

  pauseRequested = false;
  await saveSendRun(run);
  processQueue();
  return run;
}

async function pauseSendRun() {
  pauseRequested = true;
  const run = await getSendRun();
  if (run && run.status === "running") {
    run.status = "paused";
    run.updatedAt = Core.nowIso();
    await saveSendRun(run);
  }
  return run;
}

async function resumeSendRun() {
  const run = await getSendRun();
  if (!run || run.status !== "paused") return run;

  pauseRequested = false;
  run.status = "running";
  run.updatedAt = Core.nowIso();
  await saveSendRun(run);
  processQueue();
  return run;
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (!request || !request.type) return false;

  const handlers = {
    START_SEND_RUN: () => startSendRun(request),
    PAUSE_SEND_RUN: () => pauseSendRun(),
    RESUME_SEND_RUN: () => resumeSendRun(),
    GET_SEND_RUN: () => getSendRun(),
    RESOLVE_FRAME_URL: () => resolveFrameUrl(request),
    SCAN_ONE_WHITELIST_CHAT: () => scanOneWhitelistChat(request)
  };

  const handler = handlers[request.type];
  if (!handler) return false;

  handler()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      sendResponse({
        ok: false,
        errorMessage: error && error.message ? error.message : "后台任务失败"
      });
    });

  return true;
});
