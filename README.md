# sologsb101-1012 地震台阵仪器标定与布设台账

面向地震台阵建设与运维班组的纯前端单页应用：把台站布设、仪器安装与逐次标定结果写成可追溯的台账。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22812**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22812）。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18.3（函数组件 + Hooks） | 页面全部 `lazy` 懒加载并 `Suspense` 兜底 |
| 语言 | TypeScript 5.6（strict） | 构建脚本执行 `tsc --noEmit` 类型检查 |
| UI 组件 | Ant Design 5.22 + @ant-design/icons | 中文语言包，表格 / 表单 / Modal / 徽标 |
| 构建 | Vite 5 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Redux Toolkit 2 + react-redux 9 | `arraySlice` / `instrumentSlice` / `calibrationSlice` / `warehouseSlice`（装备库）/ `opsSlice`（台站班组） |
| 路由 | React Router 6（`createBrowserRouter`） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbseisarray`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/arrays` | 台阵与台站台账 | Array、Station、Instrument | 新建/编辑/删除台阵，按布设日期、运行状态与孔径分档筛选；卡片回显台站数、仪器数与标定合格率，可一键按经纬度重算孔径 |
| `/stations/:id/instruments` | 台站仪器登记与安装位置维护 | Station、Instrument | 新增/编辑/删除台站（经纬度范围校验 + 度分秒显示、基岩类型、高程），登记仪器（类型/型号/序列号**唯一性校验**/安装日期/状态），登记后自动生成下一次标定待办 |
| `/calibrations` | 标定记录台 | Calibration、Instrument | 录入灵敏度、自噪与脉冲响应结论（按类型区间自动初判）、灵敏度相对上次的变化、批量改结论、灵敏度趋势折线图 |
| `/replacements` | 合格评定与更换提醒 | Replace、Calibration、Instrument | 按 365 天标定周期评定，超期未标定与不合格仪器高亮（**已从安装位拆下的旧机不再挂超期名单**）；登记更换并推进状态机（待更换→已更换→已复核），流转到「已更换」时回写仪器序列号 |
| `/warehouse` | 装备库：备件库存与出库单 | SparePart、OutboundOrder | 备件按序列号入库；**出库单开好即锁序列号**（备件 在库→锁定）；确认领用（锁定→已出库）、确认退库（仅在班组撤回后可用，解锁回在库）；出库单不删除、不作废，退库以「已退库」留痕 |
| `/operations` | 台站运维班组：安装位与拆卸登记 | InstallRecord、OutboundOrder、SparePart | 待领用出库单一站「领用并安装」、直接登记安装（单号可留空）、拆卸登记（拆下即摘出超期名单）、**撤回领用只动台站侧**、**旧机回收失败只在本侧重试** |
| `/reconcile` | 序列号对账 | OutboundOrder、InstallRecord、MigrationIssue | 按序列号逐台核对，三类差异单列：**出了库没装上台站、装了又没出库、旧数据补号失败**；补号异常支持人工补单号解除 |
| `/geometry` | 台阵几何视图与结构版本 | 全部模型 | 实算孔径与台站间距、SVG 几何平面图与辐射距离、按台阵汇总标定结论、结构版本查看、全量 JSON 导入导出 |

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该台阵，页面渲染 `<RouteMissingPanel>` 友好空态（含「返回台阵台账」与可用 id 快捷跳转），不会白屏。

## 四、目录结构

```
sologsb101-1012/
├── README.md
├── docker-compose.yml          # name: gbseisarray，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx            # Provider + ConfigProvider + RouterProvider
        ├── App.tsx             # 侧边导航 + 顶部上下文条 + 页脚，并启动各表订阅
        ├── types/              # array / station / instrument / calibration / replace / spare / outbound / install / migration
        ├── stores/             # array / instrument / calibration / warehouse（装备库）/ ops（台站班组）
        ├── components/common/  # QualifyTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── hooks/              # useIdbTable / useCalibHistory / useReconcile
        ├── pages/              # ArrayList / StationInstruments / CalibrationBoard / ReplaceBoard
        │                        # WarehousePage（装备库）/ StationOpsPage（台站运维）/ ReconcilePage（序列号对账）/ GeometryView
        ├── router/index.tsx    # 路由表
        ├── styles/main.css
        └── utils/              # geo.ts / db.ts（Dexie 封装）/ reconcile.ts（序列号对账纯函数）/ export.ts（导入导出）
```

### 装备库与台站班组的分账规则（v3）

