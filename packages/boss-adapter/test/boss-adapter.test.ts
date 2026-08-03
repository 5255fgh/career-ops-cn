import { readFileSync } from "node:fs";

import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bossSelectors,
  detectBossPage,
  detectBossPageBlock,
  findBossJobCardElement,
  parseBossDetail,
  parseVisibleBossCards,
  scanSelectedBossDetails,
  sourceJobIdFromUrl,
  verifyDetailIdentity,
  waitForBossDetail,
} from "../src/index.js";
import type {
  BossJobIdentity,
  BossPageBlockReason,
  BossPageType,
} from "../src/index.js";

const fixtureUrl = (filename: string): URL =>
  new URL(`../../../fixtures/boss/${filename}`, import.meta.url);

const readFixture = (filename: string): string =>
  readFileSync(fixtureUrl(filename), "utf8");

const createDocument = (
  filename: string,
  url: string,
): { window: Window; document: Document } => {
  const window = new Window({ url });
  window.document.write(readFixture(filename));
  window.document.close();
  return { window, document: window.document as unknown as Document };
};

const fixtureUrls: Record<string, string> = {
  "search-list.html": "https://www.zhipin.com/web/geek/job?query=typescript",
  "list-minimal-card.html":
    "https://www.zhipin.com/web/geek/job?query=frontend",
  "job-detail.html": "https://www.zhipin.com/job_detail/boss-2001.html",
  "job-detail-standalone.html":
    "https://www.zhipin.com/job_detail/standalone-2002.html",
  "search-detail-panel.html":
    "https://www.zhipin.com/web/geek/job?query=frontend",
  "company-job-list.html": "https://www.zhipin.com/gongsi/job/example.html",
  "missing-fields.html": "https://www.zhipin.com/job_detail/boss-5001.html",
  "login.html": "https://www.zhipin.com/web/user/?ka=header-login",
  "challenge.html": "https://www.zhipin.com/web/common/challenge",
  "account-risk.html": "https://www.zhipin.com/web/geek/job",
  "empty-page.html": "https://www.zhipin.com/web/geek/job",
  "fetch-detail-shell.html":
    "https://www.zhipin.com/job_detail/boss-shell.html",
  "unknown-layout.html": "https://www.zhipin.com/other",
  "stale-detail-b.html": "https://www.zhipin.com/web/geek/job",
  "detail-unchanged.html": "https://www.zhipin.com/web/geek/job",
  "no-source-id.html": "https://www.zhipin.com/web/geek/job",
};

const expectations = JSON.parse(readFixture("expectations.json")) as Record<
  string,
  { pageType: BossPageType; block: BossPageBlockReason | null }
>;

afterEach(() => {
  vi.useRealTimers();
});

describe("fixture 页面识别和阻断", () => {
  for (const [filename, expected] of Object.entries(expectations)) {
    it(`${filename} 符合页面与阻断预期`, () => {
      const url = fixtureUrls[filename];
      if (url === undefined) {
        throw new Error(`fixture 缺少 URL: ${filename}`);
      }
      const { window, document } = createDocument(filename, url);

      expect(detectBossPage(document, url)).toBe(expected.pageType);
      expect(detectBossPageBlock(document, url)?.reason ?? null).toBe(
        expected.block,
      );
      window.close();
    });
  }
});

describe("列表解析", () => {
  it("提取可见搜索卡片并过滤隐藏卡片", () => {
    const url = fixtureUrls["search-list.html"]!;
    const { window, document } = createDocument("search-list.html", url);

    expect(parseVisibleBossCards(document, url)).toEqual([
      {
        sourceJobId: "boss-1001",
        url: "https://www.zhipin.com/job_detail/boss-1001.html",
        title: "前端开发工程师",
        company: "示例甲科技",
        salaryRaw: "20-30K·14薪",
        city: "上海·浦东新区",
        experience: "3-5年",
        education: "本科",
        tags: ["TypeScript", "React"],
      },
      {
        sourceJobId: "boss-1002",
        url: "https://www.zhipin.com/job_detail/boss-1002.html",
        title: "Node.js 开发工程师",
        company: "示例乙网络",
        salaryRaw: "18-28K",
        city: "北京·海淀区",
        experience: "1-3年",
        education: "本科",
        tags: ["Node.js"],
      },
    ]);
    window.close();
  });

  it("解析公司职位列表", () => {
    const url = fixtureUrls["company-job-list.html"]!;
    const { window, document } = createDocument("company-job-list.html", url);

    expect(parseVisibleBossCards(document, url)).toHaveLength(1);
    expect(parseVisibleBossCards(document, url)[0]?.sourceJobId).toBe(
      "boss-4001",
    );
    window.close();
  });
});

