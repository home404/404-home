const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const MAX_ACTIVITY_DETAIL_LENGTH = 180;
const MAX_TRACKED_RUN_IDS = 240;

const ENTRY_SELECT = [
  "id",
  "entry_type",
  "title",
  "body",
  "summary",
  "mood",
  "tags",
  "created_by",
  "source",
  "visibility",
  "source_ref",
  "owner_user_id",
  "idempotency_key",
  "version",
  "created_at",
  "updated_at"
].join(", ");


function trimText(value, maximum) {
  const text = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");

  if (text.length <= maximum) {
    return text;
  }

  return `${text.slice(0, maximum)}…`;
}


function uniqueStrings(values) {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  );
}


function getZonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }
  ).formatToParts(date);

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = Number(part.value);
    }
  }

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second
  };
}


function addCalendarDays(parts, days) {
  const date = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day + days
    )
  );

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}


function zonedDateTimeToDate({
  year,
  month,
  day,
  hour,
  minute,
  timeZone
}) {
  const targetAsUtc = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    0,
    0
  );

  let resolved = new Date(targetAsUtc);

  for (let index = 0; index < 5; index += 1) {
    const represented = getZonedParts(
      resolved,
      timeZone
    );
    const representedAsUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second,
      0
    );
    const difference =
      targetAsUtc - representedAsUtc;

    if (Math.abs(difference) < 1000) {
      break;
    }

    resolved = new Date(
      resolved.getTime() + difference
    );
  }

  return resolved;
}


export function getDailyActivityDateKey(
  date,
  timeZone = DEFAULT_TIME_ZONE
) {
  const parts = getZonedParts(
    date,
    timeZone
  );

  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0")
  ].join("-");
}


function getLocalDayRange(
  date,
  timeZone
) {
  const parts = getZonedParts(
    date,
    timeZone
  );
  const nextDay = addCalendarDays(
    parts,
    1
  );

  return {
    start: zonedDateTimeToDate({
      ...parts,
      hour: 0,
      minute: 0,
      timeZone
    }),
    end: zonedDateTimeToDate({
      ...nextDay,
      hour: 0,
      minute: 0,
      timeZone
    })
  };
}


function formatClock(
  date,
  timeZone
) {
  return new Intl.DateTimeFormat(
    "zh-CN",
    {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }
  ).format(date);
}


export function buildDailyActivityLine({
  date,
  eventTitle,
  eventDetail = "",
  timeZone = DEFAULT_TIME_ZONE
}) {
  const clock = formatClock(
    date,
    timeZone
  );
  const title =
    trimText(eventTitle, 120) ||
    "完成了一次活动";
  const detail = trimText(
    eventDetail,
    MAX_ACTIVITY_DETAIL_LENGTH
  );

  return detail && detail !== title
    ? `- ${clock}｜${title} — ${detail}`
    : `- ${clock}｜${title}`;
}


function buildLegacyActivityLine(
  entry,
  timeZone
) {
  const createdAt = new Date(
    entry.created_at
  );
  const clockMatch = String(
    entry.title ?? ""
  ).match(/^(\d{2}:\d{2})/);
  const clock = clockMatch?.[1] ??
    formatClock(createdAt, timeZone);
  const sourceRef =
    entry.source_ref &&
    typeof entry.source_ref === "object"
      ? entry.source_ref
      : {};
  const wasDirectNote =
    sourceRef.kind === "activity_note" &&
    String(entry.body ?? "").trim();
  const label = wasDirectNote
    ? "给你留了一条留言"
    : trimText(
        entry.summary ||
        String(entry.title ?? "")
          .replace(/^\d{2}:\d{2}\s*/, ""),
        120
      ) || "记录了一次活动";

  return `- ${clock}｜${label}`;
}


function getSourceRef(entry) {
  return entry?.source_ref &&
    typeof entry.source_ref === "object" &&
    !Array.isArray(entry.source_ref)
      ? entry.source_ref
      : {};
}


