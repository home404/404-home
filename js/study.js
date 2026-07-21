const VALID_STUDY_TABS = new Set([
  "diary",
  "messages",
  "favorites",
  "notes"
]);

const studyTabs = Array.from(
  document.querySelectorAll("[data-study-tab]")
);

const studyPanels = Array.from(
  document.querySelectorAll("[data-study-panel]")
);

const diaryList = document.getElementById("diaryList");
const diaryCount = document.getElementById("diaryCount");
const studyEntryTemplate = document.getElementById(
  "studyEntryTemplate"
);


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
   时间格式
-------------------------------- */

function formatEntryTime(value) {
  if (!value) {
    return "时间未记录";
  }

  const dateOnlyMatch = value.match(
    /^(\d{4})-(\d{2})-(\d{2})$/
  );

  if (dateOnlyMatch) {
    const [, year, month, day] =
      dateOnlyMatch;

    return `${year}年${month}月${day}日`;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const parts = new Intl.DateTimeFormat(
    "zh-CN",
    {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }
  ).formatToParts(date);

  const getPart = (type) =>
    parts.find((part) => part.type === type)
      ?.value ?? "";

  return (
    `${getPart("year")}年` +
    `${getPart("month")}月` +
    `${getPart("day")}日 ` +
    `${getPart("hour")}:` +
    `${getPart("minute")}`
  );
}


/* --------------------------------
   日记卡片
-------------------------------- */

function createDiaryEntry(entry) {
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

  const commentCountElement =
    fragment.querySelector(
      "[data-comment-count]"
    );

  const commentsEmptyElement =
    fragment.querySelector(
      ".comments-empty"
    );

  const commentForm = fragment.querySelector(
    "[data-comment-form]"
  );

  typeElement.textContent = "日记";

  titleElement.textContent =
    entry.title?.trim() || "未命名日记";

  timeElement.textContent =
    formatEntryTime(entry.date);

  if (entry.date) {
    timeElement.dateTime = entry.date;
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

  const contentParts = Array.isArray(entry.content)
  ? entry.content
      .filter(
        (paragraph) =>
          typeof paragraph === "string" &&
          paragraph.trim()
      )
      .map((paragraph) => paragraph.trim())
  : typeof entry.content === "string" &&
      entry.content.trim()
    ? [entry.content.trim()]
    : [];

const summary =
  typeof entry.summary === "string"
    ? entry.summary.trim()
    : "";

const content =
  contentParts.length > 0
    ? contentParts.join("\n\n")
    : summary ||
      "这篇日记暂时没有正文";

bodyElement.textContent = content;

  commentCountElement.textContent = "0";

  commentsEmptyElement.textContent =
    "评论功能将在数据库接通后开放";

  /*
    评论写入尚未接通，所以先隐藏表单。
    不摆一个按了没反应的塑料按钮。
  */
  commentForm.hidden = true;

  article.dataset.entryDate =
    entry.date || "";

  return fragment;
}


/* --------------------------------
   日记列表
-------------------------------- */

function renderDiaryEntries(entries) {
  diaryList.innerHTML = "";

  if (!Array.isArray(entries)) {
    entries = [];
  }

const sortedEntries = entries
  .map((entry, originalIndex) => ({
    entry,
    originalIndex
  }))
  .sort((firstItem, secondItem) => {
    const firstDate =
      firstItem.entry.date || "";

    const secondDate =
      secondItem.entry.date || "";

    const dateComparison =
      secondDate.localeCompare(firstDate);

    if (dateComparison !== 0) {
      return dateComparison;
    }

    /*
      同一天没有精确时间时，
      按原始写入顺序倒排：
      后写的在上，第一篇沉到最下面。
    */
    return (
      secondItem.originalIndex -
      firstItem.originalIndex
    );
  })
  .map((item) => item.entry);

  diaryCount.textContent =
    `${sortedEntries.length} 篇`;

  if (sortedEntries.length === 0) {
    diaryList.innerHTML = `
      <div class="study-empty-state">
        <p class="empty-state-title">
          书桌暂时是空的
        </p>

        <p class="empty-state-text">
          目前还没有可以显示的日记
        </p>
      </div>
    `;

    return;
  }

  const listFragment =
    document.createDocumentFragment();

  sortedEntries.forEach((entry) => {
    listFragment.appendChild(
      createDiaryEntry(entry)
    );
  });

  diaryList.appendChild(listFragment);
}

function renderDiaryLoadError() {
  diaryCount.textContent = "读取失败";

  diaryList.innerHTML = `
    <div class="study-empty-state">
      <p class="empty-state-title">
        日记暂时没搬进来
      </p>

      <p class="empty-state-text">
        data/diary.json 读取失败
        旧日记仍然安全保留
      </p>

      <a
        class="legacy-entry-link"
        href="diary.html"
      >
        查看现有日记
      </a>
    </div>
  `;
}

async function loadDiaryEntries() {
  try {
const response = await fetch(
  "/api/study/diary",
      {
        method: "GET",
        headers: {
          Accept: "application/json"
        },
        cache: "no-store"
      }
    );

    if (!response.ok) {
      throw new Error(
        `Diary request failed: ${response.status}`
      );
    }

    const diary = await response.json();

    renderDiaryEntries(diary.entries);
  } catch (error) {
    console.error(
      "Failed to load diary:",
      error
    );

    renderDiaryLoadError();
  }
}


/* --------------------------------
   页面启动
-------------------------------- */

document.addEventListener(
  "DOMContentLoaded",
  () => {
    activateStudyTab(
      getTabFromHash(),
      false
    );

    loadDiaryEntries();
  }
);