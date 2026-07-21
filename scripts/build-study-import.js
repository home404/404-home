const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

const sourcePath = path.join(
  projectRoot,
  "data",
  "diary.json"
);

const outputPath = path.join(
  projectRoot,
  "supabase",
  "migrations",
  "20260722_02_import_legacy_diary.sql"
);

const diary = JSON.parse(
  fs.readFileSync(sourcePath, "utf8")
);

if (!Array.isArray(diary.entries)) {
  throw new Error(
    "data/diary.json 中没有有效的 entries 数组"
  );
}

function sqlText(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return "null";
  }

  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlTextArray(values) {
  const safeValues = Array.isArray(values)
    ? values.filter(
        (value) =>
          typeof value === "string" &&
          value.trim()
      )
    : [];

  if (safeValues.length === 0) {
    return "ARRAY[]::text[]";
  }

  return (
    "ARRAY[" +
    safeValues
      .map((value) => sqlText(value.trim()))
      .join(", ") +
    "]::text[]"
  );
}

function getEntryBody(entry) {
  if (Array.isArray(entry.content)) {
    return entry.content
      .filter(
        (paragraph) =>
          typeof paragraph === "string" &&
          paragraph.trim()
      )
      .map((paragraph) => paragraph.trim())
      .join("\n\n");
  }

  if (
    typeof entry.content === "string" &&
    entry.content.trim()
  ) {
    return entry.content.trim();
  }

  if (
    typeof entry.summary === "string" &&
    entry.summary.trim()
  ) {
    return entry.summary.trim();
  }

  return "";
}

const statements = diary.entries.map(
  (entry, originalIndex) => {
    const legacyKey =
      `diary-json-${String(originalIndex + 1).padStart(
        3,
        "0"
      )}`;

    /*
      旧日记只有日期，没有具体时间。
      日期与原始顺序放在 source_ref 中，
      不凭空编造小时和分钟。
    */
    const sourceRef = JSON.stringify({
      legacy_date: entry.date || null,
      legacy_order: originalIndex,
      imported_from: "data/diary.json"
    });

    const title =
      typeof entry.title === "string" &&
      entry.title.trim()
        ? entry.title.trim()
        : "未命名日记";

    const mood =
      typeof entry.mood === "string"
        ? entry.mood.trim()
        : "";

    const summary =
      typeof entry.summary === "string"
        ? entry.summary.trim()
        : "";

    return `
insert into public.study_entries (
  entry_type,
  title,
  body,
  summary,
  mood,
  tags,
  created_by,
  source,
  visibility,
  source_ref,
  legacy_key
)
values (
  'diary',
  ${sqlText(title)},
  ${sqlText(getEntryBody(entry))},
  ${sqlText(summary)},
  ${sqlText(mood)},
  ${sqlTextArray(entry.tags)},
  'g',
  'migration',
  'home_private',
  ${sqlText(sourceRef)}::jsonb,
  ${sqlText(legacyKey)}
)
on conflict (legacy_key) do nothing;`.trim();
  }
);

const sql = [
  "begin;",
  "",
  ...statements,
  "",
  "commit;",
  ""
].join("\n\n");

fs.mkdirSync(
  path.dirname(outputPath),
  { recursive: true }
);

fs.writeFileSync(
  outputPath,
  sql,
  "utf8"
);

console.log(`Created: ${outputPath}`);
console.log(`Entries: ${diary.entries.length}`);