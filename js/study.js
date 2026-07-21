"use strict";

const VALID_STUDY_TABS = new Set([
  "diary",
  "messages",
  "favorites",
  "notes"
]);

const TAB_CONFIG = {
  diary: {
    entryType: "diary",
    label: "日记",
    unit: "篇",
    listId: "diaryList",
    countId: "diaryCount",
    emptyTitle: "书桌暂时是空的",
    emptyText: "目前还没有可以显示的日记"
  },

  messages: {
    entryType: "message",
    label: "留言",
    unit: "条",
    listId: "messageList",
    countId: "messageCount",
    emptyTitle: "暂无留言",
    emptyText: "心跳系统留下的主动留言会保存在这里"
  },

  favorites: {
    entryType: "favorite",
    label: "对话收藏",
    unit: "条",
    listId: "favoriteList",
    countId: "favoriteCount",
    emptyTitle: "暂无收藏",
    emptyText: "谢诗收藏、G 收藏和双方收藏会分别标记"
  },

  notes: {
    entryType: "note",
    label: "小纸条",
    unit: "张",
    listId: "noteList",
    countId: "noteCount",
    emptyTitle: "暂无小纸条",
    emptyText: "长对话压缩后的线索会放在这里"
  }
};

const ENTRY_TYPE_LABELS = {
  diary: "日记",
  message: "留言",
  favorite: "对话收藏",
  note: "小纸条"
};

const COMMENT_AUTHOR_LABELS = {
  xie_shi: "谢诗",
  g: "G"
};

const studyTabs = Array.from(
  document.querySelectorAll("[data-study-tab]")
);

const studyPanels = Array.from(
  document.querySelectorAll("[data-study-panel]")
);

const studyEntryTemplate = document.getElementById(
  "studyEntryTemplate"
);

const studyCommentTemplate = document.getElementById(
  "studyCommentTemplate"
);

const authElements = {
  panel: document.getElementById("studyAuthPanel"),
  loading: document.getElementById("studyAuthLoading"),
  loginForm: document.getElementById("studyLoginForm"),
  emailInput: document.getElementById("studyEmailInput"),
  passwordInput: document.getElementById("studyPasswordInput"),
  loginButton: document.getElementById("studyLoginButton"),
  sessionView: document.getElementById("studySessionView"),
  sessionEmail: document.getElementById("studySessionEmail"),
  signOutButton: document.getElementById("studySignOutButton"),
  message: document.getElementById("studyAuthMessage")
};

let authClient = null;
let currentSession = null;
let authReady = false;

const loadedTabs = new Set();
const loadingTabs = new Set();


/* --------------------------------
   栏目切换
-------------------------------- */

function getTabFromHash() {
  const hashValue = window.location.hash
    .replace("#", "")
    .trim();

  return VALID_STUDY_TABS.has(hashValue)
    ? hashValue
    : "diary";
}

function activateStudyTab(
  tabName,
  updateAddress = true
) {
  const safeTabName = VALID_STUDY_TABS.has(tabName)
    ? tabName
    : "diary";

  studyTabs.forEach((tab) => {
    const isActive =
      tab.dataset.studyTab === safeTabName;

    tab.classList.toggle("is-active", isActive);

    tab.setAttribute(
      "aria-selected",
      String(isActive)
    );

    tab.tabIndex = isActive ? 0 : -1;
  });

  studyPanels.forEach((panel) => {
    const isActive =
      panel.dataset.studyPanel === safeTabName;

    panel.classList.toggle("is-active", isActive);
    panel.hidden = !isActive;
  });

  if (updateAddress) {
    history.replaceState(
      null,
      "",
      `#${safeTabName}`
    );
  }

  if (authReady) {
    void loadTabEntries(safeTabName);
  }
}

studyTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    activateStudyTab(tab.dataset.studyTab);
  });

  tab.addEventListener("keydown", (event) => {
    const currentIndex = studyTabs.indexOf(tab);
    let nextIndex = null;

    if (event.key === "ArrowRight") {
      nextIndex =
        (currentIndex + 1) % studyTabs.length;
    }

    if (event.key === "ArrowLeft") {
      nextIndex =
        (currentIndex - 1 + studyTabs.length) %
        studyTabs.length;
    }

    if (nextIndex === null) {
      return;
    }

    event.preventDefault();

    const nextTab = studyTabs[nextIndex];

    nextTab.focus();

    activateStudyTab(
      nextTab.dataset.studyTab
    );
  });
});

window.addEventListener("hashchange", () => {
  activateStudyTab(
    getTabFromHash(),
    false
  );
});


