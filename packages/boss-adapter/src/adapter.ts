import { bossSelectors } from "./selectors.js";
import type {
  BossCardElementMatch,
  BossIdentitySignal,
  BossIdentityVerification,
  BossJobCard,
  BossJobDetail,
  BossJobIdentity,
  BossPageBlock,
  BossPageType,
  VerifyDetailIdentityInput,
} from "./types.js";

type QueryRoot = Document | Element;

const normalizeText = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 0 ? normalized : null;
};
const queryFirst = (
  root: QueryRoot,
  selectors: readonly string[],
): Element | null => {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    if (element !== null) {
      return element;
    }
  }

  return null;
};

const queryAllByPriority = (
  root: QueryRoot,
  selectors: readonly string[],
): Element[] => {
  for (const selector of selectors) {
    const elements = [...root.querySelectorAll(selector)];
    if (elements.length > 0) {
      return elements;
    }
  }

  return [];
};

const readText = (
  root: QueryRoot,
  selectors: readonly string[],
): string | null => {
  for (const selector of selectors) {
    const value = normalizeText(root.querySelector(selector)?.textContent);
    if (value !== null) {
      return value;
    }
  }

  return null;
};

const readTexts = (
  root: QueryRoot,
  selectors: readonly string[],
): string[] => {
  for (const selector of selectors) {
    const values = [...root.querySelectorAll(selector)]
      .map((element) => normalizeText(element.textContent))
      .filter((value): value is string => value !== null);
    if (values.length > 0) {
      return [...new Set(values)];
    }
  }

  return [];
};

const queryFirstWithAttribute = (
  root: QueryRoot,
  selectors: readonly string[],
  attribute: string,
): Element | null => {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    if (normalizeText(element?.getAttribute(attribute)) !== null) {
      return element;
    }
  }

  return null;
};

const hasAny = (root: QueryRoot, selectors: readonly string[]): boolean =>
  queryFirst(root, selectors) !== null;

const hasAnyText = (text: string, candidates: readonly string[]): boolean =>
  candidates.some((candidate) => text.includes(candidate));

const normalizeUrl = (value: string | null, baseUrl: string): string | null => {
  if (value === null) {
    return null;
  }

  try {
    const parsed = new URL(value, baseUrl);
    const hostname = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== "https:" ||
      (hostname !== "zhipin.com" && !hostname.endsWith(".zhipin.com"))
    ) {
      return null;
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
};

export const sourceJobIdFromUrl = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }

  try {
    const match = new URL(value).pathname.match(/\/job_detail\/([^./?#]+)/u);
    return normalizeText(match?.[1]);
  } catch {
    return null;
  }
};

const readSourceJobId = (
  root: Element,
  link: Element | null,
  resolvedUrl: string | null,
): string | null => {
  for (const element of [root, link]) {
    if (element === null) {
      continue;
    }

    for (const attribute of ["data-jobid", "data-job-id"]) {
      const value = normalizeText(element.getAttribute(attribute));
      if (value !== null) {
        return value;
      }
    }
  }

  return sourceJobIdFromUrl(resolvedUrl);
};

const isElementVisible = (element: Element): boolean =>
  element.closest(bossSelectors.visibility.hiddenAncestor) === null;

const parseCardElement = (element: Element, pageUrl: string): BossJobCard => {
  const link = queryFirstWithAttribute(
    element,
    bossSelectors.card.links,
    "href",
  );
  const url = normalizeUrl(link?.getAttribute("href") ?? null, pageUrl);

  return {
    sourceJobId: readSourceJobId(element, link, url),
    url,
    title: readText(element, bossSelectors.card.title),
    company: readText(element, bossSelectors.card.company),
    salaryRaw: readText(element, bossSelectors.card.salary),
    city: readText(element, bossSelectors.card.city),
    experience: readText(element, bossSelectors.card.experience),
    education: readText(element, bossSelectors.card.education),
    tags: readTexts(element, bossSelectors.card.tags),
  };
};

const isEmptyPage = (document: Document): boolean => {
  const body = document.body;
  if (body === null) {
    return true;
  }

  return normalizeText(body.textContent) === null && body.children.length === 0;
};

export const detectBossPage = (
  document: Document,
  url: string,
): BossPageType => {
  const pageText = normalizeText(document.body?.textContent) ?? "";
  const hasSearchList = hasAny(
    document,
    bossSelectors.page.searchListContainers,
  );
  const hasCompanyList = hasAny(
    document,
    bossSelectors.page.companyJobListContainers,
  );
  const hasDetail = hasAny(document, bossSelectors.page.detailContainers);

  if (
    /captcha|challenge|verify/iu.test(url) ||
    hasAny(document, bossSelectors.page.challengeMarkers) ||
    hasAnyText(pageText, bossSelectors.pageText.challenge)
  ) {
    return "challenge";
  }

  if (/\/web\/user|\/login/iu.test(url)) {
    return "login";
  }

  if (/\/gongsi\/job|\/company\/.*\/jobs/iu.test(url) || hasCompanyList) {
    return "company-job-list";
  }

  if (hasSearchList && hasDetail) {
    return "search-detail-panel";
  }

  if (/\/job_detail\//iu.test(url) && hasDetail) {
    return "job-detail";
  }

  if (hasSearchList) {
    return "search-list";
  }

  if (
    hasAny(document, bossSelectors.page.loginMarkers) ||
    hasAnyText(pageText, bossSelectors.pageText.login)
  ) {
    return "login";
  }

  return "unsupported";
};

export const normalizeBossDetailUrl = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }

  const normalized = normalizeUrl(value, value);
  if (normalized === null) {
    return null;
  }

  const parsed = new URL(normalized);
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
  return parsed.toString();
};

