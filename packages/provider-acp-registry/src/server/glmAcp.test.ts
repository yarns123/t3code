import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { readGlmUsageLimits } from "./glmAcp.ts";

const QUOTA_RESPONSE = {
  code: 200,
  msg: "Operation successful",
  data: {
    limits: [
      {
        type: "CREDIT_LIMIT",
        unit: 3,
        number: 5,
        usage: 12000,
        currentValue: 0,
        remaining: 12000,
        percentage: 0,
      },
      {
        type: "CREDIT_LIMIT",
        unit: 6,
        number: 1,
        usage: 60000,
        currentValue: 1670,
        remaining: 58329,
        percentage: 2,
        nextResetTime: 1793214717984,
      },
    ],
    level: "pro",
  },
  success: true,
};

const quotaServer = (requests: Array<{ url: string; authorization: string | undefined }>) =>
  HttpClient.make((request) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(QUOTA_RESPONSE)));
  });

it.effect("maps Coding Plan credit limits to session and weekly windows", () =>
  Effect.gen(function* () {
    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const limits = yield* readGlmUsageLimits({ environment: { Z_AI_API_KEY: "env-key" } }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({ readFileString: () => Effect.die("unexpected credential read") }),
      ),
      Effect.provideService(HttpClient.HttpClient, quotaServer(requests)),
      Effect.provide(NodeServices.layer),
    );
    NodeAssert.deepEqual(requests, [
      { url: "https://api.z.ai/api/monitor/usage/quota/limit", authorization: "env-key" },
    ]);
    NodeAssert.equal(limits.unavailable, undefined);
    NodeAssert.match(limits.credentialFingerprint ?? "", /^[0-9a-f]{64}$/);
    NodeAssert.deepEqual(
      limits.windows.map(({ kind, usedPercent, resetsAt, windowDurationMins }) => ({
        kind,
        usedPercent,
        resetsAt,
        windowDurationMins,
      })),
      [
        { kind: "session", usedPercent: 0, resetsAt: undefined, windowDurationMins: 300 },
        {
          kind: "weekly",
          usedPercent: (1670 / 60000) * 100,
          resetsAt: DateTime.formatIso(DateTime.makeUnsafe(1793214717984)),
          windowDurationMins: 7 * 24 * 60,
        },
      ],
    );
  }),
);

it.effect("falls back to the agent's stored key and follows the configured region", () =>
  Effect.gen(function* () {
    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const limits = yield* readGlmUsageLimits({
      environment: {
        XDG_CONFIG_HOME: "/instance/config",
        ACP_GLM_BASE_URL: "https://open.bigmodel.cn/api/coding/paas/v4",
      },
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: (path) => {
            NodeAssert.equal(
              path.replaceAll("\\", "/"),
              "/instance/config/glm-acp-agent/credentials.json",
            );
            return Effect.succeed(JSON.stringify({ z_ai_api_key: "stored-key" }));
          },
        }),
      ),
      Effect.provideService(HttpClient.HttpClient, quotaServer(requests)),
      Effect.provide(NodeServices.layer),
    );
    NodeAssert.deepEqual(requests, [
      {
        url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
        authorization: "stored-key",
      },
    ]);
    NodeAssert.equal(limits.windows.length, 2);
  }),
);

it.effect("never sends the key to a custom base URL", () =>
  Effect.gen(function* () {
    const limits = yield* readGlmUsageLimits({
      environment: { Z_AI_API_KEY: "env-key", ACP_GLM_BASE_URL: "https://proxy.example/v4" },
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unexpected usage request")),
      ),
      Effect.provide(NodeServices.layer),
    );
    NodeAssert.equal(limits.unavailable?.reason, "unsupported");
  }),
);
