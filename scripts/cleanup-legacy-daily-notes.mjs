import "dotenv/config";

import {
  pathToFileURL
} from "node:url";

import {
  createClient
} from "@supabase/supabase-js";


export function sanitizeDailyActivityBody(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => {
      if (
        !/^\s*[-•]\s*\d{1,2}:\d{2}\s*[｜|]/.test(
          line
        )
      ) {
        return line;
      }

      const detailIndex = line.indexOf(" — ");

      return detailIndex >= 0
        ? line.slice(0, detailIndex).trimEnd()
        : line;
    })
    .join("\n")
    .trim();
}


function isDailyActivityNote(entry) {
  const title = String(entry?.title ?? "");
  const tags = Array.isArray(entry?.tags)
    ? entry.tags.map((tag) => String(tag))
    : [];

  return (
    title.includes("活动小纸条") ||
    tags.includes("每日汇总") ||
    (
      tags.includes("活动记录") &&
      tags.includes("小纸条")
    )
  );
}


async function main() {
  const supabaseUrl = String(
    process.env.SUPABASE_URL ?? ""
  ).trim();
  const secretKey = String(
    process.env.SUPABASE_SECRET_KEY ?? ""
  ).trim();

  if (!supabaseUrl || !secretKey) {
    console.warn(
      "[daily-note-cleanup] skip: Supabase config missing"
    );
    return;
  }

  const client = createClient(
    supabaseUrl,
    secretKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    }
  );

  const { data, error } = await client
    .from("study_entries")
    .select("id, title, body, tags")
    .eq("entry_type", "note")
    .order("created_at", {
      ascending: false
    })
    .limit(200);

  if (error) {
    throw error;
  }

  let updated = 0;

  for (const entry of data ?? []) {
    if (!isDailyActivityNote(entry)) {
      continue;
    }

    const currentBody = String(
      entry.body ?? ""
    ).trim();
    const cleanBody =
      sanitizeDailyActivityBody(currentBody);

    if (!cleanBody || cleanBody === currentBody) {
      continue;
    }

    const { error: updateError } = await client
      .from("study_entries")
      .update({
        body: cleanBody
      })
      .eq("id", entry.id);

    if (updateError) {
      throw updateError;
    }

    updated += 1;
  }

  console.log(
    `[daily-note-cleanup] cleaned ${updated} legacy note(s)`
  );
}


const entryPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : "";

if (import.meta.url === entryPath) {
  main().catch((error) => {
    /* 清扫失败不能阻止 404 主服务开门。 */
    console.warn(
      "[daily-note-cleanup] failed:",
      error?.message ?? error
    );
  });
}
