# dsh-openai-bridge 配置记录

> **这是一台 Windows 机器上的实测记录**（原文件 `dsh-openai-bridge-配置记录.md`），不是照抄 README。
> 路径、IP、用户名都是**那台机器**的例子 —— 照抄时换成你自己的。
> 下面每一条关于**插件代码**的说法，开发这边都逐条核对过，结论见紧接着的表格。
>
> 相关：[GUIDE.zh.md](GUIDE.zh.md)（怎么用） · [PANEL.zh.md](PANEL.zh.md)（面板功能细节） · [README.md](README.md)（配置项与设计）

## 核对结果

| 记录里的说法 | 结论 | 依据 |
|---|---|---|
| 插件不自己开端口，把路由挂到 DSH 已在跑的 HTTP 服务上 | ✅ | 全部路由都走 `ctx.webServer.register` |
| 那个服务默认只绑回环，所以要给**整个服务**换绑 | ✅ | 本机实测监听是 `0.0.0.0:19387` |
| 没有令牌 = 其余路由**不挂载**（失败关闭） | ✅ | `/v1`、`/bridge` 都不注册，只留 `/setup` |
| 令牌在 `apply()` **加载时读一次**，生成后必须重启 | ✅ | 这正是"生成 → 重启"分成两步的原因 |
| 令牌文件写入用 `mode: 0o600` | ✅ 代码确实传了这个参数 | ⚠️ 但 **Windows/NTFS 不执行 POSIX 权限位** —— 实际保护来自用户目录的 ACL，不是这个参数 |
| 待配对码**纯内存**、重启即丢；已批准设备**落盘不丢** | ✅ | `client-gate.js` 顶部注释明确写了；序列化只写 `clients`，不写 `pending` |
| `lastSeen` 不是每次请求都刷新 | ⚠️ **要拆开讲** | **内存里**每次被允许的请求都刷；**落盘只在批准/撤销时**。所以磁盘上的值会旧，而设置页显示的是内存值（新）。结论不变：别拿它判断"手机现在还在线" |
| 上传是唯一的写洞，只有浏览根下的 `_inbox/` 可写 | ✅ | `panel.js` 顶部契约注释：本模块唯一的写操作就是往固定的 `_inbox` 上传 |
| 审批落在**桌面 GUI**，纯 OpenAI 客户端答不了 | ✅ | 审批是 agent 作用域的事件，只有面板/桌面能应答 |
| 绑 `0.0.0.0` **不会**让手机用上 DSH GUI 本体 | ✅ | 本机实测：局域网访问 `/setup` 是 **403**；`/v1` 需要令牌 |

核对的人不是原文作者。**如果你发现哪一条与实测不符，以实测为准**，并把差异记回来。

---

一台 Windows 机器上，让手机（Chatbox / `/bridge` 面板）驱动 DSH 会话的**实际可用配置**。

本文只记录**最终生效的做法**，不记录探索过程。所有条目都在下列环境实测通过，不是照抄插件 README。

---

## 0. 环境

| 项 | 值 |
|---|---|
| 操作系统 | Windows |
| DSH | 0.2.0-rc.2（桌面版，Electron） |
| DSH 主目录 | `C:\Users\LDTchara\.dsh`（即 `$DSH_HOME`） |
| profile | `desktop`（`$DSH_HOME\profiles\desktop`） |
| GUI / HTTP 端口 | **19387** |
| 电脑 WLAN 地址 | `192.168.0.101/24` |
| 手机 | Android，`192.168.0.105` |
| 插件包名 | `dsh-openai-bridge`（`package.json` 里 `version` 仍是 `0.1.0`，但代码差异很大，**别靠版本号判断新旧**） |
| 防火墙放行 | **已放行**——Windows 弹窗时勾选了「专用」+「公用」，生成的是**按程序**的入站规则（见 §8.2） |

---

## 1. 先理解一件事：必须给 **整个 HTTP 服务**换绑，不只是插件

插件**不自己开端口**。它把 `/v1`、`/bridge`、`/setup`、`/pair` 这些路由挂到 DSH 已经在跑的那个 HTTP 服务上（`ctx.webServer.register`）。

而 DSH 那个服务**默认只绑回环 `127.0.0.1`**。所以手机即使同网段也路由不到——**这不是插件的问题，是服务本身的绑定**。

