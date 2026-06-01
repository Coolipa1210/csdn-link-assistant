const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../core.js");

test("extracts and normalizes CSDN article links", () => {
  const input = `
    看这个 https://blog.csdn.net/demo_author_m9k4/article/details/123456?spm=1001&utm_source=x。
    重复链接：https://blog.csdn.net/demo_author_m9k4/article/details/123456
    主页不是文章：https://blog.csdn.net/demo_author_m9k4
  `;

  assert.deepEqual(Core.extractCsdnArticleLinks(input), [
    "https://blog.csdn.net/demo_author_m9k4/article/details/123456"
  ]);
});

test("merges scanned links and increments seen count", () => {
  const first = Core.mergeScannedLinks([], [
    "https://blog.csdn.net/a/article/details/1"
  ], {
    senderName: "第一次",
    now: "2026-01-01T00:00:00.000Z"
  });

  const second = Core.mergeScannedLinks(first, [
    "https://blog.csdn.net/a/article/details/1?spm=abc"
  ], {
    senderName: "第二次",
    now: "2026-01-02T00:00:00.000Z"
  });

  assert.equal(second.length, 1);
  assert.equal(second[0].seenCount, 2);
  assert.equal(second[0].senderName, "第一次");
});

test("records source users when merging scanned chat links", () => {
  const first = Core.mergeScannedLinks([], [
    "https://blog.csdn.net/a/article/details/1"
  ], {
    sourceUserId: "demo_user_a7f3"
  });

  const second = Core.mergeScannedLinks(first, [
    "https://blog.csdn.net/a/article/details/1"
  ], {
    sourceUserId: "demo_user_b8q2"
  });

  const third = Core.mergeScannedLinks(second, [
    "https://blog.csdn.net/a/article/details/1"
  ], {
    sourceUserId: "demo_user_a7f3"
  });

  assert.equal(third[0].sourceUserId, "demo_user_a7f3");
  assert.deepEqual(third[0].sourceUsers, ["demo_user_a7f3", "demo_user_b8q2"]);
  assert.equal(third[0].seenCount, 3);
});

test("parses CSDN message time text with current year", () => {
  const parsed = Core.parseCsdnMessageTimeMs(
    "05-31 18:22",
    new Date(2026, 4, 31, 19, 0, 0)
  );

  assert.equal(parsed, new Date(2026, 4, 31, 18, 22, 0, 0).getTime());
});

test("rolls future month-day message times back one year", () => {
  const parsed = Core.parseCsdnMessageTimeMs(
    "12-31 18:22",
    new Date(2026, 0, 1, 8, 0, 0)
  );

  assert.equal(parsed, new Date(2025, 11, 31, 18, 22, 0, 0).getTime());
});

test("clamps whitelist chat scan days to 1 through 30", () => {
  assert.equal(Core.normalizeRecentDays(0, 7), 1);
  assert.equal(Core.normalizeRecentDays("40", 7), 30);
  assert.equal(Core.normalizeRecentDays("-2", 7), 1);
  assert.equal(Core.normalizeRecentDays("abc", 7), 7);
});

test("exports pending links and marks them exported", () => {
  const items = Core.mergeScannedLinks([], [
    "https://blog.csdn.net/a/article/details/1",
    "https://blog.csdn.net/b/article/details/2"
  ]);

  const output = Core.formatLinksForExport(items, "js");
  assert.match(output, /const csdnLinks =/);
  assert.match(output, /https:\/\/blog\.csdn\.net\/a\/article\/details\/1/);

  const exported = Core.markPendingLinksExported(items);
  assert.equal(exported.every((item) => item.status === Core.LINK_STATUS.EXPORTED), true);
});

test("auto-ignores own CSDN article links", () => {
  const items = Core.mergeScannedLinks([], [
    "https://blog.csdn.net/demo_author_x7p2/article/details/1",
    "https://blog.csdn.net/other_user/article/details/2"
  ], {
    ownAuthorIds: ["demo_author_x7p2"]
  });

  const ownItem = items.find((item) => item.url.includes("/demo_author_x7p2/"));
  const otherItem = items.find((item) => item.url.includes("/other_user/"));

  assert.equal(ownItem.status, Core.LINK_STATUS.IGNORED);
  assert.equal(ownItem.ignoreReason, "我的文章");
  assert.equal(otherItem.status, Core.LINK_STATUS.PENDING);
});

test("imports link lists from text, JSON, and JS array snippets", () => {
  const input = `
    const csdnLinks = [
      "https://blog.csdn.net/a/article/details/1",
      "https://blog.csdn.net/b/article/details/2"
    ];
    ["https://blog.csdn.net/a/article/details/1"]
  `;

  assert.deepEqual(Core.parseImportedLinks(input), [
    "https://blog.csdn.net/a/article/details/1",
    "https://blog.csdn.net/b/article/details/2"
  ]);
});

