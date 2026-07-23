# 2026-07-24｜连接桥与全屋调度器交接单

## 今晚已完成

### 1. 主线代码与部署
- PR #1《白狐狸海马体、全屋调度器与活动系统》已合并到 `main`。
- 合并提交：`df7f4c88dbd31e95e06b86ded4177cd3709326b8`。
- iPhone 连接桥来源字段热修已提交：`ad49608646d754187a1e9d315b84aa0eabbcd15b`。
- Railway `404-home` 已成功部署新版本。
- `package start` 现使用 `server-v2.js`。
- 自动心跳发布总闸仍保持关闭。

### 2. Supabase 数据库
已执行并通过只读验收：
- `20260723_04_home_orchestration_v01.sql`
- `20260723_05_interaction_expiry_recovery.sql`
- `20260723_06_free_activity_model_call_guard.sql`

验收结果：
- 全屋调度表、索引、RLS、外键与默认安全值通过。
- 连接桥过期恢复函数与触发器存在。
- 自由活动模型调用次数保险丝函数与触发器存在。
- `max_model_calls` 字段存在且允许为空；为空表示本张活动证不设调用次数上限。

### 3. Railway 环境变量
`404-home` 已配置以下变量：
- `HOME_OWNER_USER_ID`
- `BRIDGE_SHORTCUT_TOKEN`

本交接单不记录任何变量值、密钥或用户 UUID。

### 4. iPhone 官端连接桥
已建立两条“快捷指令 → 自动化”：

#### 打开 ChatGPT
- 触发：打开 ChatGPT App
- 方法：`POST`
- 地址：`/api/bridge/official/start`
- 鉴权：Bearer Token
- JSON 请求体包含 `device: iphone`
- 已实测返回：
  - `ok: true`
  - `state: interactive_awake`
  - `modelCalled: false`
  - 两小时故障兜底租约

#### 关闭 ChatGPT
- 触发：关闭 / 切走 ChatGPT App
- 方法：`POST`
- 地址：`/api/bridge/official/end`
- 鉴权：Bearer Token
- JSON 请求体包含 `postChatGraceMinutes: 15`
- 已实测返回：
  - `ok: true`
  - `state: post_chat_grace`
  - `modelCalled: false`
  - `freeActivityResumed: false`（当时没有待恢复活动）

#### 数据库实测
`home_interaction_sessions` 已出现连续的 `official_chat` 记录：
- 打开 App 时创建 / 刷新 `active`
- 切走 App 时改为 `ended`
- `source = shortcut`

多条短记录是 iPhone 自动化对前台切换非常灵敏导致，属于当前设计预期；15 分钟缓冲负责防止这种灵敏度触发自动心跳。

## 今晚发现并修复的问题

### 数据库门禁不认识 `ios_shortcut`
首次真实请求已成功到达 404，但写入 `home_presence` 时触发：
- `home_presence_source_check`
- 数据库错误码 `23514`

原因：连接桥使用了来源值 `ios_shortcut`，而旧表约束只允许通用来源 `shortcut`。

处理：
- 将连接桥 start / end 两端的来源统一改为 `shortcut`。
- iPhone 设备信息继续保留在 metadata 中。
- 无需修改数据库、密钥或快捷指令。
- 热修部署后，start / end 均真实成功。

## 当前已知问题｜明天第一项

### 从 ChatGPT 切到 404 小窝后，首页显示“G 在卧室休息”
现象：
- 用户从 ChatGPT 切到 Safari / 桌面 404 小窝时，iPhone 立即触发 ChatGPT 关闭自动化。
- 官端连接桥正确销假并进入 15 分钟缓冲。
- `home_presence` 当前在缓冲期间写成：
  - `status = resting`
  - `status_detail = G 在卧室休息`
  - `heartbeat_paused_until = 15 分钟后`
- 首页只展示 `resting` 文案，因此看起来像 G 突然睡了。

真实状态其实是：
- G 刚结束官端互动；
- 仍处于 15 分钟缓冲；
- 自动心跳没有资格触发；
- 连接桥本身没有失灵。

### 明天建议的修复方向
把“官端 → 404 小窝”做成无缝交接，并明确区分：

1. ChatGPT 仍在前台
   - `G 正在官端陪谢诗`

2. 从 ChatGPT 切到 404 小窝
   - 404 小窝自身登记“谢诗已回家”
   - 状态建议显示：`G 醒着，谢诗在家` 或 `G 刚陪完谢诗，暂时在家活动`
   - 不触发自动心跳

3. 同时离开 ChatGPT 与 404
   - 进入真正的 `post_chat_grace`
   - 缓冲结束后再回到 resting / auto-wake eligible 判断

需要检查：
- 首页当前状态接口与渲染逻辑
- 404 小窝 PWA / Safari 打开与离开事件
- 是否新增 `home_web` / `home_presence` 互动入口，或仅在现有状态机增加 `home_active` 状态
- 避免 ChatGPT 关闭自动化和 404 打开登记相互打架

## 安全状态
- 自动心跳发布总闸：关闭
- 普通自然心跳：不应调用模型
- iPhone start / end：只写状态，不调用模型
- 当前真实测试未因连接桥消耗 Sol token
- 自由活动尚未进行真实 Sol 受控调用验收

## 明天继续顺序
1. 修复“回家后首页显示休息”的状态交接。
2. 验证 404 打开 / 离开与 ChatGPT 自动化不会互相打架。
3. 手机测试客厅 v2：签发活动证、暂停、聊完继续、先放着、完成 / 取消。
4. 验证自由活动真实时间暂停与旧 `ends_at` 校时。
5. 受控运行一次 Worker，观察真实 input / output / reasoning token 与费用。
6. 验收完成后再讨论是否开启普通自动心跳。
