"use strict";

const elements = {
  sourceTypeFilter:
    document.getElementById("sourceTypeFilter"),
  archivedFilter:
    document.getElementById("archivedFilter"),
  refreshButton:
    document.getElementById("refreshButton"),
  status:
    document.getElementById("ledgerStatus"),
  list:
    document.getElementById("ledgerList"),
  template:
    document.getElementById("ledgerItemTemplate")
};

let authClient = null;
let currentSession = null;
let loading = false;


function setStatus(text, type = "") {
  elements.status.textContent = text || "";
  elements.status.className =
    `ledger-status${type ? ` is-${type}` : ""}`;
}


function formatTime(value) {
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


function redirectToEntrance() {
  window.location.replace(
    "index.html?next=text-ledger.html"
  );
}


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


async function apiFetch(
  path,
  options = {},
  allowRetry = true
) {
  const accessToken = await getAccessToken();

  if (!accessToken) {
    throw new Error("登录状态已经失效");
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
    const refreshed =
      await getAccessToken(true);

    if (refreshed) {
      return apiFetch(
        path,
        options,
        false
      );
    }
  }

  const body = await response
    .json()
    .catch(() => null);

  if (
    !response.ok ||
    body?.ok === false
  ) {
    const error = new Error(
      body?.message ??
      body?.error ??
      `请求失败：${response.status}`
    );
    error.status = response.status;
    throw error;
  }

  return body;
}


function getFullBody(item) {
  const row = item?.row ?? {};

  return [
    row.body,
    row.content,
    row.detail,
    row.summary,
    row.title
  ]
    .map((value) => String(value ?? "").trim())
    .find(Boolean) || "这条记录没有正文。";
}


function renderEmpty(text) {
  elements.list.innerHTML = "";
  const box = document.createElement("div");
  box.className = "ledger-empty";
  box.textContent = text;
  elements.list.appendChild(box);
}


async function loadFullDetail(
  item,
  bodyElement,
  summaryElement
) {
  if (bodyElement.dataset.loaded === "true") {
    return;
  }

  summaryElement.textContent = "正在读取完整内容……";

  try {
    const result = await apiFetch(
      `/api/text-ledger/items/${encodeURIComponent(item.sourceType)}/${encodeURIComponent(item.sourceId)}`
    );

    bodyElement.textContent =
      getFullBody(result.item);
    bodyElement.dataset.loaded = "true";
    summaryElement.textContent = "收起完整内容";
  } catch (error) {
    bodyElement.textContent =
      error?.message ?? "完整内容读取失败";
    summaryElement.textContent = "重新读取完整内容";
  }
}


function createItemElement(item) {
  const fragment =
    elements.template.content.cloneNode(true);
  const article = fragment.querySelector(
    ".ledger-item"
  );
  const sourceLabel = fragment.querySelector(
    "[data-source-label]"
  );
  const title = fragment.querySelector(
    "[data-title]"
  );
  const time = fragment.querySelector(
    "[data-time]"
  );
  const preview = fragment.querySelector(
    "[data-preview]"
  );
  const tags = fragment.querySelector(
    "[data-tags]"
  );
  const details = fragment.querySelector(
    ".item-detail"
  );
  const openDetail = fragment.querySelector(
    "[data-open-detail]"
  );
  const fullBody = fragment.querySelector(
    "[data-full-body]"
  );
  const archiveButton = fragment.querySelector(
    "[data-archive]"
  );
  const deleteButton = fragment.querySelector(
    "[data-delete]"
  );

  article.dataset.sourceType = item.sourceType;
  article.dataset.sourceId = item.sourceId;
  sourceLabel.textContent = item.sourceLabel;
  title.textContent = item.title;
  time.textContent = formatTime(item.occurredAt);
  time.dateTime = item.occurredAt ?? "";
  preview.textContent =
    item.preview || "这条记录没有可预览的正文。";

  for (const tag of item.tags ?? []) {
    const chip = document.createElement("span");
    chip.textContent = tag;
    tags.appendChild(chip);
  }

  details.addEventListener("toggle", () => {
    if (details.open) {
      void loadFullDetail(
        item,
        fullBody,
        openDetail
      );
    } else if (
      fullBody.dataset.loaded === "true"
    ) {
      openDetail.textContent = "查看完整内容";
    }
  });

  archiveButton.textContent = item.archived
    ? "取消归档"
    : "归档";

  archiveButton.addEventListener(
    "click",
    async () => {
      archiveButton.disabled = true;
      deleteButton.disabled = true;

      try {
        await apiFetch(
          `/api/text-ledger/items/${encodeURIComponent(item.sourceType)}/${encodeURIComponent(item.sourceId)}/archive`,
          {
            method: "PATCH",
            body: JSON.stringify({
              archived: !item.archived
            })
          }
        );

        article.remove();
        setStatus(
          item.archived
            ? "已经放回原来的列表。"
            : "已经归档。"
        );

        if (!elements.list.children.length) {
          renderEmpty(
            "这个筛选条件下暂时没有文字。"
          );
        }
      } catch (error) {
        setStatus(
          error?.message ?? "归档失败",
          "error"
        );
        archiveButton.disabled = false;
        deleteButton.disabled = false;
      }
    }
  );

  deleteButton.addEventListener(
    "click",
    async () => {
      const confirmed = window.confirm(
        `确定删除《${item.title}》吗？\n\n这会从原数据库中删除正文。`
      );

      if (!confirmed) {
        return;
      }

      archiveButton.disabled = true;
      deleteButton.disabled = true;
      deleteButton.textContent = "正在删除……";

      try {
        await apiFetch(
          `/api/text-ledger/items/${encodeURIComponent(item.sourceType)}/${encodeURIComponent(item.sourceId)}`,
          {
            method: "DELETE"
          }
        );

        article.remove();
        setStatus("文字已经删除。");

        if (!elements.list.children.length) {
          renderEmpty(
            "这个筛选条件下暂时没有文字。"
          );
        }
      } catch (error) {
        setStatus(
          error?.message ?? "删除失败",
          "error"
        );
        archiveButton.disabled = false;
        deleteButton.disabled = false;
        deleteButton.textContent = "删除";
      }
    }
  );

  return article;
}


async function loadItems() {
  if (loading || !currentSession) {
    return;
  }

  loading = true;
  elements.refreshButton.disabled = true;
  setStatus("正在从全屋数据库取回文字……");

  try {
    const params = new URLSearchParams({
      archived:
        String(elements.archivedFilter.checked),
      limit: "150"
    });
    const sourceType =
      elements.sourceTypeFilter.value;

    if (sourceType) {
      params.set("sourceType", sourceType);
    }

    const result = await apiFetch(
      `/api/text-ledger/items?${params.toString()}`
    );
    const items = Array.isArray(result.items)
      ? result.items
      : [];

    elements.list.innerHTML = "";

    if (!items.length) {
      renderEmpty(
        elements.archivedFilter.checked
          ? "归档箱现在是空的。"
          : "这个筛选条件下暂时没有文字。"
      );
    } else {
      const fragment =
        document.createDocumentFragment();

      for (const item of items) {
        fragment.appendChild(
          createItemElement(item)
        );
      }

      elements.list.appendChild(fragment);
    }

    setStatus(`共找到 ${items.length} 条文字。`);
  } catch (error) {
    console.error(
      "Load text ledger failed:",
      error
    );
    setStatus(
      error?.message ?? "文字总账读取失败",
      "error"
    );
    renderEmpty(
      "文字仍然保留在数据库里，只是这次没有取回来。"
    );
  } finally {
    loading = false;
    elements.refreshButton.disabled = false;
  }
}


async function initialize() {
  try {
    const configResponse = await fetch(
      "/api/public-config",
      { cache: "no-store" }
    );

    if (!configResponse.ok) {
      throw new Error(
        "无法读取全屋门锁配置"
      );
    }

    const config = await configResponse.json();

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

    if (!session) {
      redirectToEntrance();
      return;
    }

    currentSession = session;
    authClient.auth.onAuthStateChange(
      (_event, nextSession) => {
        queueMicrotask(() => {
          currentSession = nextSession;

          if (!nextSession) {
            redirectToEntrance();
          }
        });
      }
    );

    await loadItems();
  } catch (error) {
    console.error(
      "Initialize text ledger failed:",
      error
    );
    setStatus(
      error?.message ?? "文字总账初始化失败",
      "error"
    );
  }
}


elements.refreshButton.addEventListener(
  "click",
  () => void loadItems()
);
elements.sourceTypeFilter.addEventListener(
  "change",
  () => void loadItems()
);
elements.archivedFilter.addEventListener(
  "change",
  () => void loadItems()
);

document.addEventListener(
  "DOMContentLoaded",
  () => void initialize()
);