于是配置的第一步不是配插件，而是让这个服务监听所有网卡。

---

## 2. 配置 profile patch：把 host 绑到 `0.0.0.0`

编辑 `$DSH_HOME/profiles/desktop/cordis.patch.yml`，在顶层数组末尾追加：

```yaml
- id: webserver
  name: "@deepseek-ai/dsh-host-webserver"
  config:
    host: 0.0.0.0
    port: 19387
```

### ⚠️ 两个必须注意的点

1. **`port` 必须一起写死。** 这一行的 schema 里 `host` 和 `port` **都是必填**。只写 `host` 会让 GUI 换到随机端口，你现在的 `http://127.0.0.1:19387` 就失效了。
2. **这是全局改动。** 它放宽的是**整个** webserver，不是只给 bridge 开个口子。DSH 那个服务**自身不带 TLS、不带认证、不带同源策略**——保护各自路由的是路由拥有者自己（bridge 用 Bearer token，GUI 的 `/api` 用浏览器 cookie）。

### 这一步不用重启

profile patch 是被监听的，**写入后 HMR 立即重组配置**，绑定当场生效。验证：

```powershell
Get-NetTCPConnection -LocalPort 19387 -State Listen |
  Select-Object LocalAddress, LocalPort
# 期望：0.0.0.0   19387     （改之前是 127.0.0.1）
```

---

## 3. 重启 DSH

**插件代码的改动静需要重启**——配置层走 HMR，模块层不走。

本机 profile **没有**配置 `hmr` 的 `root`，所以用的是 bundle 默认的 `root: []`，即**不监听源码模块**。DSH 的插件管理器文档也写明了：包被替换后必须重启进程才能载入新的模块代际。

---

## 4. `http://127.0.0.1:19387/setup` 生成令牌

DSH 起来后，**没有令牌时插件只挂一个路由**：设置页。其余（`/v1`、`/bridge`）全部不挂载——这是"未配置 = 未安装"的失败关闭设计。

在**这台电脑上**打开 <http://127.0.0.1:19387/setup>，点页面上的：

> **生成并写入新令牌**

它会：

- 随机生成 32 字节令牌，base64url 编码（44 字符）
- 写入 `C:\Users\LDTchara\.dsh\openai-bridge.token`（权限 `0600`）
- 在页面上显示手机该用的地址

### 设置页只有本机能开

它对**每一个**请求检查 `req.socket.remoteAddress`，非回环一律 **403**（响应体 `setup is available from this machine only`）。实测：把 TCP 源地址设成局域网地址去请求，拿到 403；用回环请求，拿到 200。

### 地址列表里要挑对那一个

页面会列出**所有**网卡地址。本机实测：

| 网卡 | 地址 | 能不能用 |
|---|---|---|
| Radmin VPN | `26.93.149.4` | ❌ 虚拟 |
| astral | `10.126.126.2` | ❌ 虚拟 |
| VMware VMnet1 / VMnet8 | `192.168.20.1` / `192.168.211.1` | ❌ 虚拟 |
| **WLAN** | **`192.168.0.101`** | ✅ **手机用这个** |

手机在 WLAN 上，**只有 WLAN 那一条是对的**。

---

## 5. 再重启一次

**这一步容易漏。** 令牌是插件在 `apply()` **加载时**读一次文件的，之后不再重读。所以流程是：

```
生成令牌  →  重启 DSH  →  bridge 才真正起来
```

设置页自己的提示也写了这句。

重启后验证（把 `<TOKEN>` 换成 `openai-bridge.token` 里的内容）：

```powershell
$token = (Get-Content "$env:USERPROFILE\.dsh\openai-bridge.token" -Raw).Trim()
Invoke-WebRequest http://127.0.0.1:19387/v1/models -Headers @{Authorization="Bearer $token"} |
  Select-Object StatusCode
# 期望：200
```

---

## 6. 配对手机（新设备默认被拒）

**光有令牌不够。** 插件有一层按客户端的允许列表：**没见过的新设备被拒绝一切**，包括面板和 OpenAI 端点。

流程：

1. 手机上访问 `http://192.168.0.101:19387/bridge?token=<TOKEN>`
2. 电脑上弹出**配对码**（6 位数字，只显示在这台机器上）
3. 在手机上输入该码