export const detectBossPageBlock = (
  document: Document,
  url: string,
): BossPageBlock | null => {
  const pageType = detectBossPage(document, url);
  const pageText = normalizeText(document.body?.textContent) ?? "";

  if (pageType === "challenge") {
    return { reason: "challenge", pageType };
  }

  if (
    hasAny(document, bossSelectors.page.accountRiskMarkers) ||
    hasAnyText(pageText, bossSelectors.pageText.accountRisk)
  ) {
    return { reason: "account_risk", pageType: "unsupported" };
  }

  if (pageType === "login") {
    return { reason: "login_required", pageType };
  }

  if (isEmptyPage(document)) {
    return { reason: "empty_page", pageType: "unsupported" };
  }

  if (pageType === "unsupported") {
    return { reason: "unsupported_layout", pageType };
  }

  return null;
};

export const parseVisibleBossCards = (
  document: Document,
  url: string,
): BossJobCard[] => {
  return visibleCardElements(document).map((card) => parseCardElement(card, url));
};

const visibleCardElements = (document: Document): Element[] => {
  const containers = [
    ...queryAllByPriority(document, bossSelectors.page.searchListContainers),
    ...queryAllByPriority(
      document,
      bossSelectors.page.companyJobListContainers,
    ),
  ];
  const cards: Element[] = [];
  const seen = new Set<Element>();

  for (const container of containers) {
    for (const card of queryAllByPriority(container, bossSelectors.list.cards)) {
      if (!seen.has(card) && isElementVisible(card)) {
        seen.add(card);
        cards.push(card);
      }
    }
  }

  return cards;
};

