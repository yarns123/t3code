import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

export const GLM_ACP_AGENT_ID = "glm-acp-agent";

const QUOTA_HOSTS = new Set(["api.z.ai", "open.bigmodel.cn"]);
const Credentials = Schema.Struct({ z_ai_api_key: Schema.optionalKey(Schema.String) });
const decodeCredentials = Schema.decodeOption(Schema.fromJsonString(Credentials));
const Limit = Schema.Struct({
  type: Schema.String,
  unit: Schema.Number,
  number: Schema.Number,
  usage: Schema.optionalKey(Schema.Number),
  currentValue: Schema.optionalKey(Schema.Number),
  percentage: Schema.optionalKey(Schema.Number),
  nextResetTime: Schema.optionalKey(Schema.Number),
});
const QuotaResponse = Schema.Struct({
  data: Schema.Struct({ limits: Schema.Array(Limit) }),
});

// Z.ai encodes window length as `number` of `unit`; 3 = hours, 5 = months, 6 = weeks.
function limitWindow(limit: typeof Limit.Type): ServerProviderUsageWindow | undefined {
  const usedPercent =
    limit.usage && limit.usage > 0 && limit.currentValue !== undefined
      ? (limit.currentValue / limit.usage) * 100
      : limit.percentage;
  if (usedPercent === undefined || !Number.isFinite(usedPercent)) return undefined;
  const reset =
    limit.nextResetTime === undefined ? Option.none() : DateTime.make(limit.nextResetTime);
  const shape =
    limit.unit === 3
      ? limit.number === 5
        ? { kind: "session" as const, label: "5-hour" }
        : { kind: "other" as const, label: `${limit.number}-hour` }
      : limit.unit === 6 && limit.number === 1
        ? { kind: "weekly" as const, label: "Weekly" }
        : limit.unit === 5 && limit.number === 1
          ? { kind: "monthly" as const, label: "Monthly" }
          : { kind: "other" as const, label: "Quota" };
  const windowDurationMins =
    limit.unit === 3
      ? limit.number * 60
      : limit.unit === 6
        ? limit.number * 7 * 24 * 60
        : undefined;
  return {
    id: `${limit.type.toLowerCase()}_${limit.unit}_${limit.number}`,
    kind: shape.kind,
    label: limit.type === "TIME_LIMIT" ? `Tools · ${shape.label}` : shape.label,
    usedPercent: clampPercent(usedPercent),
    ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
  };
}

/** Mirrors glm-acp-agent's key lookup: `Z_AI_API_KEY`, then its `--setup` credentials file. */
export const readGlmUsageLimits = Effect.fn("readGlmUsageLimits")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const env = input.environment;
  const origin = URL.parse(env.ACP_GLM_BASE_URL?.trim() || "https://api.z.ai");
  if (!origin || !QUOTA_HOSTS.has(origin.hostname)) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }

  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let apiKey = env.Z_AI_API_KEY?.trim();
    if (!apiKey) {
      const configHome =
        env.XDG_CONFIG_HOME ||
        path.join(env.HOME || env.USERPROFILE || (yield* HostProcess.HomeDirectory), ".config");
      const contents = yield* fs
        .readFileString(path.join(configHome, "glm-acp-agent", "credentials.json"))
        .pipe(Effect.orElseSucceed(() => ""));
      apiKey = Option.getOrUndefined(decodeCredentials(contents))?.z_ai_api_key?.trim();
    }
    if (!apiKey) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Set Z_AI_API_KEY to see GLM Coding Plan limits.",
      });
    }

    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const body = yield* client
      .execute(
        HttpClientRequest.get(`${origin.origin}/api/monitor/usage/quota/limit`).pipe(
          HttpClientRequest.setHeaders({ Authorization: apiKey }),
        ),
      )
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(QuotaResponse)));
    const windows = body.data.limits.flatMap((limit) => limitWindow(limit) ?? []);
    if (windows.length === 0) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "GLM did not return usable quota information.",
      });
    }
    const crypto = yield* Crypto.Crypto;
    const credentialFingerprint = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(`glm-coding-plan\0${apiKey}`))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
    return { ...makeUsageLimits({ checkedAt, windows }), credentialFingerprint };
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Could not read GLM Coding Plan limits.",
      }),
    ),
  );
});
