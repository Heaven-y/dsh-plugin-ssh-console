# 给 AI 协作者的项目规则

人读的文档是 [README.md](README.md)，发版纪律是 [RELEASING.md](RELEASING.md)——那些不要在这里复述。这里只写**不写下来就一定会重复踩**的坑。

## 这是个两半的插件

`index.js` 跑在 Node（Host），`client.js` 跑在浏览器（Client），中间隔着一个 Remote 网关。三条硬规则：

1. **Host 加了方法、Client 调它，不算做完。** 还必须在 Client 的 `$mount` 里加对应 descriptor，否则运行时才炸 `SSH service has no method "xxx"`。`test/client.test.mjs` 第 3 项会读 Host 的 `REMOTE_METHODS` 对账并扫描所有 `call('name', …)` 站点——改方法列表后先跑它。
2. **每个 Remote 方法只能有一个参数**，名字恒为 `input`。网关会校验参数个数和 wire 名。
3. **两件事分清楚**：`ctx.get('remote')` 只用来拿**载体**（那个 `$mount` API）；真正的 namespace `remote.sshConsole` 必须走 `ctx.inject(['remote.sshConsole'], cb)` 绑定。`ctx.get` 拒绝一个插件没声明的 key，所以用它取 namespace 会在注入完成前就失败。

**改了 `index.js` 要重启应用，改 `client.js` 刷新页面即可。** 这不是猜的：实测主进程启动时间早于 `index.js` 的修改时间，而面板仍在正常工作，说明 Host 半没有被热重载（HMR 只重载 `cordis.patch.yml`）。表现是：用老的 Host 刷新新页面，会得到一堆"没有这个方法"的报错——那是在提示你重启，不是代码坏了。

**重启只重新读磁盘，不会修复已经被写坏的数据。** 这个坑真的踩过两次：修好端口 bug 后没重启，旧进程在面板里保存了一次，把 `Port 26518` 写成 `Port 22`；随后重启，但重启只是读到那个已写坏的值，看起来像"修复没生效"。所以：**改完 Host 代码、在确认重启完成之前，不要用面板保存任何东西**；重启后先核对数据有没有被旧代码污染。诊断这类问题时，比对 **进程启动时间** 与 **代码修改时间**，谁更晚一目了然。

## 测试

这个仓库的测试曾经骗过自己，所以规则是硬的：

- **测真代码，不要测副本。** 曾经 `test/panes.test.mjs` 自己重写了一份分屏逻辑来测，结果把组件里真正的修复 effect 整个删掉，它照样绿。现在改为从 `client.js` 里提取函数直接执行。**能提炼成纯函数的逻辑就提炼出去**，别在组件内联，否则只能对着源码跑正则。
- **断言点名函数，不要点名局部变量。** `assert.ok(/const shown = …/)` 在改名时会红——那不是发现 bug，是噪音。改成断言"必须调用 `shownPanes(...)`"。
- **测调用方真实走的那条路。** 端口 bug 的成因就是：测试传了数字 `26518`，而表单传的是字符串 `'26518'`，两条路不同，测试白测。**照抄真实调用方的类型。**
- **测试不能碰用户的真文件。** Host 测试要用 `mkdtempSync` 造临时目录，并通过 `sshConfigFile` / `knownHostsFile` 指过去。`test/host.test.mjs` 最后一项（31）会比对真实 `~/.ssh/config` 和 `known_hosts` 的 mtime 与大小，任何写穿都会让它红——**这条守卫本身也验证过能失败**（把它的监视目标换成临时文件再改那个文件，确认它报错）。
- **验证方法本身要能失败。** 写完一条断言，故意改坏被测代码，确认它真的会红。做不到那就不是测试。

改完公开行为后，顺手核对 README「验证状态」里的项数与实际一致——那些数字曾经漂了很久没人发现。

## 改 `~/.ssh/config` 是不可协商的

这个功能的全部风险就是"重写时悄悄弄丢了什么"，所以：

- **逐行外科手术，不整份重写。** 只替换属于 `Host` / `HostName` / `Port` / `User` / `IdentityFile` 的行，其余逐字节保留。注释、空行、`Host *` 默认块、以及不认识的指令（真实配置里就有 `HostKeyAlgorithms +ssh-rsa`，丢了那台机器直接连不上且**不报错**）都必须活下来。
- **`Port` 总是写**，包括 22。`ssh` 对每个参数取**第一个**匹配值，省略会继承前面 `Host *` 的值。
- **新块插在 `Host *` 之前**，同样的原因。
- **遇到 `Match` 拒绝编辑**，不要试图理解它。
- **写配置用拒绝，不用默认值。** 读文件时坏值退化到默认是对的；写文件时静默替换用户要写的东西就是 bug（端口曾经这样被改成 22）。

## 常用命令

```sh
npm.cmd test          # 三套测试一起跑
npm.cmd run build     # 重新生成 client.xterm.js
node test/host.test.mjs
```

**PowerShell 里要用 `npm.cmd`，不能只写 `npm`。** 这台机器上 `npm` 解析到 `C:\nvm4w\nodejs\npm.ps1`，直接调用会被截成 `pm`，报 `Unknown command: "pm"`。这个错误看起来像 npm 坏了，其实是 `.ps1` shim 的调用问题——换 `npm.cmd` 即可。

## 不要进 git 的东西

- **临时验证脚本、探针、审计产物 → `%TEMP%` 或仓库根的 `.probe-*/`（已在 `.gitignore` 里），用完删。**
- `client.xterm.js` 是**生成的但必须提交**（包要能不构建就用）。改完跑 `npm.cmd run build` 然后 `git diff --exit-code -- client.xterm.js`，CI 会逐字节比对。
- **提交前看一眼 `git status`，不要盲目 `git add -A`。** 已经发生过一次：写在仓库根的 commit message 文件被扫进了提交，只能 `git rm --cached` + `--amend` 补救。

## 样式

只用 `--dsw-alias-*` 主题 token，**零字面颜色**（`test/client.test.mjs` 强制）。xterm 的搜索装饰要求字面 `#RRGGBB`，所以那个功能**刻意没启用**——不要"顺手"打开。

## 一条通用的

**测量，不要假设。** 这个项目里每一个真 bug 都是靠实测抓到的：真机握手、无头浏览器读 DOM、往代码里注入变异。读完代码就下结论，至少错过过三次。
