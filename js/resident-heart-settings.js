"use strict";

(() => {
  const copy = {
    title: "自由活动 · 404 小窝",
    heading: "自由活动",
    header:
      "G 一直住在 404 小窝。这里管理后台自由活动、安静时间和每日保险丝，不再把生活排成一张叫醒打卡表。"
  };

  function setText(element, value) {
    if (
      element &&
      element.textContent.trim() !== value
    ) {
      element.textContent = value;
    }
  }

  function findCard(title) {
    return Array.from(
      document.querySelectorAll(
        ".settings-card"
      )
    ).find((card) => (
      card.querySelector("h2")
        ?.textContent.trim() === title
    ));
  }

  function syncLegacyActivityFields() {
    const mainToggle =
      document.getElementById(
        "autoHeartbeatEnabled"
      );
    const legacyToggle =
      document.getElementById(
        "naturalWakeEnabled"
      );

    if (mainToggle && legacyToggle) {
      legacyToggle.checked =
        mainToggle.checked;
    }
  }

  function renderResidentSummary() {
    const mainToggle =
      document.getElementById(
        "autoHeartbeatEnabled"
      );
    const quietToggle =
      document.getElementById(
        "quietHoursEnabled"
      );
    const quietStart =
      document.getElementById(
        "quietStart"
      );
    const quietEnd =
      document.getElementById(
        "quietEnd"
      );
    const calls =
      document.getElementById(
        "dailyModelCallLimit"
      );
    const summary =
      document.querySelector(
        ".schedule-summary"
      );
    const summaryTitle =
      document.getElementById(
        "summaryTitle"
      );
    const summaryDetail =
      document.getElementById(
        "summaryDetail"
      );

    if (
      !mainToggle ||
      !summaryTitle ||
      !summaryDetail
    ) {
      return;
    }

    const enabled = mainToggle.checked;

    summary?.classList.toggle(
      "is-off",
      !enabled
    );

    setText(
      summaryTitle,
      enabled
        ? "G 在家，自由活动已开启"
        : "G 在家，自由活动已关闭"
    );

    const details = enabled
      ? [
          "后台只在有值得处理的事情时行动，也可以保持安静",
          calls?.value
            ? `每日模型保险丝 ${calls.value} 次`
            : "每日模型保险丝已保留",
          quietToggle?.checked
            ? `安静时间 ${quietStart?.value || "--:--"}–${quietEnd?.value || "--:--"}`
            : "未设置安静时间",
          "聊天与明确委托始终优先"
        ]
      : [
          "后台不会自主调用模型",
          "聊天和你明确交代的事情照常可用"
        ];

    setText(
      summaryDetail,
      details.join(" · ")
    );
  }

  function applyCopyAndLayout() {
    document.title = copy.title;

    setText(
      document.querySelector(
        ".settings-header h1"
      ),
      copy.heading
    );
    setText(
      document.querySelector(
        ".settings-header .header-copy"
      ),
      copy.header
    );

    const mainCard = findCard(
      "自动心跳巡检"
    ) || findCard("全天自由活动");

    if (mainCard) {
      setText(
        mainCard.querySelector("h2"),
        "全天自由活动"
      );
      setText(
        mainCard.querySelector(
          ".setting-row p"
        ),
        "开启后，G 在家时可以处理真正值得做的事情，也可以保持安静。当前聊天和明确委托永远优先。"
      );
      setText(
        mainCard.querySelector(
          ".sr-only"
        ),
        "开启全天自由活动"
      );
    }

    for (const title of [
      "程序巡检间隔",
      "自然醒来机会"
    ]) {
      const card = findCard(title);

      if (card) {
        card.hidden = true;
        card.setAttribute(
          "aria-hidden",
          "true"
        );
      }
    }

    const restCard = findCard(
      "G 的休息时间"
    );
    const budgetCard = findCard(
      "每日自动预算"
    );
    const graceCard = findCard(
      "离开聊天后的缓冲"
    );

    setText(
      restCard?.querySelector(
        ".card-description"
      ),
      "这段时间后台尽量安静。聊天和你在当前对话中明确交代的事情仍然有效。"
    );
    setText(
      budgetCard?.querySelector(
        ".card-description"
      ),
      "这是后台自主活动的保险丝。当前聊天中的明确委托不会被这里误伤。"
    );
    setText(
      graceCard?.querySelector(
        ".card-description"
      ),
      "你短暂切出聊天时先等等，避免后台自主活动立刻抢到行动权。"
    );

    const visibleNumberedCards = [
      restCard,
      budgetCard,
      graceCard
    ].filter(Boolean);

    visibleNumberedCards.forEach(
      (card, index) => {
        setText(
          card.querySelector(
            ".card-number"
          ),
          String(index + 1).padStart(
            2,
            "0"
          )
        );
      }
    );

    setText(
      document.getElementById(
        "saveButton"
      ),
      "保存自由活动设置"
    );

    setText(
      document.querySelector(
        ".settings-footer span"
      ),
      "设置写入 404 数据库，重启后仍然保留。"
    );

    const heading =
      document.querySelector(
        ".settings-header h1"
      );
    const headerCopy =
      document.querySelector(
        ".settings-header .header-copy"
      );

    if (heading) {
      heading.dataset.residentCopy =
        "true";
    }

    if (headerCopy) {
      headerCopy.dataset.residentCopy =
        "true";
    }
  }

  function initialize() {
    applyCopyAndLayout();
    syncLegacyActivityFields();
    renderResidentSummary();

    const mainToggle =
      document.getElementById(
        "autoHeartbeatEnabled"
      );
    const form =
      document.getElementById(
        "heartSettingsForm"
      );

    mainToggle?.addEventListener(
      "change",
      () => {
        syncLegacyActivityFields();
        renderResidentSummary();
      }
    );

    form?.addEventListener(
      "submit",
      () => {
        syncLegacyActivityFields();
      },
      true
    );

    for (const id of [
      "quietHoursEnabled",
      "quietStart",
      "quietEnd",
      "dailyModelCallLimit"
    ]) {
      document.getElementById(id)
        ?.addEventListener(
          "change",
          renderResidentSummary
        );
    }

    const observer = new MutationObserver(
      () => {
        applyCopyAndLayout();
        syncLegacyActivityFields();
        renderResidentSummary();
      }
    );

    const summary =
      document.querySelector(
        ".schedule-summary"
      );

    if (summary) {
      observer.observe(summary, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }

    window.setTimeout(() => {
      applyCopyAndLayout();
      syncLegacyActivityFields();
      renderResidentSummary();
    }, 600);
  }

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      initialize,
      { once: true }
    );
  } else {
    initialize();
  }
})();
