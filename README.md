# 双摄像头分段录制（本机存储，不上传）

浏览器页面支持选择**主 / 备两个摄像头**预览；录制结果按**分段视频 + 时间清单**保存在本机，
**不向任何服务器上传媒体**。当主设备断开、轨道静音或权限失效时，当前片段会被**明确结束**并
记录时间缺口；若备设备可用，则从一个**全新片段**继续——绝不把两段伪装成无中断的单一视频。

## 功能对照

| 需求 | 实现 |
| --- | --- |
| 主/备摄像头选择与预览 | `src/recorder-core.js` + `src/app.js` 双路独立预览流（与录制流分开） |
| 分段录制 | 每段一个 `MediaRecorder` + 独立 Blob / ObjectURL，永不拼接 |
| 主设备断开 / 轨道 ended / 静音 / 权限失效 | 当前段立即封口，写入带 `reason` 的缺口，再尝试接管备机 |
| 备机可用则从新片段继续 | `_failover()` 在另一台设备上开新片段 |
| 两段不伪装成单一视频 | 每段独立文件、独立 URL、独立起止时间；缺口单列、不可省略 |
| 手动切换 / 停止 / 热插拔与异步回调交错 | 所有状态迁移经**单一串行队列** `enqueue()` |
| 迟到块只归属原片段 | 块只写入它所属的段；段 `sealed/error` 后一律丢弃 |
| 停止后不再追加 | `stop()` 同步置位停止意图 + 纪元（epoch）递增 |
| 媒体持有量限制 | `maxHeldBytes`（页面 256 MB），超限以 `quota-limit` 自动停止 |
| 撤销不再使用的 ObjectURL | 单段“释放”、“清空”（dispose）、新会话开始都会 `revokeObjectURL`；清单临时 URL 延迟撤销 |
| 导出清单 | JSON：每段设备/角色/起止时间/时长/大小/结束原因 + 全部缺口（含未闭合缺口） |
| 不上传媒体 | 纯 Blob/ObjectURL + `<a download>`；E2E 用请求监听断言零上传 |

## 关键设计：串行队列 + 片段归属 + 纪元

`src/recorder-core.js`（不依赖 DOM，可在 Node 中测试）：

- **串行队列**：开始、切换、停止、接管、`ondataavailable`、`onstop`、`devicechange`、权限
  变化全部经 `enqueue()` 排队执行。任务内 `await getUserMedia()` 期间不会有第二个任务穿插，
  因此交错顺序是确定的。
- **片段状态机**：`recording → sealing → sealed`（或 `error`）。
  - `sealing`：已调用 `MediaRecorder.stop()`，只接受属于本段的迟到数据；
  - `sealed`：Blob/ObjectURL 已固化，**任何**迟到块/`onstop` 都忽略；
  - 看门狗（默认 15 s）在 `onstop` 迟迟不来时强制封口。
- **停止意图 + 纪元**：`stop()` 在被点击的**同一同步时刻**置位 `_stopRequested` 并让
  `_epoch + 1`。即使停止任务还排在队列后面，任何在途 `getUserMedia` 回来后都会发现纪元已变，
  立即停止并释放这条迟到的流，不会新建片段。
- **接管**：中断 → 封口 → 开缺口（`disconnect / mute / permission / recorder-error`）
  → 按优先级选另一台设备 → 新片段；连续失败会累计 `tried`，不回头重试已失败的设备。
  没有设备可用时，缺口保持 `open` 并标记 `failoverFailed`，录制明确终止。

## 时间清单（示例）

```json
{
  "schema": "dual-camera-recording/v1",
  "devices": { "primary": { "...": "..." }, "backup": { "...": "..." } },
  "segments": [
    { "index": 0, "deviceId": "...", "role": "primary",
      "startedAt": "...", "endedAt": "...", "durationMs": 1503,
      "file": "segment-000.webm", "endedReason": "ended" },
    { "index": 1, "deviceId": "...", "role": "backup",
      "startedAt": "...", "endedAt": "...", "durationMs": 2210,
      "file": "segment-001.webm", "endedReason": "user-stop" }
  ],
  "gaps": [
    { "afterSegment": 0, "from": "...", "to": "...",
      "durationMs": 312, "open": false, "failoverFailed": false,
      "reason": "disconnect" }
  ]
}
```

## 运行

```bash
npm start                 # http://127.0.0.1:8080 （需 localhost 或 HTTPS 才有摄像头权限）
```

## 测试

```bash
# 1) 可控媒体对象的事件竞争单元测试（24 个，纯 Node，无浏览器）
npm test

# 2) 真实 Chromium + 原生 MediaRecorder 端到端（5 个）
#    摄像头由 tests/helpers/browser-fake-media.js 注入的“虚拟双摄像头”提供
#    （两个 canvas captureStream），可随时 unplug / mute / denyOnce
npm run test:e2e

npm run test:all
```

可控媒体对象（`tests/fake-media.js`）提供：假 `MediaDevices`（可拒绝/拔出/延迟）、
假轨道（`simulateMute()` / `simulateEnded()`）、**时序完全可控的假 `MediaRecorder`**
（`emitChunk()` / `fireStop()` 由测试决定何时到达，专门复现“停止后迟到块/onstop”竞争）、
假时钟（watchdog）和记录撤销动作的假 `URL`。

端到端覆盖：录制真实 WebM → 主设备热拔出 → 备机新片段接管 → 停止 →
两段独立可解码 WebM + 清单；手动切换三段两缺口；主备均失效时缺口保持打开；
mute 接管；`dispose` 撤销全部 ObjectURL；并断言全程**没有任何上传请求**。

## 同时留证
勾选双路同时留证后选择不同主备设备。两路独立生成片段，单路中断不影响另一侧；选择替换主路或备路后可重新打开该路设备。两路持有素材合并计算容量，会话覆盖时长按有素材的实际时间范围计算。释放一块已封口素材只释放该素材；两路封口后才能完成交付。
