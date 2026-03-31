import { describe, expect, it } from "vitest";
import {
  buildRouteRef,
  findProjectByRoute,
  routeKey,
  routeMatchesChannel,
} from "../../lib/projects/routes.js";
import type { ProjectsData } from "../../lib/projects/types.js";

describe("project routes", () => {
  const data: ProjectsData = {
    projects: {
      alpha: {
        slug: "alpha",
        name: "Alpha",
        repo: "/tmp/alpha",
        groupName: "Project: Alpha",
        deployUrl: "",
        baseBranch: "main",
        deployBranch: "main",
        provider: "github",
        channels: [
          {
            channel: "telegram",
            channelId: "-1003709213169",
            messageThreadId: 101,
            name: "primary",
            events: ["*"],
          },
        ],
        workers: {},
      },
      beta: {
        slug: "beta",
        name: "Beta",
        repo: "/tmp/beta",
        groupName: "Project: Beta",
        deployUrl: "",
        baseBranch: "main",
        deployBranch: "main",
        provider: "github",
        channels: [
          {
            channel: "telegram",
            channelId: "-1003709213169",
            messageThreadId: 202,
            name: "primary",
            events: ["*"],
          },
        ],
        workers: {},
      },
    },
  };

  it("distinguishes topics under the same Telegram group", () => {
    const alphaRoute = buildRouteRef({
      channel: "telegram",
      channelId: "-1003709213169",
      messageThreadId: 101,
    });
    const betaRoute = buildRouteRef({
      channel: "telegram",
      channelId: "-1003709213169",
      messageThreadId: 202,
    });

    expect(routeKey(alphaRoute)).not.toBe(routeKey(betaRoute));
    expect(findProjectByRoute(data, alphaRoute)?.slug).toBe("alpha");
    expect(findProjectByRoute(data, betaRoute)?.slug).toBe("beta");
  });

  it("requires the full route tuple for an exact channel match", () => {
    const alphaChannel = data.projects.alpha!.channels[0]!;

    expect(
      routeMatchesChannel({
        channel: "telegram",
        channelId: "-1003709213169",
        messageThreadId: 101,
      }, alphaChannel),
    ).toBe(true);

    expect(
      routeMatchesChannel({
        channel: "telegram",
        channelId: "-1003709213169",
        messageThreadId: 202,
      }, alphaChannel),
    ).toBe(false);
  });

  it("distinguishes routes with the same Telegram chat/topic but different accountId", () => {
    const routeA = buildRouteRef({
      channel: "telegram",
      channelId: "-1003709213169",
      messageThreadId: 101,
      accountId: "acct-a",
    });
    const routeB = buildRouteRef({
      channel: "telegram",
      channelId: "-1003709213169",
      messageThreadId: 101,
      accountId: "acct-b",
    });

    expect(routeKey(routeA)).not.toBe(routeKey(routeB));
  });
});