/* --------------------------------
   时间与通用显示
-------------------------------- */

function formatEntryTime(value) {
  if (!value) {
    return "时间未记录";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat(
    "zh-CN",
    {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }
  ).format(date);
}

function setAuthMessage(
  text,
  type = ""
) {
  authElements.message.textContent = text || "";
  authElements.message.hidden = !text;
  authElements.message.className =
    `study-auth-message${type ? ` is-${type}` : ""}`;
}

function setCommentStatus(
  article,
  text,
  type = ""
) {
  const status = article.querySelector(
    "[data-comment-form-status]"
  );

  if (!status) {
    return;
  }

  status.textContent = text || "";
  status.hidden = !text;
  status.className =
    `comment-form-status${type ? ` is-${type}` : ""}`;
}

function createIdempotencyKey(prefix) {
  const randomPart =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;

  return `${prefix}-${randomPart}`;
}

function renderPanelMessage(
  tabName,
  {
    title,
    text,
    countText = "—"
  }
) {
  const config = TAB_CONFIG[tabName];
  const list = document.getElementById(config.listId);
  const count = document.getElementById(config.countId);

  count.textContent = countText;

  list.innerHTML = "";

  const box = document.createElement("div");
  box.className = "study-empty-state";

  const heading = document.createElement("p");
  heading.className = "empty-state-title";
  heading.textContent = title;

  const copy = document.createElement("p");
  copy.className = "empty-state-text";
  copy.textContent = text;

  box.append(heading, copy);
  list.appendChild(box);
}

function renderSignedOutPanels() {
  loadedTabs.clear();

  for (const tabName of VALID_STUDY_TABS) {
    renderPanelMessage(
      tabName,
      {
        title: "书房门锁着",
        text: "请先使用上方的屋主账号登录。",
        countText: "未登录"
      }
    );
  }
}


/* --------------------------------
   Supabase 登录
-------------------------------- */

function renderAuthState(session) {
  currentSession = session ?? null;

  authElements.loading.hidden = true;

  if (!currentSession) {
    authElements.loginForm.hidden = false;
    authElements.sessionView.hidden = true;
    authElements.sessionEmail.textContent = "";
    renderSignedOutPanels();
    return;
  }

  authElements.loginForm.hidden = true;
  authElements.sessionView.hidden = false;
  authElements.sessionEmail.textContent =
    currentSession.user?.email ?? "已登录屋主";

  setAuthMessage("书房门锁已打开。", "success");

  void loadTabEntries(
    getTabFromHash(),
    { force: true }
  );
}

async function initializeAuth() {
  try {
    const configResponse = await fetch(
      "/api/public-config",
      { cache: "no-store" }
    );

    if (!configResponse.ok) {
      throw new Error(
        "无法读取书房公开连接配置。"
      );
    }

    const config = await configResponse.json();

    if (
      !config.supabaseUrl ||
      !config.supabasePublishableKey
    ) {
      throw new Error(
        "书房公开连接配置尚未完成。"
      );
    }

    if (!window.supabase?.createClient) {
      throw new Error(
        "Supabase 登录组件没有加载成功。"
      );
    }

    authClient = window.supabase.createClient(
      config.supabaseUrl,
      config.supabasePublishableKey,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      }
    );

    const {
      data: { session },
      error
    } = await authClient.auth.getSession();

    if (error) {
      throw error;
    }

    authReady = true;
    renderAuthState(session);

    authClient.auth.onAuthStateChange(
      (_event, nextSession) => {
        queueMicrotask(() => {
          renderAuthState(nextSession);
        });
      }
    );
  } catch (error) {
    console.error(
      "Study auth initialization failed:",
      error
    );

    authReady = true;
    authElements.loading.hidden = true;
    authElements.loginForm.hidden = false;

    setAuthMessage(
      error?.message ??
        "书房登录初始化失败。",
      "error"
    );

    renderSignedOutPanels();
  }
}

async function handleLogin(event) {
  event.preventDefault();
  setAuthMessage("");

  if (!authClient) {
    setAuthMessage(
      "登录组件还没有准备好。",
      "error"
    );
    return;
  }

  authElements.loginButton.disabled = true;
  authElements.loginButton.textContent = "正在登录……";

  try {
    const email =
      authElements.emailInput.value.trim();

    const password =
      authElements.passwordInput.value;

    const { error } =
      await authClient.auth.signInWithPassword({
        email,
        password
      });

    if (error) {
      throw error;
    }

    authElements.passwordInput.value = "";
    setAuthMessage("登录成功。", "success");
  } catch (error) {
    setAuthMessage(
      error?.message ??
        "登录失败，请检查邮箱和密码。",
      "error"
    );
  } finally {
    authElements.loginButton.disabled = false;
    authElements.loginButton.textContent = "登录书房";
  }
}