export const parseBossDetail = (
  document: Document,
  url: string,
): BossJobDetail | null => {
  const container = queryFirst(document, bossSelectors.page.detailContainers);
  if (container === null) {
    return null;
  }

  const link = queryFirstWithAttribute(
    container,
    bossSelectors.detail.links,
    "href",
  );
  const pageDetailUrl = /\/job_detail\//iu.test(url) ? url : null;
  const fieldRoot: QueryRoot = pageDetailUrl === null ? container : document;
  const detailUrl = normalizeUrl(
    link?.getAttribute("href") ?? pageDetailUrl,
    url,
  );
  const detail: BossJobDetail = {
    sourceJobId: readSourceJobId(container, link, detailUrl),
    url: detailUrl,
    title: readText(fieldRoot, bossSelectors.detail.title),
    company: readText(fieldRoot, bossSelectors.detail.company),
    salaryRaw: readText(fieldRoot, bossSelectors.detail.salary),
    city: readText(fieldRoot, bossSelectors.detail.city),
    experience: readText(fieldRoot, bossSelectors.detail.experience),
    education: readText(fieldRoot, bossSelectors.detail.education),
    tags: readTexts(fieldRoot, bossSelectors.detail.tags),
    description: readText(fieldRoot, bossSelectors.detail.description),
    capturedAt: new Date().toISOString(),
    warnings: [],
  };

  const requiredFields: ReadonlyArray<
    readonly [keyof BossJobDetail, string]
  > = [
    ["sourceJobId", "missing_source_job_id"],
    ["url", "missing_url"],
    ["title", "missing_title"],
    ["company", "missing_company"],
    ["salaryRaw", "missing_salary"],
    ["city", "missing_city"],
    ["experience", "missing_experience"],
    ["education", "missing_education"],
    ["description", "missing_description"],
  ];

  for (const [field, warning] of requiredFields) {
    if (detail[field] === null) {
      detail.warnings.push(warning);
    }
  }

  return detail;
};

const hashText = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
};

const detailHash = (detail: BossJobDetail): string =>
  hashText(
    [
      detail.sourceJobId,
      detail.url,
      detail.title,
      detail.company,
      detail.salaryRaw,
      detail.city,
      detail.experience,
      detail.education,
      detail.tags.join("\u001f"),
      detail.description,
    ]
      .map((value) => value ?? "")
      .join("\u001e"),
  );

const identityUrlMatches = (
  expected: BossJobIdentity,
  actual: BossJobIdentity,
): boolean | null => {
  const jobIdMatch =
    expected.sourceJobId !== null && actual.sourceJobId !== null
      ? expected.sourceJobId === actual.sourceJobId
      : null;

  let urlMatch: boolean | null = null;
  if (expected.url !== null && actual.url !== null) {
    const expectedUrl = normalizeBossDetailUrl(expected.url);
    const actualUrl = normalizeBossDetailUrl(actual.url);
    if (expectedUrl !== null && actualUrl !== null) {
      urlMatch = expectedUrl === actualUrl;
    }
  }

  if (jobIdMatch === true || urlMatch === true) {
    return true;
  }
  if (jobIdMatch === false || urlMatch === false) {
    return false;
  }
  return null;
};

const normalizeIdentityText = (
  value: string | null | undefined,
): string | null => {
  const text = normalizeText(value);
  if (text === null) {
    return null;
  }

  const normalized = text
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}\p{White_Space}]+/gu, "");
  return normalized.length > 0 ? normalized : null;
};

const relaxedTextMatches = (
  expected: string | null | undefined,
  actual: string | null | undefined,
): boolean | null => {
  const expectedText = normalizeIdentityText(expected);
  const actualText = normalizeIdentityText(actual);
  if (expectedText === null || actualText === null) {
    return null;
  }

  if (expectedText === actualText) {
    return true;
  }

  const shorter =
    expectedText.length <= actualText.length ? expectedText : actualText;
  const longer = shorter === expectedText ? actualText : expectedText;
  return shorter.length >= 3 && longer.includes(shorter);
};

const titleMatches = (
  expected: BossJobIdentity,
  actual: BossJobIdentity,
): boolean | null => {
  return relaxedTextMatches(expected.title, actual.title);
};

const companyMatches = (
  expected: BossJobIdentity,
  actual: BossJobIdentity,
): boolean | null => relaxedTextMatches(expected.company, actual.company);

export const findBossJobCardElement = (
  document: Document,
  url: string,
  expected: BossJobIdentity,
): BossCardElementMatch | null => {
  const candidates = visibleCardElements(document).map((element) => ({
    element,
    card: parseCardElement(element, url),
  }));

  if (expected.sourceJobId !== null) {
    const match = candidates.find(
      ({ card }) => card.sourceJobId === expected.sourceJobId,
    );
    if (match !== undefined) {
      return { ...match, matchedBy: "source_job_id" };
    }
  }

  const expectedUrl = normalizeBossDetailUrl(expected.url);
  if (expectedUrl !== null) {
    const match = candidates.find(
      ({ card }) => normalizeBossDetailUrl(card.url) === expectedUrl,
    );
    if (match !== undefined) {
      return { ...match, matchedBy: "detail_url" };
    }
  }

  const match = candidates.find(
    ({ card }) =>
      titleMatches(expected, card) === true &&
      companyMatches(expected, card) === true,
  );
  return match === undefined
    ? null
    : { ...match, matchedBy: "title_company" };
};

