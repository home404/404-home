import {
  createClient
} from "@supabase/supabase-js";


/* ========================================
   基础工具
======================================== */

function normalizeBaseUrl(value) {
  return String(value ?? "")
    .trim()
    .replace(/\/+$/, "");
}


function extractBearerToken(req) {
  const authorization =
    req.headers.authorization;


  if (
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ")
  ) {
    return null;
  }


  const token = authorization
    .slice("Bearer ".length)
    .trim();


  return token || null;
}


function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");

    if (parts.length !== 3) {
      return null;
    }


    const normalized = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/");


    const padded = normalized.padEnd(
      Math.ceil(normalized.length / 4) * 4,
      "="
    );


    return JSON.parse(
      Buffer
        .from(padded, "base64")
        .toString("utf8")
    );
  } catch {
    return null;
  }
}


function createBrowserlessClient({
  supabaseUrl,
  publishableKey,
  accessToken = null
}) {
  const options = {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  };


  if (accessToken) {
    options.global = {
      headers: {
        Authorization:
          `Bearer ${accessToken}`
      }
    };
  }


  return createClient(
    supabaseUrl,
    publishableKey,
    options
  );
}


/* ========================================
   正式 MCP OAuth 门卫
======================================== */

export function createMcpAuth({
  supabaseUrl,
  publishableKey,
  resourceUrl
}) {
  const normalizedSupabaseUrl =
    normalizeBaseUrl(supabaseUrl);

  const normalizedResourceUrl =
    normalizeBaseUrl(resourceUrl);


  if (!normalizedSupabaseUrl) {
    throw new Error(
      "MCP auth 缺少 supabaseUrl"
    );
  }


  if (!publishableKey) {
    throw new Error(
      "MCP auth 缺少 publishableKey"
    );
  }


  if (!normalizedResourceUrl) {
    throw new Error(
      "MCP auth 缺少 resourceUrl"
    );
  }


  const authorizationServer =
    `${normalizedSupabaseUrl}/auth/v1`;

  const expectedIssuer =
    authorizationServer;

  const metadataUrl = new URL(
    "/.well-known/oauth-protected-resource",
    normalizedResourceUrl
  ).toString();


  const verificationClient =
    createBrowserlessClient({
      supabaseUrl:
        normalizedSupabaseUrl,

      publishableKey
    });


  /* --------------------------------------
     受保护资源元数据
  -------------------------------------- */

  function getProtectedResourceMetadata() {
    return {
      resource:
        normalizedResourceUrl,

      resource_name:
        "404 小窝",

      authorization_servers: [
        authorizationServer
      ],

      bearer_methods_supported: [
        "header"
      ],

      scopes_supported: [
        "email",
        "profile"
      ]
    };
  }


  /* --------------------------------------
     返回标准 401
  -------------------------------------- */

  function sendUnauthorized(
    res,
    reason = "authorization_required"
  ) {
    res.set(
      "WWW-Authenticate",
      [
        'Bearer realm="404-home"',
        `resource_metadata="${metadataUrl}"`,
        `error="${reason}"`
      ].join(", ")
    );


    return res.status(401).json({
      error: "unauthorized",
      reason
    });
  }


  /* --------------------------------------
     验证访问令牌
  -------------------------------------- */

  async function authenticate(req) {
    const accessToken =
      extractBearerToken(req);


    if (!accessToken) {
      return {
        ok: false,
        reason: "missing_token"
      };
    }


    /*
      getUser(accessToken) 会把令牌交给
      Supabase Auth 验证，不信任客户端
      自己声称的用户身份。
    */

    const {
      data,
      error
    } = await verificationClient
      .auth
      .getUser(accessToken);


    if (
      error ||
      !data?.user
    ) {
      return {
        ok: false,
        reason: "invalid_token"
      };
    }


    /*
      令牌通过 Supabase 验证以后，
      再读取其声明用于额外核对与审计。
      此处不会记录完整令牌。
    */

    const claims =
      decodeJwtPayload(accessToken);


    if (!claims) {
      return {
        ok: false,
        reason: "invalid_token_payload"
      };
    }


    if (
      claims.iss !== expectedIssuer ||
      claims.sub !== data.user.id
    ) {
      return {
        ok: false,
        reason: "token_identity_mismatch"
      };
    }


    if (
      claims.role &&
      claims.role !== "authenticated"
    ) {
      return {
        ok: false,
        reason: "invalid_token_role"
      };
    }


    /*
      这把 dataClient 携带当前屋主令牌。
      后续所有正文与评论操作都会经过 RLS。
    */

    const dataClient =
      createBrowserlessClient({
        supabaseUrl:
          normalizedSupabaseUrl,

        publishableKey,

        accessToken
      });


    return {
      ok: true,

      accessToken,

      dataClient,

      user: {
        id: data.user.id,
        email:
          data.user.email ?? null
      },

      claims: {
        subject:
          claims.sub,

        role:
          claims.role ?? null,

        audience:
          claims.aud ?? null,

        clientId:
          claims.client_id ?? null,

        expiresAt:
          claims.exp ?? null
      }
    };
  }


  return {
    metadataUrl,
    authorizationServer,
    getProtectedResourceMetadata,
    sendUnauthorized,
    authenticate
  };
}