配对结果落在 `$DSH_HOME\openai-bridge-clients.json`，**重启不丢**：

```json
{
  "version": 1,
  "clients": [
    { "ip": "192.168.0.105", "label": "Mozilla/5.0 (Linux; Android 16; ...)", "firstSeen": ..., "lastSeen": ... }
  ]
}
```

注意：`lastSeen` **不是每次请求都刷新**，不要拿它判断"手机现在还在线"。

> 关于这层的边界，插件作者自己说清楚了：**它不是对已在局域网内的人的防线**。ARP 欺骗可以冒充已批准的地址，DHCP 也会让手机换 IP。它的实际价值是**让泄露的令牌单独不再够用**——必须有人站在这台电脑前才能放行新设备。

---

## 7. 手机端 Chatbox

**Settings → Model Provider → Add → Add Custom Provider → "OpenAI API Compatible"**

| 字段 | 值 |
|---|---|
| API Key | `openai-bridge.token` 文件里的内容 |
| API Host | `http://192.168.0.101:19387/v1/` |
| API Path | `/chat/completions` |
| Model ID | `dsh-agent` |

模型下拉里除了 `dsh-agent`（新会话），还会列出**每个 DSH 会话**，标签形如 `<标题> · <sessionId>`——选一个就是**接着那个会话聊**（桌面上的会话也能接着聊）。

---

## 8. 两个"想当然会踩"的点

### 8.1 绑 `0.0.0.0` **不会**让手机用上 DSH GUI

这一条反直觉，但有据：

- DSH 的浏览器认证要求每个请求的 `Host` **是回环**，或匹配显式配置的 `trustedHosts` 条目
- 不匹配 → **403**；匹配但未认证 → 401
- DSH 文档明确写着 `dsh web --host 0.0.0.0` **不被支持**

所以结果是**分离**的：

| 目标 | 手机能用吗 |
|---|---|
| bridge 的 `/v1`、`/bridge`、`/pair` | ✅ 能（自带 Bearer 校验，不走那道信任栅栏） |
| DSH GUI 本体（shell、`/api`） | ❌ 不能（被 Host 检查拦下） |

**这是好事**：暴露面只限于你显式配的那个令牌，而不是整个 GUI。

### 8.2 防火墙：Windows 弹窗时勾了「专用 + 公用」

插件设置页的排查清单把"防火墙要放行端口"列为最常见的坑，还特意提醒 Windows 常把网络判成「公用」而规则只对「专用」生效。本机**已经放行了**，但**放行方式很关键，且容易误判**。

实测到的规则：

```
DisplayName : deepseek harness.exe
Direction   : Inbound          Action  : Allow
Enabled     : True
Profile     : Private, Public
Program     : C:\users\ldtchara\appdata\local\programs\deepseek harness\deepseek harness.exe
```

（有两条同名规则，是两次弹窗各建了一条，效果相同。）

#### ⚠️ 为什么"按端口查规则"会查不到

这条规则是 **Windows 弹窗（"是否允许此应用通过防火墙"）自动创建的**：它按**程序**放行，**按端口**查是查不到的——

```powershell
# 这样查会返回空，别据此以为没放行！
Get-NetFirewallPortFilter | Where-Object { $_.LocalPort -eq 19387 }
```

因为程序级规则**没有端口过滤器**，而 `Get-NetFirewallPortFilter` 只列端口级规则。我一开始就是这样查的，得出"没有任何规则"的错误结论。**要按程序名查**：

```powershell
Get-NetFirewallRule | Where-Object { $_.DisplayName -like "*DeepSeek*" } |
  ForEach-Object {
    $app = $_ | Get-NetFirewallApplicationFilter
    [PSCustomObject]@{ Name=$_.DisplayName; Dir=$_.Direction; Action=$_.Action;
                       Enabled=$_.Enabled; Profile=$_.Profile; Program=$app.Program }
  } | Format-List
```

#### 两个推论

1. **「公用」必须勾上。** 本机 WLAN 的网络类别是 `Public`。若弹窗时只勾了「专用」，规则就只对 Private 生效，而 WLAN 是 Public → **入站被拦，手机连不上**。这正是设置页警告的那个坑，只是它发生在**弹窗那一刻**，而不是事后配规则时。
2. **这是按程序、全端口的放行**，不是只放 19387。也就是说 `DeepSeek Harness.exe` 监听的**任何**端口都允许入站。它当前只监听 19387，所以实际暴露面就是那一个；但要知道这个规则的粒度比"只开一个端口"粗。