- **职责分开**：装备库（`/warehouse`，`warehouseSlice`）管备件库存（`spares`）与出库单（`outboundOrders`）；台站运维班组（`/operations`，`opsSlice`）管安装位与拆卸登记（`installs`）。两侧只按序列号对账（`/reconcile`，`utils/reconcile.ts`），不共享状态字段。
- **开单即锁**：出库单开立成功的同一事务内把备件 `在库 → 锁定` 并绑定单据；序列号一经开单必须留有去向，出库单不物理删除、不设作废动作，撤回领用的回退一律走「已退库」留痕，备件解锁放回在库。
- **撤回领用的顺序（本系统取舍：先撤领用、再由装备库解锁，不做装备库单方面作废）**：① 班组先在 `/operations` 对在位记录点「撤回领用」，只回退台站侧（安装位拆下、`withdrawn` 待退库），出库单与库存不动；② 装备库在 `/warehouse` 点「确认退库」时校验台站侧确已撤回，之后单据 `已领用 → 已退库`、序列号解锁。装备库越过撤回直接退库会被状态机拒绝。
- **序列号对账（三类单列）**：出了库没装上台站、装了又没出库、旧数据补号失败。撤回待退库是双方知情的流程中间态，不算差异。
- **旧机回收失败只重试台站侧**：拆卸登记「回收失败」后在 `/operations` 反复重试（累计次数与说明），装备库出库单始终保留「已领用」，不回退、不联动。
- **超期名单只认安装位**：更换提醒 / 标定评定结合 `installs` 中仍在位的序列号，已拆下旧机立即摘出超期名单。
- **升级迁移（v2 → v3）**：旧 `instruments` 流水拆成出库单 + 安装登记；旧数据无出库单号时按「台站码 + 安装日期」补号（`CK-BU-台站码-YYYYMMDD`）；缺台站码或安装日期补不出的，不造假单据，写入 `migrationIssues` 在对账页单列，可人工补单号解除。
- **验证脚本**：`npm run verify:bounded-context`（fake-indexeddb + 真实 slice/thunk）覆盖迁移补号、开单锁定、撤回顺序闸门、回收不回退、对账分类共 30+ 条断言。

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22812
npm run build       # 类型检查 + 生产构建
npm run preview     # 预览构建产物
npm run verify:bounded-context   # 装备库/台站分账规则的端到端断言（fake-indexeddb）
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbseisarray`，当前结构版本 `v3`。读写统一经 `frontend/src/utils/db.ts` 封装，页面组件不直接触碰 Dexie 实例。
- **数据表**：`arrays`（台阵）、`stations`（台站）、`instruments`（仪器）、`calibrations`（标定）、`replaces`（更换）、`spares`（装备库备件）、`outboundOrders`（出库单）、`installs`（台站安装位/拆卸登记）、`migrationIssues`（旧数据补号异常）。
- **升级迁移**：`db.version(1)` 保留初版结构；`version(2)` 补齐索引并回填历史字段；`version(3)` 把装备库与台站班组分账（备件 / 出库单 / 安装登记 / 补号异常），旧仪器流水按「台站码 + 安装日期」补出库单号，补不出的写入 `migrationIssues` 单列。调整字段结构时递增 `DB_VERSION` 并补迁移。
- **首屏播种**：`initDatabase()` 在 `arrays` 表为空时执行幂等播种，生成四层互相引用的演示数据（2 个台阵 / 5 个台站 / 8 台仪器 / 14 条标定 / 3 条更换），并刻意包含：1 次不合格标定（自噪超标）、2 台超期未标定仪器、3 条不同状态的更换记录；v3 追加装备库/台站分账样本：在库/锁定/已出库备件、出了库没装上、装了没出库、撤回领用待退库、回收失败只重试台站侧、补号失败异常各一例。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，`App.tsx` 挂载时启动订阅并把数据 dispatch 到 Redux slice，页面只读 selector。
- **业务规则**：标定周期 365 天（超期即在更换提醒页高亮，已从安装位拆下的旧机除外）；响应结论自动初判规则为「灵敏度落在类型区间内（宽频带 800~3000、短周期 100~800、强震 0.1~5）且自噪 ≤ 3.5」，最终以标定报告为准；仪器序列号全局唯一；更换状态机为 待更换 → 已更换 → 已复核，流转到「已更换」时把新序列号回写到仪器档案并置为在用；装备库开单即锁、退库须班组先撤回；旧机回收失败只重试台站侧、出库单不回退。
- **备份与恢复**：`/geometry` 页可导出包含九张表的 JSON 快照，支持「覆盖导入」与「追加导入（重新分配 id）」；旧版本备份缺少 v3 四表时按空表处理；备份时间写入 `localStorage`，页脚与几何页均展示结构版本号。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器或清空站点数据后数据不跟随，需通过 JSON 备份迁移。
