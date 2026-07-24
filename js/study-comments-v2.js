"use strict";

(() => {
  const LONG_PRESS_MS = 650;
  const MOVE_TOLERANCE_PX = 12;
  const MAX_INPUT_HEIGHT_PX = 120;


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


  function setEntryNotice(
    article,
    text,
    type = ""
  ) {
    const status = article?.querySelector(
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


  function formatEntryBody(article) {
    const body = article.querySelector(
      "[data-entry-body]"
    );

    if (
      !body ||
      body.dataset.paragraphsReady === "true"
    ) {
      return;
    }

    body.dataset.paragraphsReady = "true";

    const rawText = String(
      body.textContent ?? ""
    ).trim();

    if (!rawText) {
      return;
    }

    const paragraphs = rawText
      .split(/\n\s*\n+/)
      .map((paragraph) =>
        paragraph.trim()
      )
      .filter(Boolean);

    body.textContent = "";

    for (const paragraph of paragraphs) {
      const element =
        document.createElement("p");

      element.textContent = paragraph;
      body.appendChild(element);
    }
  }


  function resizeCommentInput(input) {
    input.style.height = "auto";

    const nextHeight = Math.min(
      Math.max(input.scrollHeight, 40),
      MAX_INPUT_HEIGHT_PX
    );

    input.style.height = `${nextHeight}px`;
  }


  function enhanceCommentComposer(article) {
    const input = article.querySelector(
      "[data-comment-input]"
    );
    const replyContext = article.querySelector(
      "[data-comment-reply-context]"
    );
    const cancelReply = article.querySelector(
      "[data-comment-cancel-reply]"
    );

    if (
      input &&
      input.dataset.compactReady !== "true"
    ) {
      input.dataset.compactReady = "true";
      input.rows = 1;

      if (input.placeholder === "写下评论") {
        input.placeholder = "写评论…";
      }

      input.addEventListener("input", () => {
        resizeCommentInput(input);
      });

      resizeCommentInput(input);
    }

    if (
      replyContext &&
      cancelReply &&
      replyContext.dataset.cancelReady !== "true"
    ) {
      replyContext.dataset.cancelReady = "true";
      replyContext.tabIndex = 0;
      replyContext.setAttribute("role", "button");
      replyContext.setAttribute(
        "aria-label",
        "取消当前回复"
      );
      replyContext.title = "轻点取消回复";

      const clearReply = () => {
        cancelReply.click();

        if (input) {
          input.placeholder = "写评论…";
          resizeCommentInput(input);
        }
      };

      replyContext.addEventListener(
        "click",
        clearReply
      );

      replyContext.addEventListener(
        "keydown",
        (event) => {
          if (
            event.key !== "Enter" &&
            event.key !== " "
          ) {
            return;
          }

          event.preventDefault();
          clearReply();
        }
      );
    }
  }


  function getDirectCommentAuthor(item) {
    return item.querySelector(
      ":scope > .comment-header [data-comment-author]"
    )?.textContent?.trim() ?? "";
  }


  function getCommentTimestamp(item) {
    const value = item.querySelector(
      ":scope > .comment-header time"
    )?.dateTime;
    const timestamp = new Date(
      value || 0
    ).getTime();

    return Number.isFinite(timestamp)
      ? timestamp
      : 0;
  }


  function addReplyReference(
    item,
    parentAuthor
  ) {
    const existing = item.querySelector(
      ":scope > .comment-reply-reference"
    );

    if (!parentAuthor) {
      existing?.remove();
      return;
    }

    const reference = existing ??
      document.createElement("p");

    reference.className =
      "comment-reply-reference";
    reference.textContent =
      `回复 ${parentAuthor}`;

    if (!existing) {
      const body = item.querySelector(
        ":scope > [data-comment-body]"
      );

      item.insertBefore(
        reference,
        body ?? null
      );
    }
  }


  async function deleteComment(item) {
    const commentId = String(
      item.dataset.commentId ?? ""
    ).trim();
    const article = item.closest(
      ".study-entry"
    );
    const entryId = String(
      article?.dataset.entryId ?? ""
    ).trim();

    if (!commentId || !article || !entryId) {
      return;
    }

    const confirmed = window.confirm(
      "删除这条评论吗？它下面的回复也会一起清掉。"
    );

    if (!confirmed) {
      return;
    }

    const apiFetch =
      globalThis.studyApiFetch;

    if (typeof apiFetch !== "function") {
      setEntryNotice(
        article,
        "删除接口还没有准备好，请刷新后再试。",
        "error"
      );
      return;
    }

    item.classList.add("is-deleting");
    setEntryNotice(article, "正在删除…");

    try {
      const result = await apiFetch(
        `/api/study/comments/${encodeURIComponent(commentId)}`,
        {
          method: "DELETE"
        }
      );

      const refreshEntry =
        globalThis.refreshEntryArticle;

      if (typeof refreshEntry === "function") {
        await refreshEntry(
          entryId,
          article
        );
        return;
      }

      const deletedIds = new Set(
        Array.isArray(result?.deletedIds)
          ? result.deletedIds
          : [commentId]
      );

      for (
        const candidate of
        article.querySelectorAll(
          "[data-comment-id]"
        )
      ) {
        if (
          deletedIds.has(
            candidate.dataset.commentId
          )
        ) {
          candidate.remove();
        }
      }

      const remaining =
        article.querySelectorAll(
          "[data-comment-id]"
        ).length;
      const count = article.querySelector(
        "[data-comment-count]"
      );

      if (count) {
        count.textContent = String(remaining);
      }

      setEntryNotice(
        article,
        "评论已经删除。",
        "success"
      );
    } catch (error) {
      console.error(
        "Delete study comment failed:",
        error
      );

      item.classList.remove("is-deleting");
      setEntryNotice(
        article,
        error?.message ??
          "评论删除失败，内容仍然保留。",
        "error"
      );
    }
  }


  function bindLongPress(item) {
    if (
      item.dataset.longPressDeleteReady ===
      "true"
    ) {
      return;
    }

    item.dataset.longPressDeleteReady =
      "true";

    let timer = null;
    let startX = 0;
    let startY = 0;
    let activePointerId = null;

    const clearPress = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      activePointerId = null;
      item.classList.remove(
        "is-long-pressing"
      );
    };

    const beginPress = (
      clientX,
      clientY,
      pointerId = null
    ) => {
      clearPress();
      startX = clientX;
      startY = clientY;
      activePointerId = pointerId;
      item.classList.add(
        "is-long-pressing"
      );

      timer = setTimeout(() => {
        timer = null;
        item.classList.remove(
          "is-long-pressing"
        );
        globalThis.navigator?.vibrate?.(18);
        void deleteComment(item);
      }, LONG_PRESS_MS);
    };

    const movePress = (
      clientX,
      clientY,
      pointerId = null
    ) => {
      if (
        activePointerId !== null &&
        pointerId !== null &&
        activePointerId !== pointerId
      ) {
        return;
      }

      const moved = Math.hypot(
        clientX - startX,
        clientY - startY
      );

      if (moved > MOVE_TOLERANCE_PX) {
        clearPress();
      }
    };

    const isInteractiveTarget = (target) =>
      target instanceof Element &&
      Boolean(
        target.closest(
          "button, a, textarea, input, label"
        )
      );

    if (globalThis.PointerEvent) {
      item.addEventListener(
        "pointerdown",
        (event) => {
          if (
            event.button !== 0 ||
            isInteractiveTarget(event.target)
          ) {
            return;
          }

          beginPress(
            event.clientX,
            event.clientY,
            event.pointerId
          );
        }
      );

      item.addEventListener(
        "pointermove",
        (event) => {
          movePress(
            event.clientX,
            event.clientY,
            event.pointerId
          );
        }
      );

      item.addEventListener(
        "pointerup",
        clearPress
      );
      item.addEventListener(
        "pointercancel",
        clearPress
      );
      item.addEventListener(
        "pointerleave",
        clearPress
      );
    } else {
      item.addEventListener(
        "touchstart",
        (event) => {
          if (
            isInteractiveTarget(event.target) ||
            event.touches.length !== 1
          ) {
            return;
          }

          const touch = event.touches[0];

          beginPress(
            touch.clientX,
            touch.clientY
          );
        },
        { passive: true }
      );

      item.addEventListener(
        "touchmove",
        (event) => {
          const touch = event.touches[0];

          if (touch) {
            movePress(
              touch.clientX,
              touch.clientY
            );
          }
        },
        { passive: true }
      );

      item.addEventListener(
        "touchend",
        clearPress
      );
      item.addEventListener(
        "touchcancel",
        clearPress
      );
    }

    item.addEventListener(
      "contextmenu",
      (event) => {
        if (
          item.classList.contains(
            "is-long-pressing"
          )
        ) {
          event.preventDefault();
        }
      }
    );
  }


  function addLongPressHint(article) {
    const comments = article.querySelectorAll(
      "[data-comment-id]"
    );
    const heading = article.querySelector(
      ".comments-heading"
    );

    if (!heading) {
      return;
    }

    let hint = heading.querySelector(
      ".comment-long-press-hint"
    );

    if (!comments.length) {
      hint?.remove();
      return;
    }

    if (!hint) {
      hint = document.createElement("span");
      hint.className =
        "comment-long-press-hint";
      heading.appendChild(hint);
    }

    hint.textContent = "长按评论可删除";
  }


  function flattenComments(article) {
    const list = article.querySelector(
      "[data-comment-list]"
    );

    if (!list) {
      return;
    }

    const items = Array.from(
      list.querySelectorAll(
        ".comment-item[data-comment-id]"
      )
    );

    if (!items.length) {
      addLongPressHint(article);
      return;
    }

    const alreadyFlat = items.every(
      (item) =>
        item.parentElement === list &&
        item.dataset.flatCommentReady ===
          "true"
    );

    if (alreadyFlat) {
      addLongPressHint(article);
      return;
    }

    const records = items.map(
      (item, index) => {
        const parentItem =
          item.parentElement?.closest(
            ".comment-item[data-comment-id]"
          ) ?? null;

        return {
          item,
          index,
          timestamp:
            getCommentTimestamp(item),
          parentAuthor:
            parentItem
              ? getDirectCommentAuthor(
                  parentItem
                )
              : ""
        };
      }
    );

    records.sort((left, right) =>
      left.timestamp - right.timestamp ||
      left.index - right.index
    );

    const fragment =
      document.createDocumentFragment();

    for (const record of records) {
      const { item } = record;

      item.dataset.commentDepth = "0";
      item.dataset.flatCommentReady =
        "true";
      addReplyReference(
        item,
        record.parentAuthor
      );
      bindLongPress(item);
      fragment.appendChild(item);
    }

    for (const { item } of records) {
      item.querySelector(
        ":scope > [data-comment-replies]"
      )?.remove();
    }

    list.appendChild(fragment);
    addLongPressHint(article);
  }


  function enhanceEntry(article) {
    if (!(article instanceof Element)) {
      return;
    }

    formatEntryBody(article);
    enhanceCommentComposer(article);
    flattenComments(article);
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


  function startEnhancer() {
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


  runWhenReady(startEnhancer);
})();
