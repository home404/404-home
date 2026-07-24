"use strict";

(() => {
  const SYNC_INTERVAL_MS = 15_000;
  const FIRST_SYNC_DELAY_MS = 3_000;
  const RECENT_MESSAGE_LIMIT = 120;

  let syncTimer = null;
  let syncInFlight = false;

  function bedroomIsReady() {
    return Boolean(
      typeof authClient !== "undefined" &&
      authClient &&
      typeof currentSession !== "undefined" &&
      currentSession &&
      typeof conversation !== "undefined" &&
      conversation?.id &&
      typeof messages !== "undefined" &&
      Array.isArray(messages)
    );
  }

  async function syncBedroomMessages() {
    if (
      syncInFlight ||
      document.visibilityState !== "visible" ||
      !bedroomIsReady() ||
      (typeof sending !== "undefined" && sending)
    ) {
      return;
    }

    syncInFlight = true;

    try {
      const { data, error } = await authClient
        .from("hippocampus_messages")
        .select([
          "id",
          "role",
          "content",
          "occurred_at",
          "response_id"
        ].join(", "))
        .eq(
          "conversation_id",
          conversation.id
        )
        .order("occurred_at", {
          ascending: false
        })
        .limit(RECENT_MESSAGE_LIMIT);

      if (error) {
        throw error;
      }

      const knownIds = new Set(
        messages
          .map((message) => message?.id)
          .filter(Boolean)
      );
      const incoming = [
        ...(data ?? [])
      ]
        .reverse()
        .filter((message) => (
          message?.id &&
          !knownIds.has(message.id) &&
          ["user", "assistant"].includes(
            message.role
          )
        ));

      for (const message of incoming) {
        messages.push(message);
        renderMessage(
          message.role,
          message.content
        );
        knownIds.add(message.id);
      }

      if (incoming.length) {
        setMemoryState(
          "收到新消息",
          "ready"
        );
      }
    } catch (error) {
      console.error(
        "Sync bedroom messages failed:",
        error
      );
    } finally {
      syncInFlight = false;
    }
  }

  function startBedroomLiveSync() {
    window.setTimeout(() => {
      void syncBedroomMessages();
    }, FIRST_SYNC_DELAY_MS);

    syncTimer = window.setInterval(() => {
      void syncBedroomMessages();
    }, SYNC_INTERVAL_MS);
  }

  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "visible") {
        void syncBedroomMessages();
      }
    }
  );

  window.addEventListener(
    "pagehide",
    () => {
      if (syncTimer) {
        window.clearInterval(syncTimer);
      }
    }
  );

  document.addEventListener(
    "DOMContentLoaded",
    startBedroomLiveSync
  );
})();
