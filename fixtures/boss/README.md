# BOSS fixtures

本目录只保存经过脱敏的 BOSS 页面相关 DOM 子树，不包含完整站点资源、Cookie、联系方式或个人信息。

`expectations.json` 记录每个 HTML fixture 的页面类型与阻断预期；解析字段的更细预期由 `packages/boss-adapter/test/boss-adapter.test.ts` 逐项断言。

覆盖范围：搜索列表、独立详情、搜索详情面板、公司职位列表、字段缺失、登录、挑战、账号异常、空页面、未知布局、点击 A 后详情仍为 B、详情内容未变化，以及无 `sourceJobId` 的身份验证。