describe("详情解析", () => {
  it("提取独立详情字段、时间与空 warnings", () => {
    const url = fixtureUrls["job-detail.html"]!;
    const { window, document } = createDocument("job-detail.html", url);
    const detail = parseBossDetail(document, url);

    expect(detail).toMatchObject({
      sourceJobId: "boss-2001",
      url: "https://www.zhipin.com/job_detail/boss-2001.html",
      title: "高级前端工程师",
      company: "示例丙软件",
      salaryRaw: "25-35K·15薪",
      city: "深圳·南山区",
      experience: "5-10年",
      education: "本科",
      tags: ["Vue", "TypeScript"],
      description: "负责复杂业务前端架构与核心功能开发。",
      warnings: [],
    });
    expect(Number.isNaN(Date.parse(detail?.capturedAt ?? ""))).toBe(false);
    window.close();
  });

  it("提取搜索页详情面板", () => {
    const url = fixtureUrls["search-detail-panel.html"]!;
    const { window, document } = createDocument(
      "search-detail-panel.html",
      url,
    );

    expect(parseBossDetail(document, url)).toMatchObject({
      sourceJobId: "boss-3001",
      title: "Web 前端工程师",
      description: "负责 Web 产品研发与维护。",
    });
    window.close();
  });

  it("字段缺失返回 null 和 warning，不抛无关异常", () => {
    const url = fixtureUrls["missing-fields.html"]!;
    const { window, document } = createDocument("missing-fields.html", url);
    const detail = parseBossDetail(document, url);

    expect(detail?.company).toBeNull();
    expect(detail?.salaryRaw).toBeNull();
    expect(detail?.warnings).toEqual(
      expect.arrayContaining([
        "missing_company",
        "missing_salary",
        "missing_city",
        "missing_experience",
        "missing_education",
      ]),
    );
    window.close();
  });
});

describe("详情身份校验", () => {
  it("直接详情页可由页面 URL 身份和标题完成验证", () => {
    const url = fixtureUrls["job-detail.html"]!;
    const { window, document } = createDocument("job-detail.html", url);
    const detail = parseBossDetail(document, url)!;

    const result = verifyDetailIdentity({
      expected: {
        sourceJobId: sourceJobIdFromUrl(url),
        url,
        title: detail.title,
      },
      detail,
    });

    expect(result.verified).toBe(true);
    expect(result.matchedSignals).toEqual(["job_identity", "title"]);
    window.close();
  });

  it("分页 Selector 能识别真实 fixture 中的下一页入口", () => {
    const url = fixtureUrls["search-list.html"]!;
    const { window, document } = createDocument("search-list.html", url);

    expect(
      bossSelectors.pagination.next.some(
        (selector) => document.querySelector(selector) !== null,
      ),
    ).toBe(true);
    window.close();
  });

  it("列表卡片只要 ID、标题、公司和详情 URL 即可进入后续流程", () => {
    const url = fixtureUrls["list-minimal-card.html"]!;
    const { window, document } = createDocument("list-minimal-card.html", url);

    expect(parseVisibleBossCards(document, url)).toEqual([
      {
        sourceJobId: "boss-minimal-1",
        url: "https://www.zhipin.com/job_detail/boss-minimal-1.html?ka=search_list_1",
        title: "前端工程师（React）",
        company: "示例轻量科技",
        salaryRaw: null,
        city: null,
        experience: null,
        education: null,
        tags: [],
      },
    ]);
    window.close();
  });

  it("独立详情页从全页读取 banner 与详情正文", () => {
    const url = fixtureUrls["job-detail-standalone.html"]!;
    const { window, document } = createDocument(
      "job-detail-standalone.html",
      url,
    );

    expect(parseBossDetail(document, url)).toMatchObject({
      sourceJobId: "standalone-2002",
      title: "桌面运维工程师",
      company: "示例运维公司",
      salaryRaw: "5-6K",
      city: "苏州",
      description: "负责桌面设备、操作系统与办公网络运维。",
    });
    window.close();
  });

  it("sourceJobId 冲突但标准化详情 URL 一致时仍可直接确认", () => {
    const url = fixtureUrls["job-detail.html"]!;
    const { window, document } = createDocument("job-detail.html", url);
    const detail = {
      ...parseBossDetail(document, url)!,
      sourceJobId: "boss-other",
    };

    const result = verifyDetailIdentity({
      expected: {
        sourceJobId: sourceJobIdFromUrl(url),
        url,
        title: detail.title,
      },
      detail,
    });

    expect(result.verified).toBe(true);
    expect(result.signals.jobIdentity).toBe(true);
    expect(result.matchedSignals).toEqual(["job_identity", "title"]);
    window.close();
  });

  it("标准化详情 URL 一致时可直接确认身份", () => {
    const url = fixtureUrls["job-detail.html"]!;
    const { window, document } = createDocument("job-detail.html", url);
    const detail = {
      ...parseBossDetail(document, url)!,
      sourceJobId: null,
      url: `${url}?ka=detail#description`,
    };

    const result = verifyDetailIdentity({
      expected: {
        sourceJobId: null,
        url: `${url}?ka=search_list_1`,
        title: "完全不同的标题",
        company: "完全不同的公司",
      },
      detail,
    });

    expect(result.verified).toBe(true);
    expect(result.signals.jobIdentity).toBe(true);
    window.close();
  });

  it("没有强身份信号时允许标题后缀、空格和标点差异，并结合公司判断", () => {
    const url = fixtureUrls["no-source-id.html"]!;
    const { window, document } = createDocument("no-source-id.html", url);
    const detail = parseBossDetail(document, url)!;

    const result = verifyDetailIdentity({
      expected: {
        sourceJobId: null,
        url: null,
        title: "无编号 前端职位（急聘）",
        company: detail.company,
      },
      detail,
    });

    expect(result.verified).toBe(true);
    expect(result.signals).toMatchObject({ title: true, company: true });
    window.close();
  });

  it("点击 A 但详情仍为 B 时失败", () => {
    const url = fixtureUrls["stale-detail-b.html"]!;
    const { window, document } = createDocument("stale-detail-b.html", url);
    const detail = parseBossDetail(document, url)!;
    const activeCard = parseVisibleBossCards(document, url)[0]!;

    const result = verifyDetailIdentity({
      expected: {
        sourceJobId: "boss-a",
        url: "https://www.zhipin.com/job_detail/boss-a.html",
        title: "职位 A",
      },
      detail,
      activeCard,
      previousDetail: detail,
    });

    expect(result.verified).toBe(false);
    expect(result.matchedSignals).toEqual(["active_card"]);
    window.close();
  });

  it("无 sourceJobId 时可由标题和 active card 两个信号验证", () => {
    const url = fixtureUrls["no-source-id.html"]!;
    const { window, document } = createDocument("no-source-id.html", url);
    const detail = parseBossDetail(document, url)!;
    const activeCard = parseVisibleBossCards(document, url)[0]!;

    const result = verifyDetailIdentity({
      expected: { sourceJobId: null, url: null, title: "无编号前端职位" },
      detail,
      activeCard,
    });

    expect(detail.sourceJobId).toBeNull();
    expect(result.verified).toBe(true);
    expect(result.matchedSignals).toEqual(["title", "active_card"]);
    window.close();
  });
});

