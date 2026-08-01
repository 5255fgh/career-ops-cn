export const bossSelectors = {
  page: {
    searchListContainers: [
      ".search-job-result",
      ".job-list-box",
      ".job-list-container",
    ],
    companyJobListContainers: [
      ".company-job-list",
      ".company-job-list-wrap",
    ],
    detailContainers: [
      ".job-detail-container",
      ".job-detail-box",
      ".job-detail",
    ],
    loginMarkers: [
      ".login-register-content",
      ".login-form",
      "form[action*='login']",
    ],
    challengeMarkers: [
      ".geetest-panel",
      ".captcha-container",
      "[data-page='challenge']",
    ],
    accountRiskMarkers: [
      ".account-risk",
      ".risk-warning",
      "[data-page='account-risk']",
    ],
  },
  list: {
    cards: [
      ".job-card-wrapper",
      ".job-card-box",
      "li[data-jobid]",
      "article[data-jobid]",
    ],
  },
  card: {
    links: [
      "a.job-card-left",
      ".job-card-body a.job-name",
      "a[href*='/job_detail/']",
    ],
    title: [".job-name", ".job-title", "[data-role='job-title']"],
    company: [
      ".boss-name",
      ".company-name",
      "[data-role='company-name']",
    ],
    salary: [".salary", ".job-salary", "[data-role='salary']"],
    city: [".job-area", ".job-city", "[data-role='city']"],
    experience: [
      ".job-experience",
      ".job-info .tag-list li:nth-child(1)",
      "[data-role='experience']",
    ],
    education: [
      ".job-education",
      ".job-info .tag-list li:nth-child(2)",
      "[data-role='education']",
    ],
    tags: [
      ".job-card-footer .tag-list li",
      ".job-card-body .job-tags li",
      "[data-role='job-tags'] li",
    ],
  },
  detail: {
    links: [
      ".job-banner a[href*='/job_detail/']",
      ".job-detail-header a[href*='/job_detail/']",
      "a[data-role='detail-url']",
    ],
    title: [
      ".job-banner .name",
      ".job-detail-header .job-name",
      "[data-role='job-title']",
    ],
    company: [
      ".job-banner .company-name",
      ".job-detail-header .company-name",
      "[data-role='company-name']",
    ],
    salary: [
      ".job-banner .salary",
      ".job-detail-header .salary",
      "[data-role='salary']",
    ],
    city: [
      ".job-banner .job-area",
      ".job-detail-header .job-area",
      "[data-role='city']",
    ],
    experience: [
      ".job-banner .job-experience",
      ".job-limit li:nth-child(1)",
      "[data-role='experience']",
    ],
    education: [
      ".job-banner .job-education",
      ".job-limit li:nth-child(2)",
      "[data-role='education']",
    ],
    tags: [
      ".job-detail-tags li",
      ".job-banner .tag-list li",
      "[data-role='job-tags'] li",
    ],
    description: [
      ".job-detail-section .job-sec-text",
      ".job-detail-section [data-role='job-description']",
      ".job-description .text",
    ],
  },
  activeCard: [
    ".job-card-wrapper.active",
    ".job-card-box.active",
    "[data-jobid][aria-selected='true']",
  ],
  visibility: {
    hiddenAncestor:
      "[hidden], [aria-hidden='true'], [style*='display: none'], [style*='display:none'], [style*='visibility: hidden'], [style*='visibility:hidden']",
  },
  pageText: {
    login: ["登录后查看", "请先登录", "手机号登录"],
    challenge: ["安全验证", "完成验证", "访问过于频繁"],
    accountRisk: ["账号存在异常", "账号风险", "操作过于频繁"],
  },
} as const;
