const Core = globalThis.CsdnAssistantCore;

const STORAGE_KEYS = {
  links: "linkItems",
  users: "targetUsers",
  groups: "userGroups",
  logs: "sendLogs",
  run: "sendRun",
  activeTab: "activeTab",
  ownAuthorIds: "ownAuthorIds"
};

const state = {
  linkItems: [],
  targetUsers: [],
  userGroups: ["默认分组"],
  sendLogs: [],
  sendRun: null,
  whitelistScanRun: null,
  ownAuthorIds: [],
  activeTab: "links",
  expandedGroups: {
    "默认分组": true
  }
};

function $(selector) {
  return document.querySelector(selector);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getTaskStatusText(status) {
  return {
    pending: "待处理",
    sending: "发送中",
    success: "成功",
    failed: "失败",
    skipped: "已跳过"
  }[status] || status || "";
}

function getSendResultText(item) {
  const savedText = item.errorMessage || "";
  const isFormattedText = /^iframe .+|^https?:\/\/.+/.test(savedText);
  if (savedText && isFormattedText) return savedText;

  if (item.status === Core.TASK_STATUS.SUCCESS) {
    return item.frameChatUrl ? "iframe 已发送成功" : `${item.chatUrl || item.userHomepageUrl || ""} 已发送成功`;
  }
  if (item.status === Core.TASK_STATUS.FAILED) {
    return item.frameChatUrl ? "iframe 发送失败" : `${item.chatUrl || item.userHomepageUrl || ""} 发送失败`;
  }
  if (savedText) return savedText;
  return item.chatUrl || item.userHomepageUrl || "";
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  setTimeout(() => element.classList.remove("show"), 2200);
}

function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

function storageSet(value) {
  return chrome.storage.local.set(value);
}

async function loadState() {
  const result = await storageGet(Object.values(STORAGE_KEYS));
  state.linkItems = Array.isArray(result[STORAGE_KEYS.links]) ? result[STORAGE_KEYS.links] : [];
  state.targetUsers = Array.isArray(result[STORAGE_KEYS.users]) ? result[STORAGE_KEYS.users] : [];
  state.userGroups = normalizeGroups(result[STORAGE_KEYS.groups]);
  state.sendLogs = Array.isArray(result[STORAGE_KEYS.logs]) ? result[STORAGE_KEYS.logs] : [];
  state.sendRun = result[STORAGE_KEYS.run] || null;
  state.ownAuthorIds = Core.parseOwnAuthorIds(result[STORAGE_KEYS.ownAuthorIds] || []);
  state.linkItems = Core.applyOwnArticleIgnores(state.linkItems, state.ownAuthorIds);
  state.activeTab = result[STORAGE_KEYS.activeTab] || "links";
  renderAll();
  setActiveTab(state.activeTab, false);
}

async function saveLinks() {
  state.linkItems = Core.applyOwnArticleIgnores(state.linkItems, state.ownAuthorIds);
  await storageSet({ [STORAGE_KEYS.links]: state.linkItems });
  renderLinks();
}

async function saveOwnAuthorIds() {
  const input = $("#own-author-ids");
  state.ownAuthorIds = Core.parseOwnAuthorIds(input.value);
  state.linkItems = Core.applyOwnArticleIgnores(state.linkItems, state.ownAuthorIds);
  await storageSet({
    [STORAGE_KEYS.ownAuthorIds]: state.ownAuthorIds,
    [STORAGE_KEYS.links]: state.linkItems
  });
  renderLinks();
  toast(`已保存 ${state.ownAuthorIds.length} 个作者 ID`);
}

async function saveUsers() {
  await storageSet({ [STORAGE_KEYS.users]: state.targetUsers });
  renderGroupControls();
  renderUsers();
  renderMessagePanel();
}

async function saveGroups() {
  state.userGroups = normalizeGroups(state.userGroups);
  await storageSet({ [STORAGE_KEYS.groups]: state.userGroups });
  renderGroupControls();
  renderUsers();
  renderMessagePanel();
}

function normalizeGroups(groups) {
  const names = Array.isArray(groups) ? groups : [];
  const derived = Core.getGroups(state.targetUsers);
  return Array.from(new Set(["默认分组", ...names, ...derived]
    .map((group) => String(group || "").trim())
    .filter(Boolean))).sort((a, b) => {
    if (a === "默认分组") return -1;
    if (b === "默认分组") return 1;
    return a.localeCompare(b);
  });
}

function setActiveTab(tabName, shouldSave = true) {
  const targetName = document.querySelector(`[data-tab="${tabName}"]`) ? tabName : "links";

  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === targetName);
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${targetName}`);
  });

  state.activeTab = targetName;

  if (shouldSave) {
    storageSet({ [STORAGE_KEYS.activeTab]: targetName }).catch(() => {});
  }
}

function renderAll() {
  renderLinks();
  renderGroupControls();
  renderUsers();
  renderMessagePanel();
  renderWhitelistScanProgress();
  renderLogs();
}

function renderLinks() {
  const pending = state.linkItems.filter((item) => item.status === Core.LINK_STATUS.PENDING).length;
  const exported = state.linkItems.filter((item) => item.status === Core.LINK_STATUS.EXPORTED).length;
  const ignored = state.linkItems.filter((item) => item.status === Core.LINK_STATUS.IGNORED).length;
  const ownAuthorInput = $("#own-author-ids");

  if (ownAuthorInput && document.activeElement !== ownAuthorInput) {
    ownAuthorInput.value = state.ownAuthorIds.join("\n");
  }

  $("#pending-count").textContent = pending;
  $("#exported-count").textContent = exported;
  $("#ignored-count").textContent = ignored;

  const list = $("#link-list");

  if (!state.linkItems.length) {
    list.innerHTML = "<div class=\"empty\">还没有链接。打开 CSDN 消息页后点击扫描，或手动粘贴文章链接。</div>";
    return;
  }

  list.innerHTML = state.linkItems.map((item) => {
    const statusText = {
      pending: "待处理",
      exported: "已导出",
      ignored: "已忽略"
    }[item.status] || item.status;

    return `
      <article class="item">
        <div class="item-title">${escapeHtml(item.url)}</div>
        <div class="item-subtitle">
          <span class="status ${escapeHtml(item.status)}">${statusText}</span>
          来源次数：${Number(item.seenCount || 1)}
          ${item.senderName ? ` · 来源：${escapeHtml(item.senderName)}` : ""}
          ${Array.isArray(item.sourceUsers) && item.sourceUsers.length ? ` · 来源用户：${escapeHtml(item.sourceUsers.join("、"))}` : ""}
          ${item.ignoreReason ? ` · 原因：${escapeHtml(item.ignoreReason)}` : ""}
        </div>
        <div class="item-actions">
          <button type="button" data-link-action="pending" data-url="${escapeHtml(item.url)}">设为待处理</button>
          <button type="button" data-link-action="ignored" data-url="${escapeHtml(item.url)}">忽略</button>
          <button type="button" data-link-action="remove" data-url="${escapeHtml(item.url)}">删除</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderUsers() {
  const list = $("#user-list");
  state.userGroups = normalizeGroups(state.userGroups);

  if (!state.userGroups.length) {
    list.innerHTML = "<div class=\"empty\">还没有分组。</div>";
    return;
  }

  list.innerHTML = state.userGroups.map((groupName) => {
    const users = state.targetUsers
      .map((user, index) => ({ user, index }))
      .filter(({ user }) => (user.groupName || "默认分组") === groupName);
    const enabledCount = users.filter(({ user }) => user.enabled !== false).length;
    const iframeCount = users.filter(({ user }) => user.frameChatUrl).length;
    const expanded = state.expandedGroups[groupName] !== false;

    return `
      <section class="group-card">
        <button class="group-header" type="button" data-group-action="toggle" data-group="${escapeHtml(groupName)}">
          <span>
            <span class="group-title">${escapeHtml(groupName)}</span>
            <span class="group-meta">${users.length} 人 · 启用 ${enabledCount} · iframe ${iframeCount}</span>
          </span>
          <span>${expanded ? "收起" : "展开"}</span>
        </button>
        ${expanded ? `
          <div class="group-body">
            <div class="group-actions">
              <button type="button" data-group-action="resolve" data-group="${escapeHtml(groupName)}" ${users.length ? "" : "disabled"}>获取本组 iframe</button>
              <button type="button" data-group-action="remove" data-group="${escapeHtml(groupName)}" ${groupName === "默认分组" ? "disabled" : ""}>删除分组</button>
            </div>
            ${users.length ? users.map(({ user, index }) => renderUserItem(user, index)).join("") : "<div class=\"empty\">这个分组还没有用户。</div>"}
          </div>
        ` : ""}
      </section>
    `;
  }).join("");
}

function renderUserItem(user, index) {
  return `
    <article class="item">
      <div class="item-title">${escapeHtml(user.userId || user.homepageUrl)}</div>
      <div class="item-subtitle">
        私信：${escapeHtml(user.chatUrl || "")}
        ${user.frameChatUrl ? ` · iframe：${escapeHtml(user.frameChatUrl)}` : " · iframe：未获取"}
        ${user.note ? ` · 备注：${escapeHtml(user.note)}` : ""}
        ${user.lastSentAt ? ` · 上次处理：${escapeHtml(new Date(user.lastSentAt).toLocaleString())}` : ""}
      </div>
      <div class="item-actions">
        <label class="check-field">
          <input type="checkbox" data-user-action="toggle" data-index="${index}" ${user.enabled !== false ? "checked" : ""}>
          <span>启用</span>
        </label>
        <button type="button" data-user-action="resolve-frame" data-index="${index}">获取 iframe</button>
        <button type="button" data-user-action="remove" data-index="${index}">删除</button>
      </div>
    </article>
  `;
}

function renderGroupControls() {
  state.userGroups = normalizeGroups(state.userGroups);

  const groupSelect = $("#group-name");
  const current = groupSelect.value || "默认分组";
  groupSelect.innerHTML = state.userGroups
    .map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`)
    .join("");
  groupSelect.value = state.userGroups.includes(current) ? current : "默认分组";

  const scanGroupSelect = $("#scan-chat-group");
  if (scanGroupSelect) {
    const scanCurrent = scanGroupSelect.value || groupSelect.value || "默认分组";
    scanGroupSelect.innerHTML = state.userGroups
      .map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`)
      .join("");
    scanGroupSelect.value = state.userGroups.includes(scanCurrent) ? scanCurrent : "默认分组";
  }
}