async function handleSignOut() {
  if (!authClient) {
    return;
  }

  authElements.signOutButton.disabled = true;

  try {
    await authClient.auth.signOut();
    setAuthMessage("已经退出书房。", "success");
  } catch (error) {
    setAuthMessage(
      error?.message ?? "退出失败。",
      "error"
    );
  } finally {
    authElements.signOutButton.disabled = false;
  }
}


/* --------------------------------
   正式书房 API
-------------------------------- */

async function getAccessToken(
  forceRefresh = false
) {
  if (!authClient) {
    return null;
  }

  if (forceRefresh) {
    const { data, error } =
      await authClient.auth.refreshSession();

    if (error) {
      return null;
    }

    currentSession = data.session ?? null;
    return data.session?.access_token ?? null;
  }

  const { data, error } =
    await authClient.auth.getSession();

  if (error) {
    return null;
  }

  currentSession = data.session ?? null;
  return data.session?.access_token ?? null;
}

async function studyApiFetch(
  path,
  options = {},
  allowRetry = true
) {
  const accessToken = await getAccessToken();

  if (!accessToken) {
    throw new Error("study_auth_required");
  }

  const headers = new Headers(
    options.headers ?? {}
  );

  headers.set("Accept", "application/json");
  headers.set(
    "Authorization",
    `Bearer ${accessToken}`
  );

  if (
    options.body &&
    !headers.has("Content-Type")
  ) {
    headers.set(
      "Content-Type",
      "application/json"
    );
  }

  const response = await fetch(
    path,
    {
      ...options,
      headers,
      cache: "no-store"
    }
  );

  if (
    response.status === 401 &&
    allowRetry
  ) {
    const refreshedToken =
      await getAccessToken(true);

    if (refreshedToken) {
      return studyApiFetch(
        path,
        options,
        false
      );
    }
  }

  const data = await response
    .json()
    .catch(() => null);

  if (!response.ok) {
    const error = new Error(
      data?.message ??
      data?.reason ??
      data?.error ??
      `Study request failed: ${response.status}`
    );

    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}


/* --------------------------------
   评论显示与回复
-------------------------------- */

function getCommentAuthorLabel(comment) {
  return COMMENT_AUTHOR_LABELS[comment.author] ??
    comment.author ??
    "未知作者";
}

function setReplyTarget(
  article,
  comment
) {
  article.replyTarget = {
    id: comment.id,
    author: getCommentAuthorLabel(comment)
  };

  const context = article.querySelector(
    "[data-comment-reply-context]"
  );

  const label = article.querySelector(
    "[data-comment-reply-label]"
  );

  const input = article.querySelector(
    "[data-comment-input]"
  );

  label.textContent =
    `正在回复 ${article.replyTarget.author}`;

  context.hidden = false;
  input.placeholder =
    `回复 ${article.replyTarget.author}`;
  input.focus();
}

function clearReplyTarget(article) {
  article.replyTarget = null;

  const context = article.querySelector(
    "[data-comment-reply-context]"
  );

  const input = article.querySelector(
    "[data-comment-input]"
  );

  context.hidden = true;
  input.placeholder = "写下评论";
}

function createCommentElement(
  comment,
  childrenMap,
  depth = 0
) {
  const fragment =
    studyCommentTemplate.content.cloneNode(true);

  const item = fragment.querySelector(
    ".comment-item"
  );

  const authorElement = fragment.querySelector(
    "[data-comment-author]"
  );

  const timeElement = fragment.querySelector(
    "[data-comment-time]"
  );

  const bodyElement = fragment.querySelector(
    "[data-comment-body]"
  );

  const replyButton = fragment.querySelector(
    "[data-comment-reply]"
  );

  const repliesElement = fragment.querySelector(
    "[data-comment-replies]"
  );

  item.dataset.commentId = comment.id;
  item.dataset.commentDepth = String(depth);

  authorElement.textContent =
    getCommentAuthorLabel(comment);

  timeElement.textContent =
    formatEntryTime(comment.createdAt);

  if (comment.createdAt) {
    timeElement.dateTime = comment.createdAt;
  }

  bodyElement.textContent = comment.body ?? "";

  replyButton.addEventListener(
    "click",
    () => {
      const entryArticle = item.closest(
        ".study-entry"
      );

      if (entryArticle) {
        setReplyTarget(
          entryArticle,
          comment
        );
      }
    }
  );

  const childComments =
    childrenMap.get(comment.id) ?? [];

  childComments.forEach((child) => {
    repliesElement.appendChild(
      createCommentElement(
        child,
        childrenMap,
        depth + 1
      )
    );
  });

  return item;
}

function renderComments(
  article,
  comments
) {
  const safeComments = Array.isArray(comments)
    ? comments
    : [];

  const countElement = article.querySelector(
    "[data-comment-count]"
  );

  const listElement = article.querySelector(
    "[data-comment-list]"
  );

  countElement.textContent =
    String(safeComments.length);

  listElement.innerHTML = "";

  if (safeComments.length === 0) {
    const empty = document.createElement("p");
    empty.className = "comments-empty";
    empty.textContent = "暂无评论";
    listElement.appendChild(empty);
    return;
  }

  const childrenMap = new Map();

  safeComments.forEach((comment) => {
    const parentKey =
      comment.parentCommentId ?? null;

    if (!childrenMap.has(parentKey)) {
      childrenMap.set(parentKey, []);
    }

    childrenMap.get(parentKey).push(comment);
  });

  const rootComments =
    childrenMap.get(null) ?? [];

  rootComments.forEach((comment) => {
    listElement.appendChild(
      createCommentElement(
        comment,
        childrenMap,
        0
      )
    );
  });
}


/* --------------------------------
   书房卡片
-------------------------------- */

function createEntryArticle(detail) {
  const entry = detail.entry;
  const comments = detail.comments ?? [];

  const fragment =
    studyEntryTemplate.content.cloneNode(true);

  const article = fragment.querySelector(
    ".study-entry"
  );

  const typeElement = fragment.querySelector(
    "[data-entry-type]"
  );

  const titleElement = fragment.querySelector(
    "[data-entry-title]"
  );

  const timeElement = fragment.querySelector(
    "[data-entry-time]"
  );

  const moodElement = fragment.querySelector(
    "[data-entry-mood]"
  );

  const tagsElement = fragment.querySelector(
    "[data-entry-tags]"
  );

  const bodyElement = fragment.querySelector(
    "[data-entry-body]"
  );

  const commentForm = fragment.querySelector(
    "[data-comment-form]"
  );

  const commentInput = fragment.querySelector(
    "[data-comment-input]"
  );

  const commentSubmit = fragment.querySelector(
    "[data-comment-submit]"
  );

  const cancelReplyButton = fragment.querySelector(
    "[data-comment-cancel-reply]"
  );

  article.dataset.entryId = entry.id;
  article.replyTarget = null;

  typeElement.textContent =
    ENTRY_TYPE_LABELS[entry.entryType] ??
    entry.entryType ??
    "书房内容";

  titleElement.textContent =
    entry.title?.trim() || "未命名内容";

  timeElement.textContent =
    formatEntryTime(entry.createdAt);

  if (entry.createdAt) {
    timeElement.dateTime = entry.createdAt;
  }

  if (entry.mood?.trim()) {
    moodElement.textContent =
      `心情 · ${entry.mood.trim()}`;
  } else {
    moodElement.hidden = true;
  }

  const tags = Array.isArray(entry.tags)
    ? entry.tags.filter(
        (tag) =>
          typeof tag === "string" &&
          tag.trim()
      )
    : [];

  if (tags.length === 0) {
    tagsElement.hidden = true;
  } else {
    tags.forEach((tag) => {
      const tagElement =
        document.createElement("span");

      tagElement.textContent = tag.trim();
      tagsElement.appendChild(tagElement);
    });
  }

  bodyElement.textContent =
    entry.body?.trim() ||
    entry.summary?.trim() ||
    "这条内容暂时没有正文";

  renderComments(article, comments);

  cancelReplyButton.addEventListener(
    "click",
    () => {
      clearReplyTarget(article);
      setCommentStatus(article, "");
    }
  );

  commentForm.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();
      setCommentStatus(article, "");

      const body = commentInput.value.trim();

      if (!body) {
        setCommentStatus(
          article,
          "先写点什么再发送。",
          "error"
        );
        return;
      }

      commentSubmit.disabled = true;
      commentSubmit.textContent = "正在发送……";

      try {
        await studyApiFetch(
          `/api/study/entries/${encodeURIComponent(entry.id)}/comments`,
          {
            method: "POST",
            body: JSON.stringify({
              parentCommentId:
                article.replyTarget?.id ?? null,
              body,
              idempotencyKey:
                createIdempotencyKey(
                  `web-comment-${entry.id}`
                )
            })
          }
        );

        commentInput.value = "";
        clearReplyTarget(article);
        setCommentStatus(
          article,
          "评论已经留在书房。",
          "success"
        );

        await refreshEntryArticle(
          entry.id,
          article
        );
      } catch (error) {
        console.error(
          "Create study comment failed:",
          error
        );

        setCommentStatus(
          article,
          error?.message ?? "评论发送失败。",
          "error"
        );
      } finally {
        commentSubmit.disabled = false;
        commentSubmit.textContent = "发送评论";
      }
    }
  );

  return article;
}