describe("等待与批量扫描", () => {
  const expectedA: BossJobIdentity = {
    sourceJobId: "boss-a",
    url: "https://www.zhipin.com/job_detail/boss-a.html",
    title: "职位 A",
  };

  it("详情内容未变化时等待到可预测 timeout", async () => {
    vi.useFakeTimers();
    const url = fixtureUrls["detail-unchanged.html"]!;
    const { window, document } = createDocument("detail-unchanged.html", url);
    const previousDetail = parseBossDetail(document, url)!;
    let settled = false;
    const pending = waitForBossDetail({
      document,
      url,
      expected: expectedA,
      previousDetail,
      timeoutMs: 250,
    }).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(249);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ status: "timeout" });
    window.close();
  });

  it("MutationObserver 在详情变化并满足 predicate 后返回 verified", async () => {
    const url = fixtureUrls["detail-unchanged.html"]!;
    const { window, document } = createDocument("detail-unchanged.html", url);
    const previousDetail = parseBossDetail(document, url)!;
    const pending = waitForBossDetail({
      document,
      url,
      expected: expectedA,
      previousDetail,
      timeoutMs: 1_000,
      predicate: ({ detail }) => detail.description === "已经更新的职位 A 详情。",
    });

    document.getElementById("unchanged-description")!.textContent =
      "已经更新的职位 A 详情。";

    await expect(pending).resolves.toMatchObject({
      status: "verified",
      detail: { description: "已经更新的职位 A 详情。" },
    });
    window.close();
  });

  it("AbortSignal 可以中断等待", async () => {
    const url = fixtureUrls["detail-unchanged.html"]!;
    const { window, document } = createDocument("detail-unchanged.html", url);
    const controller = new AbortController();
    const pending = waitForBossDetail({
      document,
      url,
      expected: expectedA,
      previousDetail: parseBossDetail(document, url),
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    controller.abort();
    await expect(pending).resolves.toEqual({ status: "aborted" });
    window.close();
  });

  it.each([
    ["challenge.html", "challenge"],
    ["account-risk.html", "account_risk"],
  ] as const)("%s 命中后立即返回阻断结果", async (filename, reason) => {
    const url = fixtureUrls[filename]!;
    const { window, document } = createDocument(filename, url);

    await expect(
      waitForBossDetail({
        document,
        url,
        expected: expectedA,
        timeoutMs: 10_000,
      }),
    ).resolves.toMatchObject({ status: "blocked", block: { reason } });
    window.close();
  });

  it("空 selections 扫描也会返回挑战阻断", async () => {
    const filename = "challenge.html";
    const url = fixtureUrls[filename]!;
    const { window, document } = createDocument(filename, url);

    await expect(
      scanSelectedBossDetails({ document, url, selections: [] }),
    ).resolves.toMatchObject({
      entries: [],
      details: [],
      block: { reason: "challenge" },
    });
    window.close();
  });

  it("扫描选中卡片时只收集完成身份校验的详情", async () => {
    const url = fixtureUrls["search-detail-panel.html"]!;
    const { window, document } = createDocument(
      "search-detail-panel.html",
      url,
    );
    const cardB = document.getElementById("panel-card-b")!;
    const cardBLink = cardB.querySelector("a.job-card-left")!;
    const linkClicked = vi.fn();
    cardBLink.addEventListener("click", linkClicked);
    cardB.addEventListener("click", () => {
      document
        .getElementById("panel-detail")!
        .setAttribute("data-jobid", "boss-3002");
      document
        .getElementById("panel-detail-link")!
        .setAttribute("href", "/job_detail/boss-3002.html");
      document.getElementById("panel-detail-title")!.textContent = "全栈工程师";
      document.getElementById("panel-detail-company")!.textContent =
        "示例戊科技";
      document.getElementById("panel-description")!.textContent =
        "负责全栈产品研发。";
    });

    const result = await scanSelectedBossDetails({
      document,
      url,
      selections: [{ element: cardB }],
      timeoutMs: 1_000,
    });

    expect(linkClicked).toHaveBeenCalledOnce();
    expect(result.block).toBeNull();
    expect(result.entries[0]?.result.status).toBe("verified");
    expect(result.details).toHaveLength(1);
    expect(result.details[0]).toMatchObject({
      sourceJobId: "boss-3002",
      title: "全栈工程师",
      description: "负责全栈产品研发。",
    });
    window.close();
  });

  it("目标卡片的详情已加载时直接验证且不重复点击", async () => {
    const url = fixtureUrls["search-detail-panel.html"]!;
    const { window, document } = createDocument(
      "search-detail-panel.html",
      url,
    );
    const cardA = document.getElementById("panel-card-a")!;
    const clicked = vi.fn();
    cardA.addEventListener("click", clicked);

    const result = await scanSelectedBossDetails({
      document,
      url,
      selections: [{ element: cardA }],
      timeoutMs: 1_000,
    });

    expect(clicked).not.toHaveBeenCalled();
    expect(result.block).toBeNull();
    expect(result.entries[0]?.result.status).toBe("verified");
    expect(result.details[0]).toMatchObject({
      sourceJobId: "boss-3001",
      title: "Web 前端工程师",
      description: "负责 Web 产品研发与维护。",
    });
    window.close();
  });

  it("按 Job ID、标准化 URL、标题与公司依次定位卡片，不依赖 index", () => {
    const url = fixtureUrls["search-detail-panel.html"]!;
    const { window, document } = createDocument(
      "search-detail-panel.html",
      url,
    );

    const byId = findBossJobCardElement(document, url, {
      sourceJobId: "boss-3002",
      url: "https://www.zhipin.com/job_detail/wrong.html",
      title: "错误标题",
      company: "错误公司",
    });
    const byUrl = findBossJobCardElement(document, url, {
      sourceJobId: null,
      url: "https://www.zhipin.com/job_detail/boss-3001.html?securityId=redacted",
      title: "错误标题",
      company: "错误公司",
    });
    const byText = findBossJobCardElement(document, url, {
      sourceJobId: null,
      url: null,
      title: "全栈工程师",
      company: "示例戊科技",
    });

    expect(byId).toMatchObject({
      matchedBy: "source_job_id",
      card: { sourceJobId: "boss-3002" },
    });
    expect(byUrl).toMatchObject({
      matchedBy: "detail_url",
      card: { sourceJobId: "boss-3001" },
    });
    expect(byText).toMatchObject({
      matchedBy: "title_company",
      card: { sourceJobId: "boss-3002" },
    });
    window.close();
  });
});