function renderMessagePanel() {
  const groupSelect = $("#send-group");
  const current = groupSelect.value;
  const groups = normalizeGroups(state.userGroups);

  groupSelect.innerHTML = groups.length
    ? groups.map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`).join("")
    : "<option value=\"\">暂无分组</option>";

  if (groups.includes(current)) {
    groupSelect.value = current;
  }

  renderSendPreview();
  renderSendRun();
}

function renderSendPreview() {
  const groupName = $("#send-group").value;
  const allUsers = Core.getUsersForGroup(state.targetUsers, groupName, true);
  const enabledUsers = Core.getUsersForGroup(state.targetUsers, groupName, false);
  const disabledCount = allUsers.length - enabledUsers.length;
  const message = $("#send-message").value.trim();
  const reviewMode = $("#review-mode").checked;

  $("#send-preview").innerHTML = `
    <strong>发送预览</strong><br>
    分组：${escapeHtml(groupName || "未选择")}<br>
    启用收件人：${enabledUsers.length} 人，跳过：${disabledCount} 人<br>
    模式：${reviewMode ? "审核模式，只填入不自动发送" : "一键发送，尝试自动点击发送"}<br>
    消息字数：${message.length}
  `;
}

function renderSendRun() {
  const container = $("#send-run");
  const run = state.sendRun;

  if (!run) {
    container.innerHTML = "<div class=\"empty\">暂无发送任务。</div>";
    return;
  }

  const done = run.tasks.filter((task) => task.status === Core.TASK_STATUS.SUCCESS).length;
  const failed = run.tasks.filter((task) => task.status === Core.TASK_STATUS.FAILED).length;

  container.innerHTML = `
    <article class="item">
      <div class="item-title">任务状态：${escapeHtml(run.status)}</div>
      <div class="item-subtitle">进度：${run.currentIndex || 0}/${run.tasks.length} · 成功：${done} · 失败：${failed}</div>
    </article>
    ${run.tasks.map((task) => {
      const resultText = getSendResultText(task);
      return `
        <article class="item">
          <div class="item-title">${escapeHtml(task.userId || task.chatUrl || task.userHomepageUrl)}</div>
          <div class="item-subtitle">
            <span class="status ${escapeHtml(task.status)}">${escapeHtml(getTaskStatusText(task.status))}</span>
            ${resultText ? ` · ${escapeHtml(resultText)}` : ""}
          </div>
        </article>
      `;
    }).join("")}
  `;
}

function renderLogs() {
  const list = $("#log-list");

  if (!state.sendLogs.length) {
    list.innerHTML = "<div class=\"empty\">暂无日志。</div>";
    return;
  }

  list.innerHTML = state.sendLogs.map((log) => `
    <article class="item">
      <div class="item-title">${escapeHtml(log.userId || log.chatUrl || log.userHomepageUrl || "")}</div>
      <div class="item-subtitle">
        <span class="status ${escapeHtml(log.status || "")}">${escapeHtml(getTaskStatusText(log.status))}</span>
        ${log.createdAt ? ` · ${escapeHtml(new Date(log.createdAt).toLocaleString())}` : ""}
        ${getSendResultText(log) ? ` · ${escapeHtml(getSendResultText(log))}` : ""}
      </div>
    </article>
  `).join("");
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  return tabs[0];
}

function isCsdnMessageTabUrl(url) {
  return /^https:\/\/i\.csdn\.net\/#\/msg\//.test(url || "")
    || /^https:\/\/im\.csdn\.net\/ichat\//.test(url || "");
}

async function getCsdnMessageTab() {
  const activeTab = await getActiveTab();
  if (activeTab && isCsdnMessageTabUrl(activeTab.url)) {
    return activeTab;
  }

  const messageTabs = await chrome.tabs.query({
    url: [
      "https://i.csdn.net/*",
      "https://im.csdn.net/*"
    ]
  });

  return messageTabs.find((tab) => isCsdnMessageTabUrl(tab.url))
    || activeTab;
}

async function openPersistentPanel() {
  if (!chrome.sidePanel || !chrome.sidePanel.open) {
    toast("当前浏览器不支持扩展侧边栏");
    return;
  }

  const tab = await getActiveTab();
  if (!tab || !tab.windowId) {
    toast("没有找到当前浏览器窗口");
    return;
  }

  await chrome.sidePanel.open({ windowId: tab.windowId });
  toast("已打开持久侧边栏");
}

async function sendMessageToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["core.js", "content.js"]
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function scanAllFrames(tabId) {
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
    func: () => {
      const CoreInFrame = globalThis.CsdnAssistantCore;
      const parts = [];

      document.querySelectorAll("a[href]").forEach((anchor) => {
        parts.push(anchor.href);
        parts.push(anchor.textContent || "");
      });

      if (document.body) {
        parts.push(document.body.innerText || "");
        parts.push(document.body.textContent || "");
      }

      return {
        links: CoreInFrame ? CoreInFrame.extractCsdnArticleLinks(parts.join("\n")) : [],
        pageTitle: document.title || "",
        pageUrl: location.href
      };
    }
  });

  const frameResults = results.map((item) => item.result).filter(Boolean);
  const links = Array.from(new Set(frameResults.flatMap((item) => item.links || [])));
  const pageTitle = frameResults.find((item) => item.pageTitle)?.pageTitle || "";

  return {
    links,
    pageTitle
  };
}

async function scanCurrentPage() {
  const tab = await getActiveTab();
  if (!tab || !tab.id || !/^https:\/\/.*csdn\.net\//.test(tab.url || "")) {
    toast("请先打开 CSDN 页面再扫描");
    return;
  }

  let result;
  try {
    result = await scanAllFrames(tab.id);
  } catch (_error) {
    result = await sendMessageToTab(tab.id, { type: "SCAN_CSDN_LINKS" });
  }

  const links = Array.isArray(result.links) ? result.links : [];
  state.linkItems = Core.mergeScannedLinks(state.linkItems, links, {
    senderName: result.pageTitle || "当前页面",
    ownAuthorIds: state.ownAuthorIds
  });
  await saveLinks();
  toast(`扫描完成，发现 ${links.length} 个文章链接`);
}

function getWhitelistScanDays() {
  const input = $("#scan-chat-days");
  const days = Core.normalizeRecentDays(input.value, 7);
  input.value = String(days);
  return days;
}

function renderWhitelistScanProgress() {
  const container = $("#whitelist-scan-progress");
  if (!container) return;

  const run = state.whitelistScanRun;
  if (!run) {
    container.innerHTML = "选择一个白名单分组后，可扫描最近 1-30 天私信里的 CSDN 文章链接。";
    return;
  }

  const failures = run.failures || [];
  const failureText = failures.length
    ? `<br>失败用户：${failures.slice(0, 5).map((item) => escapeHtml(item.userId)).join("、")}${failures.length > 5 ? " 等" : ""}`
    : "";

  container.innerHTML = `
    <strong>扫描状态：${escapeHtml(run.statusText)}</strong><br>
    分组：${escapeHtml(run.groupName)} · 最近 ${run.days} 天<br>
    进度：${run.currentIndex}/${run.total} · 当前：${escapeHtml(run.currentUserId || "无")}<br>
    成功：${run.successCount} · 失败：${failures.length} · 发现链接：${run.foundCount}
    ${failureText}
  `;
}

async function scanWhitelistChats() {
  const groupName = $("#scan-chat-group").value;
  const days = getWhitelistScanDays();
  const targets = state.targetUsers
    .map((user, index) => ({ user, index }))
    .filter(({ user }) => (user.groupName || "默认分组") === groupName && user.enabled !== false);

  if (!groupName) {
    toast("请先选择白名单分组");
    return;
  }

  if (!targets.length) {
    toast("当前分组没有启用的白名单用户");
    return;
  }

  const tab = await getActiveTab();
  if (!tab || !tab.id || !/^https?:\/\//.test(tab.url || "")) {
    toast("请先打开一个普通网页标签页，再扫描白名单对话");
    return;
  }

  const confirmed = confirm(`即将扫描 ${targets.length} 个白名单用户最近 ${days} 天的私信链接。\n系统会复用当前标签页并切换会话，确认继续吗？`);
  if (!confirmed) return;

  const button = $("#scan-whitelist-chats");
  button.disabled = true;
  state.whitelistScanRun = {
    statusText: "扫描中",
    groupName,
    days,
    total: targets.length,
    currentIndex: 0,
    currentUserId: "",
    successCount: 0,
    foundCount: 0,
    failures: []
  };
  renderWhitelistScanProgress();

  try {
    for (const target of targets) {
      const userId = target.user.userId || Core.normalizeUserId(target.user.chatUrl || target.user.homepageUrl) || "未知用户";
      state.whitelistScanRun.currentIndex += 1;
      state.whitelistScanRun.currentUserId = userId;
      renderWhitelistScanProgress();

      try {
        const response = await chrome.runtime.sendMessage({
          type: "SCAN_ONE_WHITELIST_CHAT",
          user: target.user,
          days,
          targetTabId: tab.id
        });

        if (!response || !response.ok || !response.result || response.result.success === false) {
          throw new Error(response && response.errorMessage
            ? response.errorMessage
            : (response && response.result && response.result.errorMessage) || "扫描失败");
        }

        const result = response.result;
        const links = Array.isArray(result.links) ? result.links : [];
        state.linkItems = Core.mergeScannedLinks(state.linkItems, links, {
          senderName: `白名单：${userId}`,
          sourceUserId: userId,
          ownAuthorIds: state.ownAuthorIds
        });

        if (result.frameChatUrl) {
          state.targetUsers[target.index] = {
            ...state.targetUsers[target.index],
            frameChatUrl: result.frameChatUrl,
            chatUrl: state.targetUsers[target.index].chatUrl || result.chatUrl
          };
        }

        state.whitelistScanRun.successCount += 1;
        state.whitelistScanRun.foundCount += links.length;
        await storageSet({
          [STORAGE_KEYS.links]: Core.applyOwnArticleIgnores(state.linkItems, state.ownAuthorIds),
          [STORAGE_KEYS.users]: state.targetUsers
        });
        renderLinks();
        renderUsers();
        renderWhitelistScanProgress();
      } catch (error) {
        state.whitelistScanRun.failures.push({
          userId,
          errorMessage: error && error.message ? error.message : "扫描失败"
        });
        renderWhitelistScanProgress();
      }
    }

    state.whitelistScanRun.statusText = "已完成";
    state.whitelistScanRun.currentUserId = "";
    renderWhitelistScanProgress();
    toast(`白名单扫描完成，发现 ${state.whitelistScanRun.foundCount} 个链接`);
  } finally {
    button.disabled = false;
  }
}

async function addManualLinks() {
  const input = $("#manual-links");
  const links = Core.extractCsdnArticleLinks(input.value);
  state.linkItems = Core.mergeScannedLinks(state.linkItems, links, {
    senderName: "手动添加",
    ownAuthorIds: state.ownAuthorIds
  });
  input.value = "";
  await saveLinks();
  toast(`已添加 ${links.length} 个链接`);
}

async function importLinks() {
  const input = $("#import-links");
  const links = Core.parseImportedLinks(input.value);

  if (!links.length) {
    toast("没有识别到有效文章链接");
    return;
  }

  state.linkItems = Core.mergeScannedLinks(state.linkItems, links, {
    senderName: "导入链接",
    ownAuthorIds: state.ownAuthorIds
  });
  input.value = "";
  await saveLinks();
  toast(`已导入 ${links.length} 个链接`);
}

function getSelectedExportStatuses() {
  const statuses = [];
  if ($("#export-pending").checked) statuses.push(Core.LINK_STATUS.PENDING);
  if ($("#export-exported").checked) statuses.push(Core.LINK_STATUS.EXPORTED);
  if ($("#export-ignored").checked) statuses.push(Core.LINK_STATUS.IGNORED);
  return statuses;
}

async function exportLinks(format) {
  const statuses = getSelectedExportStatuses();
  const options = {
    statuses,
    ownAuthorIds: state.ownAuthorIds
  };
  const urls = Core.getExportableLinkUrls(state.linkItems, options);

  if (!statuses.length) {
    toast("请至少选择一种导出状态");
    return;
  }

  if (!urls.length) {
    toast("没有符合条件的链接可导出");
    return;
  }

  const output = Core.formatLinksForExport(state.linkItems, format, options);
  await navigator.clipboard.writeText(output);
  state.linkItems = Core.markPendingLinksExported(state.linkItems, options);
  await saveLinks();
  toast(format === "json" ? "JSON 已复制" : "JS 数组已复制");
}

async function addUsersToWhitelist(text, groupName) {
  const users = Core.parseTargetUserEntries(text, groupName);
  if (!users.length) return 0;

  state.targetUsers = Core.mergeTargetUsers(state.targetUsers, users);
  state.userGroups = normalizeGroups([...state.userGroups, groupName]);
  state.expandedGroups[groupName] = true;
  await saveGroups();
  await saveUsers();
  return users.length;
}

async function importUsers() {
  const input = $("#user-import");
  const groupName = $("#group-name").value || "默认分组";
  const count = await addUsersToWhitelist(input.value, groupName);

  if (!count) {
    toast("没有识别到有效用户ID或私信链接");
    return;
  }

  input.value = "";
  toast(`已导入/更新 ${count} 个白名单用户`);
}

async function importUsersFromTxt(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  if (!file) return;

  try {
    const groupName = $("#group-name").value || "默认分组";
    const text = await file.text();
    const count = await addUsersToWhitelist(text, groupName);

    if (!count) {
      toast("TXT 中没有识别到有效用户ID");
      return;
    }

    toast(`已从 TXT 导入/更新 ${count} 个白名单用户`);
  } catch (_error) {
    toast("读取 TXT 失败，请确认文件是文本格式");
  } finally {
    input.value = "";
  }
}

async function exportUsersToTxt() {
  const groupName = $("#group-name").value || "默认分组";
  const userIds = state.targetUsers
    .filter((user) => (user.groupName || "默认分组") === groupName)
    .map((user) => user.userId || Core.normalizeUserId(user.chatUrl || user.homepageUrl))
    .filter(Boolean);

  if (!userIds.length) {
    toast("当前分组没有可导出的白名单用户");
    return;
  }

  await navigator.clipboard.writeText(userIds.join("\n"));
  toast(`已复制 ${userIds.length} 个用户ID，可粘贴保存为 TXT`);
}

async function addCurrentChatUser() {
  const tab = await getActiveTab();
  const url = tab && tab.url ? tab.url : "";

  if (!/^https:\/\/i\.csdn\.net\/#\/msg\/chat\/[^/?#&]+/.test(url)) {
    toast("请先切到 CSDN 私信对话页");
    return;
  }

  const userId = Core.normalizeUserId(url);
  if (!userId) {
    toast("没有从当前私信页识别到用户ID");
    return;
  }

  const groupName = $("#group-name").value || "默认分组";
  const count = await addUsersToWhitelist(userId, groupName);
  if (!count) {
    toast("添加当前私信用户失败");
    return;
  }

  toast(`已添加当前私信用户：${userId}`);
}

async function addGroup() {
  const input = $("#new-group-name");
  const groupName = input.value.trim();
  if (!groupName) {
    toast("请输入分组名");
    return;
  }

  state.userGroups = normalizeGroups([...state.userGroups, groupName]);
  state.expandedGroups[groupName] = true;
  input.value = "";
  await saveGroups();
  $("#group-name").value = groupName;
  toast(`已新建分组：${groupName}`);
}

async function resolveFrameForUser(index, options = {}) {
  const user = state.targetUsers[index];
  if (!user) return false;

  const tab = await getCsdnMessageTab();
  if (!tab || !tab.id || !/^https?:\/\//.test(tab.url || "")) {
    toast("请先打开一个普通网页标签页，再获取 iframe");
    return false;
  }

  const response = await chrome.runtime.sendMessage({
    type: "RESOLVE_FRAME_URL",
    task: {
      userId: user.userId || Core.normalizeUserId(user.chatUrl || user.homepageUrl),
      userHomepageUrl: user.homepageUrl,
      chatUrl: user.chatUrl || Core.buildChatUrl(user.userId || user.homepageUrl),
      frameChatUrl: user.frameChatUrl,
      message: "__resolve__",
      status: Core.TASK_STATUS.PENDING
    },
    targetTabId: tab.id,
    allowCurrentFrame: options.allowCurrentFrame === true
  });

  if (!response || !response.ok || !response.result || !response.result.frameChatUrl) {
    console.warn("CSDN助手 获取 iframe 失败", response);
    toast(response && response.errorMessage ? response.errorMessage : "获取 iframe 失败：后台没有返回 iframe 地址");
    return false;
  }

  state.targetUsers[index] = {
    ...user,
    chatUrl: user.chatUrl || Core.buildChatUrl(user.userId),
    frameChatUrl: response.result.frameChatUrl
  };

  await saveUsers();
  return true;
}

async function resolveFrameForGroup(groupName) {
  const targets = state.targetUsers
    .map((user, index) => ({ user, index }))
    .filter(({ user }) => (user.groupName || "默认分组") === groupName);

  if (!targets.length) {
    toast("这个分组没有用户");
    return;
  }

  let successCount = 0;
  for (const target of targets) {
    const ok = await resolveFrameForUser(target.index, { allowCurrentFrame: false });
    if (ok) successCount += 1;
  }

  toast(`本组 iframe 获取完成：${successCount}/${targets.length}`);
}

async function startSendRun(tasks) {
  const message = $("#send-message").value.trim();
  const delayMs = Math.max(3, Number($("#send-delay").value || 6)) * 1000;
  const reviewMode = $("#review-mode").checked;
  const autoSend = !reviewMode;
  const targetTab = await getActiveTab();

  if (!targetTab || !targetTab.id || !/^https?:\/\//.test(targetTab.url || "")) {
    toast("请先打开一个普通网页标签页，再启动私信任务");
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "START_SEND_RUN",
    tasks,
    message,
    delayMs,
    autoSend,
    reviewMode,
    targetTabId: targetTab.id
  });

  if (!response || !response.ok) {
    toast(response && response.errorMessage ? response.errorMessage : "启动任务失败");
    return;
  }

  state.sendRun = response.result;
  renderSendRun();
  toast(autoSend ? "一键发送任务已启动" : "审核模式已启动，处理后可继续");
}

async function startSendFromPreview() {
  const groupName = $("#send-group").value;
  const message = $("#send-message").value.trim();

  if (!groupName) {
    toast("请先导入白名单分组");
    return;
  }

  if (!message) {
    toast("请先填写私信内容");
    return;
  }

  const users = Core.getUsersForGroup(state.targetUsers, groupName, false);
  const tasks = Core.createSendTasks(users, message);

  if (!tasks.length) {
    toast("当前分组没有启用的收件人");
    return;
  }

  const reviewMode = $("#review-mode").checked;
  const confirmed = confirm(`即将处理 ${tasks.length} 个白名单用户。\n系统会复用当前标签页；能直接切换 iframe 时不刷新，必要时才刷新兜底。\n${reviewMode ? "审核模式：只填入消息，需要你手动发送。" : "一键发送：将尝试自动点击发送按钮。"}\n确认继续吗？`);
  if (!confirmed) return;

  await startSendRun(tasks);
}

async function pauseSendRun() {
  const response = await chrome.runtime.sendMessage({ type: "PAUSE_SEND_RUN" });
  if (!response || !response.ok) {
    toast("暂停失败");
    return;
  }

  state.sendRun = response.result;
  renderSendRun();
  toast("已暂停");
}

async function resumeSendRun() {
  const response = await chrome.runtime.sendMessage({ type: "RESUME_SEND_RUN" });
  if (!response || !response.ok) {
    toast("继续失败");
    return;
  }

  state.sendRun = response.result;
  renderSendRun();
  toast("已继续");
}

async function retryFailed() {
  const run = state.sendRun;
  if (!run) {
    toast("没有可重试的任务");
    return;
  }

  const tasks = run.tasks
    .filter((task) => task.status === Core.TASK_STATUS.FAILED)
    .map((task) => ({ ...task, status: Core.TASK_STATUS.PENDING }));

  if (!tasks.length) {
    toast("没有失败任务");
    return;
  }

  await startSendRun(tasks);
}

async function clearLocalData() {
  const confirmed = confirm("确认清空链接、白名单、任务和日志吗？这个操作只会清空插件本地数据。");
  if (!confirmed) return;

  await chrome.storage.local.clear();
  state.linkItems = [];
  state.targetUsers = [];
  state.sendLogs = [];
  state.sendRun = null;
  state.ownAuthorIds = [];
  state.activeTab = "links";
  renderAll();
  setActiveTab("links", false);
  toast("本地数据已清空");
}

function bindEvents() {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => setActiveTab(button.dataset.tab));
  });

  $("#open-side-panel").addEventListener("click", openPersistentPanel);
  $("#scan-page").addEventListener("click", scanCurrentPage);
  $("#scan-whitelist-chats").addEventListener("click", scanWhitelistChats);
  $("#save-own-author-ids").addEventListener("click", saveOwnAuthorIds);
  $("#import-links-button").addEventListener("click", importLinks);
  $("#add-manual-links").addEventListener("click", addManualLinks);
  $("#export-js").addEventListener("click", () => exportLinks("js"));
  $("#export-json").addEventListener("click", () => exportLinks("json"));
  $("#clear-exported").addEventListener("click", async () => {
    state.linkItems = Core.clearExportedLinks(state.linkItems);
    await saveLinks();
    toast("已清空已导出链接");
  });
  $("#clear-all-links").addEventListener("click", async () => {
    if (!state.linkItems.length) {
      toast("当前没有链接可删除");
      return;
    }

    const confirmed = confirm("确认删除全部链接记录吗？白名单、私信任务和日志不会被删除。");
    if (!confirmed) return;

    state.linkItems = [];
    await saveLinks();
    toast("已删除全部链接");
  });

  $("#link-list").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-link-action]");
    if (!button) return;

    const action = button.dataset.linkAction;
    const url = button.dataset.url;

    if (action === "remove") {
      state.linkItems = Core.removeLink(state.linkItems, url);
    } else {
      state.linkItems = Core.updateLinkStatus(state.linkItems, url, action, {
        ownAuthorIds: state.ownAuthorIds
      });
    }

    await saveLinks();
  });

  $("#import-users").addEventListener("click", importUsers);
  $("#user-file-import").addEventListener("change", importUsersFromTxt);
  $("#export-users-txt").addEventListener("click", exportUsersToTxt);
  $("#add-current-chat-user").addEventListener("click", addCurrentChatUser);
  $("#add-group").addEventListener("click", addGroup);

  $("#user-list").addEventListener("click", async (event) => {
    const groupTarget = event.target.closest("[data-group-action]");
    if (groupTarget) {
      const groupName = groupTarget.dataset.group;
      const action = groupTarget.dataset.groupAction;

      if (action === "toggle") {
        state.expandedGroups[groupName] = state.expandedGroups[groupName] === false;
        renderUsers();
        return;
      }

      if (action === "resolve") {
        await resolveFrameForGroup(groupName);
        return;
      }

      if (action === "remove") {
        state.userGroups = state.userGroups.filter((group) => group !== groupName);
        state.targetUsers = state.targetUsers.map((user) => {
          if ((user.groupName || "默认分组") !== groupName) return user;
          return { ...user, groupName: "默认分组" };
        });
        await saveGroups();
        await saveUsers();
        toast("已删除分组，用户已移到默认分组");
        return;
      }
    }

    const target = event.target.closest("[data-user-action]");
    if (!target) return;

    const index = Number(target.dataset.index);
    const action = target.dataset.userAction;

    if (action === "toggle") {
      state.targetUsers[index].enabled = target.checked;
    }

    if (action === "resolve-frame") {
      await resolveFrameForUser(index, { allowCurrentFrame: true });
      return;
    }

    if (action === "remove") {
      state.targetUsers.splice(index, 1);
    }

    await saveUsers();
  });

  $("#send-group").addEventListener("change", renderSendPreview);
  $("#send-message").addEventListener("input", renderSendPreview);
  $("#review-mode").addEventListener("change", renderSendPreview);
  $("#start-send").addEventListener("click", startSendFromPreview);
  $("#pause-send").addEventListener("click", pauseSendRun);
  $("#resume-send").addEventListener("click", resumeSendRun);
  $("#retry-failed").addEventListener("click", retryFailed);
  $("#clear-local-data").addEventListener("click", clearLocalData);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    if (changes[STORAGE_KEYS.run]) {
      state.sendRun = changes[STORAGE_KEYS.run].newValue || null;
      renderSendRun();
    }

    if (changes[STORAGE_KEYS.logs]) {
      state.sendLogs = Array.isArray(changes[STORAGE_KEYS.logs].newValue)
        ? changes[STORAGE_KEYS.logs].newValue
        : [];
      renderLogs();
    }

    if (changes[STORAGE_KEYS.ownAuthorIds]) {
      state.ownAuthorIds = Core.parseOwnAuthorIds(changes[STORAGE_KEYS.ownAuthorIds].newValue || []);
      state.linkItems = Core.applyOwnArticleIgnores(state.linkItems, state.ownAuthorIds);
      renderLinks();
    }

    if (changes[STORAGE_KEYS.users]) {
      state.targetUsers = Array.isArray(changes[STORAGE_KEYS.users].newValue)
        ? changes[STORAGE_KEYS.users].newValue
        : [];
      renderGroupControls();
      renderUsers();
      renderMessagePanel();
    }
  });
}

bindEvents();
loadState();
