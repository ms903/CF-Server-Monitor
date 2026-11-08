# US 测速修复：2026-11-08 已上线

## 当前状态

- 用户允许适当提高测速流量预算；采用 US 每方向 64 MiB、4 路 TCP、6 小时一次。
- 后端已发布：`5130d4a`，仓库 `ms903/CF-Server-Monitor`。
- Worker 版本：`9c4f01ff-9072-4f9d-baf9-8f76f79a47cf`，2026-11-08 16:04 UTC 生效。
- 采集器源码已保存为本地提交：`f556c79`，位于
  `~/peer-relay-manager/cmd/cfsm-family-probe`，未推送相邻仓库。
- GitHub Actions 第二次执行成功：**106/106 测试通过，前端构建、secret 上传、Worker 发布均通过**。
- 发布任务：[Deploy CF Server Monitor #42489107453，attempt 2](https://github.com/ms903/CF-Server-Monitor/actions/runs/42489107453/attempts/2)。
- Home 运行中的新采集器启动于 **16:10:22 UTC**，已完成两台 US 的真实队列任务。
- 两台 latest/history API 的新时间戳、双向 Mbps、有效载荷字节数完全一致；原历史保留，分钟延迟继续更新。

用户于 16:02 UTC 更新了仓库级 `CF_API_TOKEN`，恢复了既有 GitHub Actions 发布通道。
本机原先保存的 token 仍然失效，后续发布使用 GitHub Actions。

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
| 修复前面板记录（初次排查） | 16.46 / 10.17 | 14.53 / 2.19 |
| 独立 iperf3：10 秒 + 2 秒预热 | 199.23 / 58.40 | 48.13 / 53.96 |
| 独立 iperf3：每方向 64 MiB | 180.27 / 63.66 | 38.57 / 57.01 |
| **实际新采集器代码实机测试** | **180.31 / 49.35** | **41.38 / 35.22** |
| **已上线服务正式采样、latest/history 读回** | **179.98 / 75.61** | **44.00 / 39.02** |

上线前执行 `TestIperfPublicIntegration`，完整覆盖新的 SSH 启动、两方向公网传输、解析与清理；
两台均通过，总有效载荷分别为 134,742,016 和 134,610,944 字节。
测试后已确认两台 VPS 均无 5202 监听、无 `cfsm-iperf-*` 临时规则。
这轮独立测试未发布到生产；上表最后一行来自随后启用的受管服务正式队列任务。

- `go test -race ./cmd/cfsm-family-probe` 通过。
- 新增覆盖接收端统计、零/短样本、失败不填数值、方向和地址族、预算钳制、原 QUIC 合约、发布结果的测试。
- 正式启用时追加了显式 SSH 配置选择和主机认证保留的测试，并重新通过 `go test -race`。
- 后端新增按服务器 ID 预算、可见/单机范围流量汇总、claim 预算的测试。
- 本地非 CI 测试遇到回环端口沙箱和开发证书安装限制；使用获准网络权限及项目既有 `CI=1` 模式后相关测试通过。
  GitHub 标准 CI 的 106 项测试全部通过。

原始诊断 JSON 在 `/tmp/cfsm-{66-us,zoro-us}-{down,up}-{bytes,time}.json`。
64 MiB 轮次覆盖了之前同名的 16 MiB 临时结果；不应再用这些文件描述 16 MiB 实验。

## 生产启用与正式历史

线上 `/api/family-path` 已读回 `max_bytes_per_test=134217728`、
`estimated_monthly_bytes=37497077760`（当前九条链路），没有把 US 的预算套给其他链路。
Home 已原子安装新二进制与两个 US target 配置，并明确提供服务 PATH。

| 路径 | observed_at（UTC，采样开始） | 上报完成（UTC） | 有效载荷字节数 | 状态 |
| --- | --- | --- | ---: | --- |
| 66 US IPv4 | 16:10:37.650 | 16:10:50 | 134742016 | ok |
| Zoro US IPv4 | 16:10:52.612 | 16:11:18 | 135004160 | ok |

真实服务日志确认两条均为 `method=iperf3-tcp-4`、每方向 67108864 字节。
已核对最新值与对应历史点的 Mbps、时间戳、字节数和 `ok` 状态一致；两条 24 小时历史各有 6 条记录，
包括原记录和首次启用时的失败记录。16:11、16:12 的分钟延迟轮次均为九条路径、零失败。
测试后两台 VPS 均无 5202 监听、无 `cfsm-iperf-*` 临时规则，服务 active、NRestarts=0。

正式启用首次暴露了服务中的 SSH 全局 proxy include 读取问题：
`Bad owner or permissions on /etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf`。
修复增加可选 `iperf_ssh_config`；生产仅两个 US 显式指定已有的
`/home/ms903/.ssh/config`（0600），通过 `ssh -F` 使用该受信任配置。
严格主机密钥校验保留；没有修改系统 SSH 文件或放宽服务隔离。首次失败记录原样保留，随后两台均成功。

正式验收的原始 API 响应在 `/tmp/cfsm-family-accepted.json`、
`/tmp/cfsm-66-us-accepted-history.json`、`/tmp/cfsm-zoro-us-accepted-history.json`。
当前二进制、配置、单元分别位于 `~/.local/bin/cfsm-family-probe`、
`~/.config/peer-relay-manager/cfsm-family-probe.json`、
`~/.config/systemd/user/cfsm-family-probe.service`。

## 回滚与后续维护

持久回滚备份在 `~/.local/state/cfsm-us-speed-backup-20261108/`（目录 0700），
包含旧二进制、原配置、原服务单元；恢复指令见 `~/peer-relay-manager/docs/CFSM_IPERF.md`。
回滚旧采集器时仍会应用其原来的 4/2 MiB 本地上限；移除两个生产预算覆盖并重新部署可恢复原预算显示。

预算事实源为 `deploy/family-path-bandwidth-profiles.json`，由既有 GitHub workflow 装入 Worker。
不应修改全局默认的 4/2 MiB 或把 US 的依赖施加给原有 QUIC targets。
