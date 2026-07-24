"use strict";

(() => {
  const STYLE_ID = "study-entry-delete-styles";

  function runWhenReady(callback) {
    if (document.readyState === "loading") {
      document.addEventListener(
        "DOMContentLoaded",
        callback,
        { once: true }
      );
      return;
    }

    callback();
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .entry-owner-actions {
        display: flex;
        justify-content: flex-end;
        margin-top: 18px;
        padding-top: 14px;
        border-top: 1px solid rgba(78, 65, 53, 0.10);
      }

      .entry-delete-button {
        appearance: none;
        min-height: 38px;
        padding: 0 14px;
        border: 1px solid rgba(145, 73, 64, 0.24);
        border-radius: 999px;
        background: rgba(255, 250, 247, 0.92);
        color: #984f46;
        font: inherit;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
      }

      .entry-delete-button:disabled {
        cursor: wait;
        opacity: 0.55;
      }
    `;
    document.head.appendChild(style);
  }

  function entryLabel(article) {
    return article.querySelector(
      "[data-entry-type]"
    )?.textContent?.trim() || "书房内容";
  }

  function setNotice(article, text, type = "") {
    const status = article.querySelector(
      "[data-comment-form-status]"
    );

    if (!status) {
      return;
    }

    status.textContent = text || "";
    status.hidden = !text;
    status.className =
      `comment-form-status${
        type ? ` is-${type}` : ""
      }`;
  }

  function updatePanelAfterRemoval(article) {
    const panel = article.closest(
      "[data-study-panel]"
    );

    if (!panel) {
      article.remove();
      return;
    }

    article.remove();

    const remaining = panel.querySelectorAll(
      ".study-entry"
    ).length;
    const count = panel.querySelector(
      ".panel-count"
    );
    const tabName =
      panel.dataset.studyPanel ?? "";
    const unit = tabName === "diary"
      ? "篇"
      : tabName === "notes"
        ? "张"
        : "条";

    if (count) {
      count.textContent = `${remaining} ${unit}`;
    }
  }

  async function deleteEntry(article, button) {
    const entryId = String(
      article.dataset.entryId ?? ""
    ).trim();

    if (!entryId) {
      return;
    }

    const label = entryLabel(article);
    const confirmed = window.confirm(
      `确定删除这条${label}吗？删除后无法恢复。`
    );

    if (!confirmed) {
      return;
    }

    const apiFetch = globalThis.studyApiFetch;

    if (typeof apiFetch !== "function") {
      setNotice(
        article,
        "删除接口还没有准备好，请刷新后再试。",
        "error"
      );
      return;
    }

    button.disabled = true;
    button.textContent = "正在删除…";
    setNotice(article, "正在删除…");

    try {
      await apiFetch(
        `/api/text-ledger/items/study_entry/${encodeURIComponent(entryId)}`,
        { method: "DELETE" }
      );

      const panel = article.closest(
        "[data-study-panel]"
      );
      const tabName =
        panel?.dataset.studyPanel ?? null;
      const reload = globalThis.loadTabEntries;

      updatePanelAfterRemoval(article);

      if (
        typeof reload === "function" &&
        tabName
      ) {
        await reload(
          tabName,
          { force: true }
        );
      }
    } catch (error) {
      console.error(
        "Delete study entry failed:",
        error
      );
      button.disabled = false;
      button.textContent = "删除";
      setNotice(
        article,
        error?.message ??
          "删除失败，文字仍然保留。",
        "error"
      );
    }
  }

  function enhanceEntry(article) {
    if (
      !(article instanceof Element) ||
      article.dataset.entryDeleteReady ===
        "true"
    ) {
      return;
    }

    article.dataset.entryDeleteReady = "true";

    const body = article.querySelector(
      "[data-entry-body]"
    );

    if (!body) {
      return;
    }

    const actions = document.createElement("div");
    actions.className = "entry-owner-actions";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "entry-delete-button";
    button.textContent = "删除";
    button.setAttribute(
      "aria-label",
      `删除这条${entryLabel(article)}`
    );

    button.addEventListener(
      "click",
      () => {
        void deleteEntry(article, button);
      }
    );

    actions.appendChild(button);
    body.insertAdjacentElement(
      "afterend",
      actions
    );
  }

  function enhanceWithin(root) {
    if (!(root instanceof Element)) {
      return;
    }

    if (root.matches(".study-entry")) {
      enhanceEntry(root);
    }

    for (
      const article of
      root.querySelectorAll(".study-entry")
    ) {
      enhanceEntry(article);
    }
  }

  function start() {
    injectStyles();
    enhanceWithin(document.body);

    const observer = new MutationObserver(
      (records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node instanceof Element) {
              enhanceWithin(node);
            }
          }
        }
      }
    );

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  runWhenReady(start);
})();
