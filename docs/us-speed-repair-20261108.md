# US 测速修复：代码与实机验证完成，待恢复发布凭据

## 当前状态

- 用户允许适当提高测速流量预算；采用 US 每方向 64 MiB、4 路 TCP、6 小时一次。
- 后端修复已推送：`5130d4a`，仓库 `ms903/CF-Server-Monitor`。
- 采集器源码已保存为本地提交：`4f58813`，位于
  `~/peer-relay-manager/cmd/cfsm-family-probe`，未推送相邻仓库。
- GitHub Actions 的 **106/106 测试通过，前端构建通过**。
- 生产发布停在 Cloudflare 认证：本机 token 与 Actions 的 `CF_API_TOKEN`
  均返回 `Invalid access token` / `9109`，不是代码、D1 迁移或构建失败。
- 失败任务：[Deploy CF Server Monitor #42489107453](https://github.com/ms903/CF-Server-Monitor/actions/runs/42489107453)。
- **线上仍运行旧采集器和原预算。没有替换服务、发布新 Worker 或把诊断结果写入生产历史。**

当前依赖的负责人是用户：在仓库 [Actions Secrets](https://github.com/ms903/CF-Server-Monitor/settings/secrets/actions)
更新有效的 `CF_API_TOKEN`。不要把 token 发到聊天或提交到仓库。更新完成后，执行端继续以下步骤。

## 为什么换成 iperf3

旧自写 QUIC 测速最多下载 4 MiB、上传 2 MiB，包含多轮请求等待和冷启动。
US 延迟约 160–170 ms；这类小样本不能代表连续 TCP 传输的吞吐。
短字节模式的 iperf 对照还出现了发送端本地 socket 已写入、接收端统计为零的情况。
修复只采用 iperf3 的 `end.sum_received`，拒绝零接收、不足 1 秒或 1 MiB、错误和不完整结果，
不使用发送端写缓冲速度补值。

新方案用已有 SSH 别名和固定主机密钥临时启动 VPS 的 iperf3 单次端点。
数据直连选定公网 IP，不通过 SSH 隧道或 Tailscale；每方向 4 路 TCP、目标有效载荷 64 MiB。
端口 5202 只接受当前 SSH 来源 IP，单次结束自动关闭，远端 90 秒 watchdog 兜底清理。
不安装常驻公网测速服务，不更改中继选择。

其他七条地址族链路维持原来的 4/2 MiB 预算和采集方式。
两条 US 加七条其他链路，30 天基础有效载荷预算为 **34.921875 GiB**；
块对齐超量、重传、协议开销、失败重试和手动测速另计。历史数据原样保留；新旧协议和采样量不同。

## 有效证据

下列均为真实 Home ↔ VPS 公网测量，单位 Mbps；两个方向按 VPS → Home / Home → VPS 排列。
不同轮次不是同一时刻的对照，不表示固定带宽保证。

| 测量 | 66 US | Zoro US |
| --- | ---: | ---: |
| 修复前面板最近成功记录 | 16.46 / 10.17 | 14.53 / 2.19 |
| 独立 iperf3：10 秒 + 2 秒预热 | 199.23 / 58.40 | 48.13 / 53.96 |
| 独立 iperf3：每方向 64 MiB | 180.27 / 63.66 | 38.57 / 57.01 |
| **实际新采集器代码实机测试** | **180.31 / 49.35** | **41.38 / 35.22** |

最后一轮执行 `TestIperfPublicIntegration`，完整覆盖新的 SSH 启动、两方向公网传输、解析与清理；
两台均通过，总有效载荷分别为 134,742,016 和 134,610,944 字节。
测试后已确认两台 VPS 均无 5202 监听、无 `cfsm-iperf-*` 临时规则。
Home 原服务仍 active，启动时间仍是 2026-10-28 13:43:40 UTC。

- `go test -race ./cmd/cfsm-family-probe` 通过。
- 新增覆盖接收端统计、零/短样本、失败不填数值、方向和地址族、预算钳制、原 QUIC 合约、发布结果的测试。
- 后端新增按服务器 ID 预算、可见/单机范围流量汇总、claim 预算的测试。
- 本地非 CI 测试遇到回环端口沙箱和开发证书安装限制；使用获准网络权限及项目既有 `CI=1` 模式后相关测试通过。
  GitHub 标准 CI 的 106 项测试全部通过。

原始诊断 JSON 在 `/tmp/cfsm-{66-us,zoro-us}-{down,up}-{bytes,time}.json`。
64 MiB 轮次覆盖了之前同名的 16 MiB 临时结果；不应再用这些文件描述 16 MiB 实验。

## 凭据恢复后的执行顺序

1. 重跑已失败的发布任务，确认 Cloudflare 发布成功：

   ```sh
   gh run rerun 42489107453 --repo ms903/CF-Server-Monitor --failed
   gh run watch 42489107453 --repo ms903/CF-Server-Monitor --exit-status
   ```

2. 用现有正常管理员登录读取 `/api/family-path`，确认
   `max_bytes_per_test=134217728`、`estimated_monthly_bytes=37497077760`
   （当前九条链路）。`/tmp/cfsm-api-check.py` 可读取并打印非凭据字段，
   其中密码只在进程内从既有配置加载。

3. 复核当前 Home 配置和单元没有新的他人修改，再原子安装已验证产物：

   - 二进制：`/tmp/cfsm-family-probe.new` → `~/.local/bin/cfsm-family-probe`；
   - 配置：`/tmp/cfsm-family-probe-config.new.json` →
     `~/.config/peer-relay-manager/cfsm-family-probe.json`；仅两个 US target 增加 iperf 字段；
   - 单元：`~/peer-relay-manager/deploy/systemd/cfsm-family-probe.service` →
     `~/.config/systemd/user/cfsm-family-probe.service`；显式加入 `%h/.local/bin` 的 PATH，
     以便服务能找到现有 iperf3 wrapper。

   用 `.new` + `mv` 替换运行中的二进制；配置权限保持 `0600`。
   然后 `systemctl --user daemon-reload`、重启 `cfsm-family-probe.service` 并检查 active 和启动日志。
   不重启 Controller、policy-switcher、relay-agent 或 Tailscale。

4. 在已登录面板只触发两个 US IPv4 路径，或运行
   `python3 /tmp/cfsm-api-check.py --trigger-us`。通过日志确认
   `method=iperf3-tcp-4`、每方向 67108864 字节，两个结果成功上报；
   再从 latest/history API 验证新的时间戳、真实数值与历史落库。
   同时确认正常的分钟延迟上报继续运行。

5. 写回本文件的生产启用状态、部署任务和实际历史验收结果，解除 token 依赖。

完成条件是新参数实际生效、受管服务成功采样并上报、面板/历史读到新结果。
独立实机测试通过还不满足最后这一条件。

## 回滚与后续维护

回滚备份在 `/tmp/cfsm-us-speed-backup-20261108/`，包含旧二进制、原配置、原服务单元；
恢复指令见 `~/peer-relay-manager/docs/CFSM_IPERF.md`。当前尚未切换，无需回滚。
若 `/tmp` 清理或主机重启导致候选产物消失，应从已保存源码重建，并重新生成仅修改两个 US target 的配置。

预算事实源为 `deploy/family-path-bandwidth-profiles.json`，由既有 GitHub workflow 装入 Worker。
不应修改全局默认的 4/2 MiB 或把 US 的依赖施加给原有 QUIC targets。
