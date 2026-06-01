(function initContentScript() {
  if (globalThis.__csdnAssistantContentLoaded) return;
  globalThis.__csdnAssistantContentLoaded = true;

  const Core = globalThis.CsdnAssistantCore;

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

  function collectPageText() {
    const parts = [];

    document.querySelectorAll("a[href]").forEach((anchor) => {
      parts.push(anchor.href);
      parts.push(anchor.textContent || "");
    });

    if (document.body) {
      parts.push(document.body.innerText || "");
      parts.push(document.body.textContent || "");
    }

    return parts.join("\n");
  }

  function scanCsdnLinks() {
    const links = Core.extractCsdnArticleLinks(collectPageText());

    return {
      links,
      pageTitle: document.title || "",
      pageUrl: location.href
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function findPrivateMessageElement() {
    const candidates = Array.from(document.querySelectorAll("a, button, [role='button'], div, span"));

    return candidates.find((element) => {
      if (!isVisible(element)) return false;

      const text = (element.textContent || "").replace(/\s+/g, "");
      const href = element instanceof HTMLAnchorElement ? element.href : "";

      return text === "私信"
        || text === "发私信"
        || text === "私聊"
        || href.includes("im.csdn.net");
    });
  }

  function findMessageInput() {
    const textareas = Array.from(document.querySelectorAll("textarea")).filter(isVisible);
    if (textareas.length) return textareas[0];

    const editable = Array.from(document.querySelectorAll("[contenteditable='true'], [role='textbox']")).filter(isVisible);
    if (editable.length) return editable[0];

    const inputs = Array.from(document.querySelectorAll("input[type='text'], input:not([type])")).filter((input) => {
      if (!isVisible(input)) return false;
      const hint = `${input.placeholder || ""} ${input.id || ""} ${input.className || ""}`;
      return /消息|私信|请输入|聊天|message|chat/i.test(hint)
        && !/search|搜索/i.test(hint);
    });

    return inputs[0] || null;
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
      input.textContent = value;
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
      return text === "发送";
    });
  }

  async function waitForSendButton() {
    for (let index = 0; index < 10; index += 1) {
      const button = findSendButton();
      if (button) return button;
      await sleep(300);
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

  async function preparePrivateMessage(payload) {
    const message = String(payload.message || "").trim();
    const autoSend = payload.autoSend === true;

    if (!message) {
      return {
        success: false,
        errorMessage: "消息内容为空"
      };
    }

    let input = findMessageInput();

    if (!input) {
      const trigger = findPrivateMessageElement();

      if (trigger instanceof HTMLAnchorElement && trigger.href) {
        return {
          success: false,
          needsNavigation: true,
          nextUrl: trigger.href,
          errorMessage: "已找到私信入口，准备跳转"
        };
      }

      if (trigger) {
        trigger.click();
        await sleep(1800);
        input = findMessageInput();
      }
    }

    if (!input) {
      return {
        success: false,
        errorMessage: "没有找到可填写的私信输入框"
      };
    }

    setInputValue(input, message);

    if (!autoSend) {
      return {
        success: true,
        preparedOnly: true,
        message: "已填入消息，等待手动点击发送"
      };
    }

    const sendButton = await waitForSendButton();
    if (!sendButton) {
      return {
        success: false,
        errorMessage: "已填入消息，但没有找到发送按钮"
      };
    }

    clickLikeUser(sendButton);
    await sleep(800);

    return {
      success: true,
      preparedOnly: false,
      message: "已点击发送按钮"
    };
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (!request || !request.type) return false;

    if (request.type === "SCAN_CSDN_LINKS") {
      sendResponse(scanCsdnLinks());
      return false;
    }

    if (request.type === "PREPARE_PRIVATE_MESSAGE") {
      preparePrivateMessage(request)
        .then(sendResponse)
        .catch((error) => {
          sendResponse({
            success: false,
            errorMessage: error && error.message ? error.message : "准备私信失败"
          });
        });
      return true;
    }

    return false;
  });
})();
