"use strict";

(() => {
  function installResidentContext() {
    if (
      typeof buildModelMessage !==
        "function"
    ) {
      console.warn(
        "Resident bedroom context: buildModelMessage unavailable."
      );
      return;
    }

    const originalBuildModelMessage =
      buildModelMessage;

    buildModelMessage = (options) => {
      const base =
        originalBuildModelMessage(
          options
        );
      const sourceMessages =
        typeof messages !== "undefined" &&
        Array.isArray(messages)
          ? messages
          : [];
      const latestChainedIndex =
        sourceMessages.reduce(
          (latest, item, index) => (
            item?.response_id
              ? index
              : latest
          ),
          -1
        );
      const detached = sourceMessages
        .slice(latestChainedIndex + 1)
        .filter((item) => (
          item?.role === "assistant" &&
          !item?.response_id &&
          String(
            item?.content ?? ""
          ).trim()
        ))
        .slice(-5)
        .map((item) => (
          `G：${String(item.content)
            .trim()
            .slice(0, 700)}`
        ));

      if (!detached.length) {
        return base;
      }

      return [
        base,
        "",
        "【你在家时主动留在卧室、尚未进入上一条响应链的消息】",
        ...detached,
        "",
        "这些话是你此前主动留给谢诗的真实卧室消息。自然承接即可，不要把它们误当成谢诗刚刚说的话。"
      ].join("\n");
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      installResidentContext,
      { once: true }
    );
  } else {
    installResidentContext();
  }
})();
