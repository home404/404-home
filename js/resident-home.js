"use strict";

(() => {
  const RESIDENT_STATUS = "G 在家";

  function applyResidentHome() {
    const status = document.getElementById(
      "homeStatusTitle"
    );

    if (
      status &&
      status.textContent !== RESIDENT_STATUS
    ) {
      status.textContent = RESIDENT_STATUS;
      status.classList.remove("is-long");
    }

    const activityList =
      document.getElementById(
        "homeActivityList"
      );

    if (activityList) {
      for (
        const item of activityList
          .querySelectorAll(".activity-item div")
      ) {
        if (
          item.textContent.trim() ===
            "写了一条留言"
        ) {
          item.textContent =
            "在卧室发来一条消息";
        }

        if (
          item.textContent.trim() ===
            "回复了一条留言"
        ) {
          item.textContent =
            "回复了一条评论";
        }
      }
    }
  }

  function initialize() {
    applyResidentHome();

    const observer = new MutationObserver(
      applyResidentHome
    );

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
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
