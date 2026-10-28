# 发版规则

**发版是用户的决定，不是助手的决定。**

## 硬性要求

改完代码后，**先问，再发**。在用户明确说出「发版」「发布」「release」「publish」「推个版本」之类的话之前，不得执行以下任何一项：

- `npm version`（任何形式，包括 `--no-git-tag-version`）
- `npm publish`
- `git tag`
- `git push --follow-tags` 或任何推送标签的命令
- 删除或移动已存在的标签

普通的 `git commit` + `git push`（不带标签）不受此限制——那只是保存工作，不影响 npm。

## 正确的收尾方式

修完 bug、跑完测试后，应该说：

> 改动已经提交，测试全过。要不要发版？

然后**停下来等回答**。不要用「顺手发了」代替询问，也不要用「反正只是 patch」当理由。

## 为什么

- 版本号是公开承诺。npm 上的版本无法撤回，只能 deprecate。
- `latest` 标签会自动影响所有未锁定版本的安装者。
- 已推送的标签被删除或移动，会影响所有已经拉取过它的人。
- 用户可能想先自己看看、想攒几个改动一起发、或者这轮改动根本不该发布。

## 一次完整的发版

用户说了「发版」之后：

```sh
npm run release patch     # 或 minor / major / 1.2.3
```

脚本会先跑完三套测试，再改版本号、提交、打标签、推送，标签触发 `publish.yml` 发布到 npm 并建 GitHub Release。

## 鉴权

| 场景 | 做法 |
|---|---|
| 首次发布 | 需要 `NPM_TOKEN` secret（包还不存在时无法配置 Trusted Publisher） |
| 之后（推荐） | npmjs.com 上配 Trusted Publisher，然后删掉 `NPM_TOKEN` secret，workflow 自动走 OIDC |
