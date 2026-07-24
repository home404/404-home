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
      偏好读取完成后，以页面唯一开关为准同步发布总闸。
      这样以后不再需要屋主理解两套开关。
    */
    window.setTimeout(() => {
      void syncRuntimeRelease({
        force: true
      });
      restoreResidentLabels();
    }, 1200);
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
