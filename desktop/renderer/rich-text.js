(() => {
  "use strict";

  const FENCED_CODE = /```([^\n`]*)\r?\n([\s\S]*?)```/g;
  const INLINE_CODE = /`([^`\n]+)`/g;

  function appendInlineContent(parent, value) {
    let cursor = 0;
    for (const match of value.matchAll(INLINE_CODE)) {
      const index = match.index ?? 0;
      if (index > cursor) {
        parent.append(document.createTextNode(value.slice(cursor, index)));
      }
      const code = document.createElement("code");
      code.className = "inline-code";
      code.textContent = match[1];
      parent.append(code);
      cursor = index + match[0].length;
    }
    if (cursor < value.length) {
      parent.append(document.createTextNode(value.slice(cursor)));
    }
  }

  function appendProse(parent, value) {
    if (!value) return;
    const prose = document.createElement("span");
    prose.className = "message-prose";
    appendInlineContent(prose, value);
    parent.append(prose);
  }

  function appendCodeBlock(parent, language, value) {
    const block = document.createElement("div");
    block.className = "message-code-block";
    const normalizedLanguage = language.trim().slice(0, 40);
    if (normalizedLanguage) {
      const label = document.createElement("div");
      label.className = "message-code-language";
      label.textContent = normalizedLanguage;
      block.append(label);
    }
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = value;
    pre.append(code);
    block.append(pre);
    parent.append(block);
  }

  function renderAssistantContent(container, value) {
    const content = String(value ?? "");
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of content.matchAll(FENCED_CODE)) {
      const index = match.index ?? 0;
      appendProse(fragment, content.slice(cursor, index));
      appendCodeBlock(fragment, match[1], match[2]);
      cursor = index + match[0].length;
    }
    appendProse(fragment, content.slice(cursor));
    container.replaceChildren(fragment);
  }

  Object.defineProperty(window, "baseAgentRichText", {
    configurable: false,
    enumerable: true,
    value: Object.freeze({ renderAssistantContent }),
    writable: false,
  });
})();
