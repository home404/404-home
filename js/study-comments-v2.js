"use strict";

(() => {
  function appendScript(src) {
    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    document.head.appendChild(script);
  }

  appendScript(
    "js/study-comments-v2-core.js?v=20260725-core-v01"
  );
  appendScript(
    "js/study-entry-delete.js?v=20260725-delete-v01"
  );
})();