#### 如果没弹窗 / 需要手动补

如果手机连不上，再按设置页的清单依次查，顺序是：

1. 改过 `cordis.patch.yml` 或令牌文件 → **重启 DSH**
2. 防火墙放行，**且规则要匹配当前网络类型**（Public / Private 的坑）
3. 手机和电脑在**同一网段**
4. 先在电脑上访问 `http://127.0.0.1:19387/setup` 自测——打不开说明服务本身没起来
5. 电脑换过网络 → 地址会变，回设置页重看

需要手动补一条时，建议**收窄到自己的网段**，而不是对整个互联网开：

```powershell
New-NetFirewallRule -DisplayName "DSH Bridge 19387 (LAN only)" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 19387 `
  -RemoteAddress 192.168.0.0/24 -Profile Any
```

`-Profile Any` 是为了避开上面那个 Public/Private 不匹配的坑。

---

## 9. 安全边界（务必知情）

1. **只保护完整性，不保护机密性。** 每个由 bridge 驱动的会话都钉在 `read-only` 预设上，写入会被沙箱拒绝并转为审批请求。但 `read-only` **不拦读取、不拦执行命令、不拦对外联网**。拿到令牌的人能读、能外泄，只是改不了。
2. **明文 HTTP。** 走 Wi-Fi 时令牌和 cookie 都是明文。别在不可信网络上开。
3. **审批需要有人在 GUI 前。** 审批请求会转发给浏览器客户端，落在**桌面 GUI**；纯 OpenAI 客户端没有审批通道，渲染不了也答不了。
4. **`/bridge` 面板的上传是唯一的洞。** 上传是 HTTP 处理器直接落盘，**绕过沙箱、绕过审批、不进审计日志**。全机器只有浏览根下的 `_inbox/` 可写。
5. **手机不能把沙箱放宽到 `danger-full-access`。** 手机可请求的预设被硬限制在 `read-only` / `workspace-write`；而且换预设**不是申请即生效**——必须把只显示在**电脑上**的一次性 6 位码回填才算数。

---

## 10. 文件位置速查

| 内容 | 路径 |
|---|---|
| 插件源码 | `C:\Users\LDTchara\dsh-plugins\dsh-openai-bridge` |
| profile 依赖与 bundle 选择 | `$DSH_HOME\profiles\desktop\package.json` |
| profile 配置覆盖 | `$DSH_HOME\profiles\desktop\cordis.patch.yml` |
| **令牌** | `$DSH_HOME\openai-bridge.token` |
| **已批准设备** | `$DSH_HOME\openai-bridge-clients.json` |
| 运行自检 | `node test/run-all.mjs`（14 个套件） |

**令牌与已批准设备都在 `$DSH_HOME` 下的文件里**，所以重启 DSH 不会丢这两样；会丢的只有**尚未批准的待配对码**（纯内存，且这是刻意的设计）。

---

## 11. 最短路径重述

```
1.  profile patch 加 webserver 行（host: 0.0.0.0 + port: 19387）   → 立即生效
2.  重启 DSH                                                      → 载入插件代码
    （此时 Windows 大概率弹出防火墙询问 → 必须勾上「专用」+「公用」，
      否则 WLAN 属于 Public，入站会被拦。详见 §8.2）
