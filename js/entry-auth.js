"use strict";

const SAFE_DESTINATIONS = new Set([
  "home.html",
  "study.html",
  "living-room.html",
  "chat.html",
  "archive.html",
  "about.html",
  "heart-settings.html"
]);

const entryElements = {
  panel: document.getElementById("entryAuthPanel"),
  status: document.getElementById("entryAuthStatus"),
  form: document.getElementById("entryLoginForm"),
  email: document.getElementById("entryEmailInput"),
  password: document.getElementById("entryPasswordInput"),
  button: document.getElementById("entryLoginButton"),
  enterLink: document.getElementById("enterHomeLink")
};

let entryAuthClient = null;

function getDestination() {
  const requested =
    new URLSearchParams(window.location.search)
      .get("next")
      ?.trim() ??
    "";

  const [pathPart, hashPart = ""] =
    requested.split("#", 2);

  if (!SAFE_DESTINATIONS.has(pathPart)) {
    return "home.html";
  }

  return hashPart
    ? `${pathPart}#${hashPart}`
    : pathPart;
}

function setEntryStatus(
  text,
  type = ""
) {
  entryElements.status.textContent = text || "";
  entryElements.status.className =
    `entry-auth-status${type ? ` is-${type}` : ""}`;
}

function renderSignedOut() {
  entryElements.form.hidden = false;
  entryElements.enterLink.hidden = true;
  setEntryStatus(
    "第一次使用这台设备时，请先登录屋主账号。"
  );
}

function renderSignedIn(session) {
  entryElements.form.hidden = true;
  entryElements.enterLink.hidden = false;
  entryElements.enterLink.href = getDestination();

  const email =
    session?.user?.email ??
    "屋主";

  setEntryStatus(
    `${email}，门已经打开。`,
    "success"
  );
}

async function initializeEntryAuth() {
  try {
    const configResponse = await fetch(
      "/api/public-config",
      { cache: "no-store" }
    );

    if (!configResponse.ok) {
      throw new Error(
        "暂时无法读取小窝门锁配置。"
      );
    }

    const config = await configResponse.json();

    if (
      !config.supabaseUrl ||
      !config.supabasePublishableKey
    ) {
      throw new Error(
        "小窝门锁配置尚未完成。"
      );
    }

    if (!window.supabase?.createClient) {
      throw new Error(
        "登录组件没有加载成功。"
      );
    }

    entryAuthClient =
      window.supabase.createClient(
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
    } =
      await entryAuthClient.auth.getSession();

    if (error) {
      throw error;
    }

    if (session) {
      renderSignedIn(session);
    } else {
      renderSignedOut();
    }

    entryAuthClient.auth.onAuthStateChange(
      (_event, nextSession) => {
        queueMicrotask(() => {
          if (nextSession) {
            renderSignedIn(nextSession);
          } else {
            renderSignedOut();
          }
        });
      }
    );
  } catch (error) {
    console.error(
      "Entry auth initialization failed:",
      error
    );

    entryElements.form.hidden = true;
    entryElements.enterLink.hidden = true;

    setEntryStatus(
      error?.message ??
        "门锁初始化失败。",
      "error"
    );
  }
}

async function handleEntryLogin(event) {
  event.preventDefault();

  if (!entryAuthClient) {
    setEntryStatus(
      "门锁还没有准备好。",
      "error"
    );
    return;
  }

  entryElements.button.disabled = true;
  entryElements.button.textContent =
    "正在开门……";

  try {
    const email =
      entryElements.email.value.trim();

    const password =
      entryElements.password.value;

    const { error } =
      await entryAuthClient.auth
        .signInWithPassword({
          email,
          password
        });

    if (error) {
      throw error;
    }

    entryElements.password.value = "";

    window.location.assign(
      getDestination()
    );
  } catch (error) {
    setEntryStatus(
      error?.message ??
        "登录失败，请检查邮箱和密码。",
      "error"
    );
  } finally {
    entryElements.button.disabled = false;
    entryElements.button.textContent =
      "登录并回家";
  }
}

entryElements.form.addEventListener(
  "submit",
  handleEntryLogin
);

document.addEventListener(
  "DOMContentLoaded",
  () => {
    void initializeEntryAuth();
  }
);