async function refreshEntryArticle(
  entryId,
  oldArticle
) {
  const detail = await studyApiFetch(
    `/api/study/entries/${encodeURIComponent(entryId)}`
  );

  const nextArticle = createEntryArticle(detail);
  oldArticle.replaceWith(nextArticle);
}


/* --------------------------------
   列表读取
-------------------------------- */

async function loadTabEntries(
  tabName,
  { force = false } = {}
) {
  const safeTabName = VALID_STUDY_TABS.has(tabName)
    ? tabName
    : "diary";

  const config = TAB_CONFIG[safeTabName];

  if (!currentSession) {
    renderPanelMessage(
      safeTabName,
      {
        title: "书房门锁着",
        text: "请先使用上方的屋主账号登录。",
        countText: "未登录"
      }
    );
    return;
  }

  if (
    loadingTabs.has(safeTabName) ||
    (loadedTabs.has(safeTabName) && !force)
  ) {
    return;
  }

  loadingTabs.add(safeTabName);

  renderPanelMessage(
    safeTabName,
    {
      title: "正在翻找书页……",
      text: "书房正在从数据库取回内容。",
      countText: "读取中"
    }
  );

  try {
    const listResult = await studyApiFetch(
      `/api/study/entries?entryType=${encodeURIComponent(config.entryType)}&limit=100`
    );

    const summaries = Array.isArray(listResult.entries)
      ? listResult.entries
      : [];

    const details = await Promise.all(
      summaries.map(async (summary) => {
        try {
          return await studyApiFetch(
            `/api/study/entries/${encodeURIComponent(summary.id)}`
          );
        } catch (error) {
          console.error(
            "Load study entry detail failed:",
            summary.id,
            error
          );

          return {
            entry: {
              ...summary,
              body:
                summary.summary ??
                "正文暂时读取失败"
            },
            comments: []
          };
        }
      })
    );

    renderEntryList(
      safeTabName,
      details
    );

    loadedTabs.add(safeTabName);
  } catch (error) {
    console.error(
      "Load study entries failed:",
      error
    );

    if (
      error?.message === "study_auth_required" ||
      error?.status === 401
    ) {
      renderAuthState(null);
      setAuthMessage(
        "登录已失效，请重新登录。",
        "error"
      );
      return;
    }

    renderPanelMessage(
      safeTabName,
      {
        title: `${config.label}暂时没取回来`,
        text:
          error?.message ??
          "数据库读取失败，内容仍然安全保留。",
        countText: "读取失败"
      }
    );
  } finally {
    loadingTabs.delete(safeTabName);
  }
}

function renderEntryList(
  tabName,
  details
) {
  const config = TAB_CONFIG[tabName];
  const list = document.getElementById(config.listId);
  const count = document.getElementById(config.countId);

  const safeDetails = Array.isArray(details)
    ? details
    : [];

  count.textContent =
    `${safeDetails.length} ${config.unit}`;

  list.innerHTML = "";

  if (safeDetails.length === 0) {
    renderPanelMessage(
      tabName,
      {
        title: config.emptyTitle,
        text: config.emptyText,
        countText: `0 ${config.unit}`
      }
    );
    return;
  }

  const fragment =
    document.createDocumentFragment();

  safeDetails.forEach((detail) => {
    fragment.appendChild(
      createEntryArticle(detail)
    );
  });

  list.appendChild(fragment);
}


/* --------------------------------
   页面启动
-------------------------------- */

authElements.loginForm.addEventListener(
  "submit",
  handleLogin
);

authElements.signOutButton.addEventListener(
  "click",
  () => {
    void handleSignOut();
  }
);

document.addEventListener(
  "DOMContentLoaded",
  () => {
    activateStudyTab(
      getTabFromHash(),
      false
    );

    void initializeAuth();
  }
);