function getDailyNoteTitle(dateKey) {
  return `${dateKey.replaceAll("-", "/")} 活动小纸条`;
}


export function createDailyActivityNoteService({
  serviceClient,
  studyService,
  timeZone = DEFAULT_TIME_ZONE
}) {
  if (!serviceClient) {
    throw new Error(
      "创建每日活动小纸条服务时缺少 serviceClient"
    );
  }

  if (!studyService) {
    throw new Error(
      "创建每日活动小纸条服务时缺少 studyService"
    );
  }

  async function repairLegacyDirectMessages(
    rows,
    actor
  ) {
    for (const row of rows) {
      const sourceRef = getSourceRef(row);
      const body = String(
        row.body ?? ""
      ).trim();

      if (
        sourceRef.kind !== "activity_note" ||
        !body
      ) {
        continue;
      }

      try {
        await studyService.createEntry(
          {
            entryType: "message",
            title: "给谢诗的留言",
            body,
            summary:
              row.summary || null,
            mood:
              row.mood || null,
            tags: uniqueStrings([
              ...(row.tags ?? []),
              "小心脏",
              "修复迁移"
            ]),
            visibility:
              row.visibility ||
              "home_private",
            sourceRef: {
              ...sourceRef,
              kind:
                "repaired_legacy_heart_message",
              legacyNoteId:
                row.id
            },
            idempotencyKey:
              `repair-note-${row.id}-message`
          },
          actor
        );
      } catch (error) {
        console.error(
          "Repair legacy heart note as message failed:",
          row.id,
          error
        );
      }
    }
  }


  async function append({
    userId,
    actor,
    now = new Date(),
    eventTitle,
    eventDetail = "",
    runId,
    heartbeatRunId = null,
    activityPass = null,
    attempt = 0
  }) {
    const date = now instanceof Date
      ? now
      : new Date(now);
    const dateKey =
      getDailyActivityDateKey(
        date,
        timeZone
      );
    const dailyKey =
      `heart-daily-activity-${userId}-${dateKey}`;
    const range = getLocalDayRange(
      date,
      timeZone
    );
    const currentLine =
      buildDailyActivityLine({
        date,
        eventTitle,
        eventDetail,
        timeZone
      });

    const {
      data: dayRows,
      error: dayRowsError
    } = await serviceClient
      .from("study_entries")
      .select(ENTRY_SELECT)
      .eq("owner_user_id", userId)
      .eq("entry_type", "note")
      .gte(
        "created_at",
        range.start.toISOString()
      )
      .lt(
        "created_at",
        range.end.toISOString()
      )
      .order("created_at", {
        ascending: true
      });

    if (dayRowsError) {
      throw new Error(
        `无法读取今日活动小纸条：${dayRowsError.message}`
      );
    }

    const activityRows =
      (dayRows ?? []).filter((row) => {
        const kind =
          getSourceRef(row).kind;

        return (
          row.idempotency_key ===
            dailyKey ||
          kind === "activity_note" ||
          kind === "daily_activity_note"
        );
      });

    await repairLegacyDirectMessages(
      activityRows,
      actor
    );

    const canonical =
      activityRows.find(
        (row) =>
          row.idempotency_key ===
            dailyKey
      ) ??
      activityRows[0] ??
      null;

    if (!canonical) {
      const result =
        await studyService.createEntry(
          {
            entryType: "note",
            title:
              getDailyNoteTitle(dateKey),
            body:
              currentLine,
            summary:
              "今日已记录 1 项活动",
            mood:
              activityPass
                ? "自由活动"
                : "今日活动",
            tags: [
              "小纸条",
              "活动记录",
              "每日汇总"
            ],
            visibility:
              "home_private",
            sourceRef: {
              channel: "404_heart",
              kind:
                "daily_activity_note",
              dateKey,
              activityRunIds:
                runId ? [runId] : [],
              heartbeatRunIds:
                heartbeatRunId
                  ? [heartbeatRunId]
                  : [],
              activityPassIds:
                activityPass?.id
                  ? [activityPass.id]
                  : []
            },
            idempotencyKey:
              dailyKey
          },
          actor
        );

      if (
        result.duplicate &&
        attempt < 1
      ) {
        return append({
          userId,
          actor,
          now: date,
          eventTitle,
          eventDetail,
          runId,
          heartbeatRunId,
          activityPass,
          attempt: attempt + 1
        });
      }

      return result.entry;
    }

    const canonicalSourceRef =
      getSourceRef(canonical);
    const trackedRunIds =
      uniqueStrings(
        canonicalSourceRef
          .activityRunIds
      );
    const trackedHeartbeatRunIds =
      uniqueStrings(
        canonicalSourceRef
          .heartbeatRunIds
      );
    const trackedActivityPassIds =
      uniqueStrings(
        canonicalSourceRef
          .activityPassIds
      );
    const alreadyRecorded =
      Boolean(
        runId &&
        trackedRunIds.includes(runId)
      );
    const lines = [];

    if (
      canonicalSourceRef.kind ===
        "daily_activity_note"
    ) {
      lines.push(
        ...String(canonical.body ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      );
    }

    for (const row of activityRows) {
      if (
        row.id === canonical.id &&
        canonicalSourceRef.kind ===
          "daily_activity_note"
      ) {
        continue;
      }

      lines.push(
        buildLegacyActivityLine(
          row,
          timeZone
        )
      );
    }

    if (!alreadyRecorded) {
      lines.push(currentLine);
    }

    const mergedLines =
      uniqueStrings(lines);
    const nextRunIds =
      uniqueStrings([
        ...trackedRunIds,
        runId
      ]).slice(-MAX_TRACKED_RUN_IDS);
    const nextHeartbeatRunIds =
      uniqueStrings([
        ...trackedHeartbeatRunIds,
        heartbeatRunId
      ]).slice(-MAX_TRACKED_RUN_IDS);
    const nextActivityPassIds =
      uniqueStrings([
        ...trackedActivityPassIds,
        activityPass?.id
      ]).slice(-MAX_TRACKED_RUN_IDS);

    const {
      data: updated,
      error: updateError
    } = await serviceClient
      .from("study_entries")
      .update({
        title:
          getDailyNoteTitle(dateKey),
        body:
          mergedLines.join("\n"),
        summary:
          `今日已记录 ${mergedLines.length} 项活动`,
        mood:
          activityPass
            ? "自由活动"
            : canonical.mood ||
              "今日活动",
        tags: uniqueStrings([
          ...(canonical.tags ?? []),
          "小纸条",
          "活动记录",
          "每日汇总"
        ]),
        source_ref: {
          ...canonicalSourceRef,
          channel: "404_heart",
          kind:
            "daily_activity_note",
          dateKey,
          activityRunIds:
            nextRunIds,
          heartbeatRunIds:
            nextHeartbeatRunIds,
          activityPassIds:
            nextActivityPassIds
        },
        idempotency_key:
          dailyKey
      })
      .eq("id", canonical.id)
      .eq("owner_user_id", userId)
      .select(ENTRY_SELECT)
      .single();

    if (updateError) {
      if (
        updateError.code === "23505" &&
        attempt < 1
      ) {
        return append({
          userId,
          actor,
          now: date,
          eventTitle,
          eventDetail,
          runId,
          heartbeatRunId,
          activityPass,
          attempt: attempt + 1
        });
      }

      throw new Error(
        `无法续写今日活动小纸条：${updateError.message}`
      );
    }

    const duplicateIds =
      activityRows
        .filter(
          (row) => row.id !== canonical.id
        )
        .map((row) => row.id);

    if (duplicateIds.length) {
      const { error: deleteError } =
        await serviceClient
          .from("study_entries")
          .delete()
          .in("id", duplicateIds)
          .eq("owner_user_id", userId);

      if (deleteError) {
        console.error(
          "Daily activity note duplicate cleanup failed:",
          deleteError.message
        );
      }
    }

    return updated;
  }


  return {
    append
  };
}
