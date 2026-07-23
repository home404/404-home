import {
  HomeOrchestrationError
} from "./home-orchestration-service.mjs";


async function requireData(
  promise,
  code,
  message
) {
  const {
    data,
    error
  } = await promise;

  if (error) {
    throw new HomeOrchestrationError(
      code,
      message,
      500,
      {
        databaseCode:
          error.code ?? null,
        databaseMessage:
          error.message ?? null
      }
    );
  }

  return data;
}


export function calculateAlignedPassEnd({
  remainingSeconds,
  now = new Date()
}) {
  const currentTime =
    now instanceof Date
      ? now
      : new Date(now);
  const seconds = Math.max(
    0,
    Math.round(
      Number(remainingSeconds) || 0
    )
  );

  return new Date(
    currentTime.getTime() +
    seconds * 1000
  );
}


export async function alignPassEndToRemaining({
  serviceClient,
  userId,
  pass,
  progress,
  remaining,
  source = "activity_clock",
  now = new Date()
}) {
  if (
    !pass?.id ||
    progress?.state !== "running"
  ) {
    return {
      pass,
      progress,
      remaining,
      aligned: false
    };
  }

  const currentTime =
    now instanceof Date
      ? now
      : new Date(now);
  const endsAt = calculateAlignedPassEnd({
    remainingSeconds:
      remaining?.remainingSeconds ?? 0,
    now: currentTime
  });

  const updatedPass = await requireData(
    serviceClient
      .from("activity_passes")
      .update({
        status: "active",
        ends_at: endsAt.toISOString()
      })
      .eq("owner_user_id", userId)
      .eq("id", pass.id)
      .select("*")
      .single(),
    "activity_clock_pass_update_failed",
    "无法同步活动通行证的实际剩余时间"
  );

  await requireData(
    serviceClient
      .from("home_presence")
      .upsert(
        {
          owner_user_id: userId,
          status: "free_activity",
          status_detail:
            "G 回到客厅继续自由活动",
          source,
          current_activity_pass_id:
            pass.id,
          current_activity_run_id:
            null,
          awake_until: null,
          free_activity_until:
            endsAt.toISOString(),
          heartbeat_paused_until:
            null,
          next_heartbeat_at:
            currentTime.toISOString(),
          metadata: {
            mode:
              "free_activity_running",
            clockAlignedAt:
              currentTime.toISOString(),
            timeAccounting:
              "active_seconds_only"
          }
        },
        {
          onConflict:
            "owner_user_id"
        }
      )
      .select("*")
      .single(),
    "activity_clock_presence_update_failed",
    "活动已经续上，但无法同步全屋状态"
  );

  return {
    pass: updatedPass,
    progress,
    remaining,
    aligned: true,
    endsAt: endsAt.toISOString()
  };
}


export async function resumeFreeActivityWithClock({
  serviceClient,
  orchestrationService,
  userId,
  activityPassId = null,
  source = "activity_clock",
  now = new Date()
}) {
  const result =
    await orchestrationService
      .resumeFreeActivity({
        userId,
        activityPassId,
        now
      });

  return alignPassEndToRemaining({
    serviceClient,
    userId,
    pass: result.pass,
    progress: result.progress,
    remaining: result.remaining,
    source,
    now
  });
}


export async function endInteractionWithClock({
  serviceClient,
  orchestrationService,
  userId,
  channel = null,
  source = "activity_clock",
  postChatGraceMinutes = 15,
  resumeFreeActivity = null,
  now = new Date()
}) {
  const result =
    await orchestrationService
      .endInteraction({
        userId,
        channel,
        source,
        postChatGraceMinutes,
        resumeFreeActivity,
        now
      });

  if (
    result.resumedActivity?.progress
      ?.state !== "running"
  ) {
    return {
      ...result,
      activityClockAligned: false
    };
  }

  const aligned =
    await alignPassEndToRemaining({
      serviceClient,
      userId,
      pass:
        result.resumedActivity.pass,
      progress:
        result.resumedActivity.progress,
      remaining:
        result.resumedActivity.remaining,
      source,
      now
    });

  return {
    ...result,
    resumedActivity: aligned,
    activityClockAligned: true
  };
}
