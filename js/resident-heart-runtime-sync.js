"use strict";

(() => {
  let lastSyncedValue = null;
  let syncInFlight = null;

  async function syncRuntimeRelease({
    force = false
  } = {}) {
    const toggle =
      document.getElementById(
        "autoHeartbeatEnabled"
      );

    if (
      !toggle ||
      typeof apiRequest !== "function"
    ) {
      return;
    }

    const enabled = toggle.checked;

    if (
      !force &&
      lastSyncedValue === enabled
    ) {
      return;
    }

    if (syncInFlight) {
      await syncInFlight;
    }

    syncInFlight = apiRequest(
      "/api/home-orchestration/settings",
      {
        method: "PATCH",
        body: JSON.stringify({
          automaticHeartbeatReleaseEnabled:
            enabled
        })
      }
    );

    try {
      await syncInFlight;
      lastSyncedValue = enabled;
    } catch (error) {
      console.error(
        "Sync resident runtime release failed:",
        error
      );

      if (typeof setMessage === "function") {
        setMessage(
          error?.message ||
            "自由活动总闸没有同步成功。",
          "error"
        );
      }
    } finally {
      syncInFlight = null;
    }
  }

  function preferencesAreReady() {
    return Boolean(
      typeof currentPreferences !==
        "undefined" &&
      currentPreferences &&
      typeof currentPreferences
        .autoHeartbeatEnabled ===
        "boolean"
    );
  }

  function syncAfterPreferencesLoad(
    attempt = 0
  ) {
    if (preferencesAreReady()) {
      void syncRuntimeRelease({
        force: true
      });
      restoreResidentLabels();
      return;
    }

    if (attempt >= 30) {
      console.warn(
        "Resident runtime release: preferences did not become ready."
      );
      return;
    }

    window.setTimeout(() => {
      syncAfterPreferencesLoad(
        attempt + 1
      );
    }, 500);
  }

  function restoreResidentLabels() {
    const saveButton =
      document.getElementById(
        "saveButton"
      );

    if (
      saveButton &&
      !saveButton.disabled
    ) {
      saveButton.textContent =
        "保存自由活动设置";
    }
  }

  function initialize() {
    const toggle =
      document.getElementById(
        "autoHeartbeatEnabled"
      );
    const form =
      document.getElementById(
        "heartSettingsForm"
      );

    toggle?.addEventListener(
      "change",
      () => {
        void syncRuntimeRelease({
          force: true
        });
      }
    );

    form?.addEventListener(
      "submit",
      () => {
        void syncRuntimeRelease({
          force: true
        });

        window.setTimeout(
          restoreResidentLabels,
          500
        );
        window.setTimeout(
          restoreResidentLabels,
          1600
        );
      },
      true
    );

    /*
      等旧偏好真正从数据库读回来后，再用页面唯一开关同步发布总闸。
      Railway 冷启动再慢，也不会把初始空白状态误写成关闭。
    */
    syncAfterPreferencesLoad();
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