const activeCardMatches = (
  expected: BossJobIdentity,
  activeCard: BossJobCard | null | undefined,
): boolean | null => {
  if (activeCard === null || activeCard === undefined) {
    return null;
  }

  const identityMatch = identityUrlMatches(expected, activeCard);
  if (identityMatch !== null) {
    return identityMatch;
  }

  const titleMatch = titleMatches(expected, activeCard);
  const companyMatch = companyMatches(expected, activeCard);
  if (titleMatch === true && (companyMatch === true || companyMatch === null)) {
    return true;
  }
  if (companyMatch === true && titleMatch === null) {
    return true;
  }
  return titleMatch === false || companyMatch === false ? false : null;
};

export const verifyDetailIdentity = (
  input: VerifyDetailIdentityInput,
): BossIdentityVerification => {
  const currentDetailHash = detailHash(input.detail);
  const previousHash =
    input.previousDetailHash ??
    (input.previousDetail === null || input.previousDetail === undefined
      ? null
      : detailHash(input.previousDetail));
  const signals = {
    jobIdentity: identityUrlMatches(input.expected, input.detail),
    title: titleMatches(input.expected, input.detail),
    company: companyMatches(input.expected, input.detail),
    activeCard: activeCardMatches(input.expected, input.activeCard),
    contentChanged:
      previousHash === null ? null : previousHash !== currentDetailHash,
  };
  const signalEntries: ReadonlyArray<
    readonly [BossIdentitySignal, boolean | null]
  > = [
    ["job_identity", signals.jobIdentity],
    ["title", signals.title],
    ["company", signals.company],
    ["active_card", signals.activeCard],
    ["content_changed", signals.contentChanged],
  ];
  const matchedSignals = signalEntries
    .filter((entry) => entry[1] === true)
    .map((entry) => entry[0]);

  const fallbackVerified =
    signals.jobIdentity === null &&
    ((signals.title === true && signals.company === true) ||
      (signals.title === true && signals.activeCard === true));

  return {
    verified: signals.jobIdentity === true || fallbackVerified,
    signals,
    matchedSignals,
    detailHash: currentDetailHash,
  };
};

const authoritativeJobId = (
  identity: BossJobIdentity,
): { value: string | null; conflict: boolean } => {
  const sourceJobId = normalizeText(identity.sourceJobId);
  const urlJobId = sourceJobIdFromUrl(identity.url);
  return {
    value: sourceJobId ?? urlJobId,
    conflict:
      sourceJobId !== null && urlJobId !== null && sourceJobId !== urlJobId,
  };
};

export const verifyStrictDetailIdentity = (
  input: VerifyDetailIdentityInput,
): BossIdentityVerification => {
  const expectedJobId = authoritativeJobId(input.expected);
  const actualJobId = authoritativeJobId(input.detail);
  const jobIdentity =
    expectedJobId.conflict || actualJobId.conflict
      ? false
      : expectedJobId.value === null || actualJobId.value === null
        ? null
        : expectedJobId.value === actualJobId.value;
  const title = titleMatches(input.expected, input.detail);
  const company = companyMatches(input.expected, input.detail);
  const signals = {
    jobIdentity,
    title,
    company,
    activeCard: null,
    contentChanged: null,
  };
  const matchedSignals: BossIdentitySignal[] = [];
  if (jobIdentity === true) {
    matchedSignals.push("job_identity");
  }
  if (title === true) {
    matchedSignals.push("title");
  }
  if (company === true) {
    matchedSignals.push("company");
  }

  return {
    verified: jobIdentity === true && title !== false && company !== false,
    signals,
    matchedSignals,
    detailHash: detailHash(input.detail),
  };
};