test("exports selected statuses while excluding own articles", () => {
  let items = Core.mergeScannedLinks([], [
    "https://blog.csdn.net/own_user/article/details/1",
    "https://blog.csdn.net/pending_user/article/details/2",
    "https://blog.csdn.net/exported_user/article/details/3",
    "https://blog.csdn.net/ignored_user/article/details/4"
  ], {
    ownAuthorIds: ["own_user"]
  });

  items = Core.updateLinkStatus(items, "https://blog.csdn.net/exported_user/article/details/3", Core.LINK_STATUS.EXPORTED);
  items = Core.updateLinkStatus(items, "https://blog.csdn.net/ignored_user/article/details/4", Core.LINK_STATUS.IGNORED);

  assert.deepEqual(Core.getExportableLinkUrls(items, {
    statuses: [Core.LINK_STATUS.PENDING, Core.LINK_STATUS.EXPORTED, Core.LINK_STATUS.IGNORED],
    ownAuthorIds: ["own_user"]
  }), [
    "https://blog.csdn.net/pending_user/article/details/2",
    "https://blog.csdn.net/exported_user/article/details/3",
    "https://blog.csdn.net/ignored_user/article/details/4"
  ]);
});

test("keeps own articles ignored when manually set back to pending", () => {
  const items = Core.mergeScannedLinks([], [
    "https://blog.csdn.net/own_user/article/details/1"
  ], {
    ownAuthorIds: ["own_user"]
  });

  const updated = Core.updateLinkStatus(
    items,
    "https://blog.csdn.net/own_user/article/details/1",
    Core.LINK_STATUS.PENDING,
    { ownAuthorIds: ["own_user"] }
  );

  assert.equal(updated[0].status, Core.LINK_STATUS.IGNORED);
  assert.equal(updated[0].ignoreReason, "我的文章");
});

test("parses and deduplicates whitelist homepage entries", () => {
  const parsed = Core.parseTargetUserEntries(`
    ["https://blog.csdn.net/demo_list_a1b2","https://blog.csdn.net/demo_list_c3d4"]
    ["demo_user_a7f3","demo_user_b8q2"]
    https://i.csdn.net/#/msg/chat/demo_direct_e5f6
    https://blog.csdn.net/demo_author_m9k4, 老粉
    https://blog.csdn.net/demo_author_m9k4/article/details/123456
    demo_example_g7h8
  `, "互助组");

  assert.deepEqual(parsed.map((user) => user.userId), [
    "demo_list_a1b2",
    "demo_list_c3d4",
    "demo_direct_e5f6",
    "demo_author_m9k4",
    "demo_user_a7f3",
    "demo_user_b8q2",
    "demo_example_g7h8"
  ]);

  const merged = Core.mergeTargetUsers([], parsed);
  assert.equal(merged.length, 7);
  assert.equal(merged[0].groupName, "互助组");
  assert.equal(merged[0].chatUrl.startsWith("https://i.csdn.net/#/msg/chat/"), true);
});

test("creates send tasks only for enabled users", () => {
  const tasks = Core.createSendTasks([
    {
      userId: "a",
      chatUrl: "https://i.csdn.net/#/msg/chat/a",
      groupName: "g",
      enabled: true
    },
    {
      userId: "b",
      chatUrl: "https://i.csdn.net/#/msg/chat/b",
      groupName: "g",
      enabled: false
    }
  ], "你好");

  assert.deepEqual(tasks, [
    {
      userId: "a",
      userHomepageUrl: undefined,
      chatUrl: "https://i.csdn.net/#/msg/chat/a",
      message: "你好",
      status: Core.TASK_STATUS.PENDING
    }
  ]);
});

test("builds direct chat URLs from user IDs and CSDN URLs", () => {
  assert.equal(Core.normalizeUserId("https://i.csdn.net/#/msg/chat/demo_user_a7f3"), "demo_user_a7f3");
  assert.equal(Core.normalizeUserId("https://i.csdn.net/#/msg/chat/demo_user_c5n9"), "demo_user_c5n9");
  assert.equal(Core.normalizeUserId("https://blog.csdn.net/demo_author_m9k4"), "demo_author_m9k4");
  assert.equal(Core.normalizeUserId("https://im.csdn.net/ichat/T7392048615?mode=frame"), "t7392048615");
  assert.equal(Core.buildChatUrl("demo_user_b8q2"), "https://i.csdn.net/#/msg/chat/demo_user_b8q2");
  assert.equal(Core.buildChatFrameUrl("t7392048615"), "https://im.csdn.net/ichat/T7392048615?mode=frame");
  assert.equal(Core.buildChatFrameUrl("demo_user_a7f3"), null);
  assert.equal(Core.normalizeChatFrameUrl("https://im.csdn.net/ichat/demo_user_a7f3"), "https://im.csdn.net/ichat/demo_user_a7f3?mode=frame");
  assert.equal(Core.normalizeChatFrameUrl("https://im.csdn.net/ichat/t7392048615?mode=frame"), "https://im.csdn.net/ichat/T7392048615?mode=frame");
});

test("preserves explicit iframe URLs when importing whitelist entries", () => {
  const parsed = Core.parseTargetUserEntries("https://im.csdn.net/ichat/demo_user_a7f3?mode=frame", "默认分组");

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].userId, "demo_user_a7f3");
  assert.equal(parsed[0].frameChatUrl, "https://im.csdn.net/ichat/demo_user_a7f3?mode=frame");
});