3.  电脑上开 http://127.0.0.1:19387/setup，点"生成并写入新令牌"
4.  再重启 DSH                                                    → 载入令牌
5.  手机访问 .../bridge?token=<TOKEN>，在电脑上读配对码并在手机上输入
6.  Chatbox：Host http://<WLAN_IP>:19387/v1/ ，Path /chat/completions，Model dsh-agent
```

第 3、4 步分两次重启看着笨，但原因是插件在加载时读一次令牌文件——**配置改完就必须重启**，这是当前实现的约束，不是操作失误。

---

## 12. 这份记录写完之后，插件变了什么

原文写于那次配置完成时。此后插件有一批变化 —— **照原文的安装与登录流程操作仍然完全有效**，但你对"手机能做什么"的理解需要更新。

### 新增的能力

| 能力 | 说明 |
|---|---|
| **思考折叠 + 流式** | 这一轮的推理会**边想边长**地流进一个默认收起的折叠块。（协议里没有这个通道，所以 Chatbox 永远看不到） |
| **复制** | 整条消息、以及每个代码块，各有独立按钮 |
| **停止** | 只在正在输出时出现；**默认保留你排队的内容** |
| **插入消息：排队 / 插话** | 先放进去、不当场发。托盘里每条有 **立即发送 / 编辑 / 撤销 / 转插话** |
| **待发送入口** | 左下角 📥，把队列开成独立视图（托盘只在会话里出现） |
| **分支对话（fork）** | 抽屉里每段会话一个按钮，从**最后一个完整回合**切出一个新会话 |
| **路径标签** | 回复里的本地路径变成可点标签，打开**面板自己的文件查看器** |
| **问答卡片** | agent 反问你时，卡片顶掉输入框；**跨会话也会出现**（卡上写「来自会话 X」） |

### 修掉的问题

- **切换会话落在最早的消息** → 现在落到最新
- **展开思考很卡** → 流式期间不再每来一个字就重解析整段
- **流式输出把输入框一路往下推** → 输入框现在钉在**视口**底部
- **打字时键盘自己收回** → 轮询只在内容真变了时才重画
- **点路径开出 404、地址栏一堆百分号** → 路径不再被编成假链接
- **排队了却永远不发** → 这**是设计**；托盘现在会写明「空闲中 —— 点『立即发送』才会发出去」
- **空着输入框点按钮毫无反应** → 现在会红字提示
- **`Cannot find package '@deepseek-ai/dsh-llm'`** → 插件不再导入任何 harness 包（有全目录扫描断言守着）
- **`Cannot read properties of undefined (reading 'throwIfAborted')`** → 提交路径退回 agent 自己的 API

### 安全模型要补的一条

原文写「上传是唯一的**写**洞」，这条仍然成立（指写磁盘）。但要补上：**手机现在能直接驱动一段正在跑的会话** —— 排队、插话（影响当前这一轮），以及从任意会话 fork 出新会话。这不改变沙箱边界（`read-only` 照旧管着工具），但意味着**拿到令牌的人对 agent 的操作面更大了**，不只是"看和聊"。

---

## 13. 另一台机器上的差异

| 项 | 原文那台 | 开发这台 |
|---|---|---|
| `$DSH_HOME` | `C:\Users\LDTchara\.dsh` | `C:\Users\21683\.dsh` |
| 插件源码 | `C:\Users\LDTchara\dsh-plugins\dsh-openai-bridge` | `...\Documents\deepseek-harness\default-workspace\dsh-openai-bridge` |
| LAN 地址 | `192.168.0.101/24` | `10.111.99.94/19`（以太网）、`10.111.102.154`（WLAN） |
| 手机 | Android `192.168.0.105` | iOS `10.111.101.164` |
| 公网 | —— | **没有公网 IP**：出口 `112.3.213.61` 是中国移动的 NAT 地址 |

### 值得记下来的坑：插件目录向上找 `node_modules`

插件**不能**导入 harness 包。裸包名只在"DSH 恰好在插件目录之上放了那个包"时才解析：

```
C:\Users\21683\.dsh\profiles\node_modules\@deepseek-ai\dsh-llm    ← 这台有
```

原文那台没有这个目录，于是 `await import('@deepseek-ai/dsh-llm')` 直接失败、**整条发送路径挂掉**。这是**安装布局的巧合，不是保证** —— 所以插件里已经没有任何 harness 导入，而且有一条测试扫遍 `lib/`（静态 / 动态 / require 三种写法）守住它。

---

## 14. 还没做的

- **公网访问**：开发这台在至少一层 NAT 之后（网关本身是 `10.x`，出口是中国移动），**入站不可能**。只能靠中继 / VPN。相关评估与改动在 **`public-access` 分支**上做，`main` 保持"局域网版"。
- **TLS**：现在是明文 HTTP（见 §9 第 2 条）。任何上公网的方案都**必须自带 TLS**，否则令牌明文过网。
- **`fileRoot: '*'`**：文件浏览器目前能读**整台机器**（见 §9 第 1 条：`read-only` 管不到它）。要收窄就改这个键。
